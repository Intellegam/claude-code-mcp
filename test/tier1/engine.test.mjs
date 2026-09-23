/**
 * In-process engine tests: no server, no child process, no sleeps beyond the
 * short timers the engine itself is configured with.
 *
 * `createEngine({ createRunner })` is the seam that makes this possible — every
 * SDK event is delivered by hand, so the terminal-state precedence rules in
 * DESIGN.md can be exercised one race at a time, including the branches that a
 * real CLI reaches only by accident.
 */

import test, { describe } from "node:test";
import assert from "node:assert/strict";
import { createRunnerFactory } from "../../lib/claude-runner.js";
import { createEngine } from "../../lib/engine.js";

/**
 * A runner whose events the test fires itself. `script(runner, index)` runs
 * once the engine has started the runner, and is where a turn is driven from.
 */
function fakeRunners(script) {
  const created = [];
  function createRunner(options) {
    const runner = {
      options,
      interrupts: 0,
      closed: false,
      stderr: "",
      events: null,
      start(prompt, events) {
        runner.prompt = prompt;
        runner.events = events;
        setImmediate(() => script?.(runner, created.indexOf(runner)));
      },
      interrupt() {
        runner.interrupts += 1;
      },
      async close() {
        runner.closed = true;
      },
      getStderr: () => runner.stderr,

      // --- event drivers ---
      init: (sessionId) => runner.events.onInit(sessionId),
      model: (model) => runner.events.onModel(model),
      text: (text) => runner.events.onText(text),
      result: (patch = {}) =>
        runner.events.onResult({
          subtype: "success",
          isError: false,
          terminalReason: null,
          text: "",
          errors: [],
          ...patch,
        }),
      done: (error = null) => runner.events.onDone(error, runner.stderr),
    };
    created.push(runner);
    return runner;
  }
  createRunner.created = created;
  return createRunner;
}

async function submitStart(engine, args) {
  const turn = engine.beginStart(args);
  await turn.readyPromise;
  return turn;
}

async function submitReply(engine, args) {
  const turn = engine.beginReply(args);
  await turn.readyPromise;
  return turn;
}

/**
 * Await a turn's terminal snapshot.
 *
 * The engine unrefs its timeout and watchdog timers (the server is kept alive
 * by stdin, not by them), so a test waiting on one has to hold the event loop
 * open itself.
 */
async function settled(engine, sessionId) {
  const deadline = Date.now() + 1_000;
  while (Date.now() < deadline) {
    const current = engine.result({ sessionId });
    if (current.done) return current;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`session ${sessionId} did not settle`);
}

/** An engine whose first turn is already initialized as `sessionId`. */
async function startedEngine(sessionId = "s-1", engineOptions = {}) {
  const createRunner = fakeRunners((runner) => runner.init(sessionId));
  const engine = createEngine({
    createRunner,
    timeoutMs: 60_000,
    cancelWatchdogMs: 60_000,
    ...engineOptions,
  });
  const turn = await submitStart(engine, { prompt: "hello", cwd: "/repo" });
  return { engine, turn, runners: createRunner.created };
}

describe("terminal-state precedence", () => {
  test("an observed result beats a later iterator throw", async () => {
    const { engine, turn, runners } = await startedEngine();
    runners[0].result({ text: "the answer" });
    runners[0].done(new Error("Claude Code returned an error result: [ede]"));

    const snap = await settled(engine, turn.sessionId);
    assert.equal(snap.status, "succeeded");
    assert.equal(snap.output, "the answer");
    assert.equal(snap.error, null);
  });

  test("a success result wins over a pending cancel", async () => {
    const { engine, turn, runners } = await startedEngine();
    engine.cancel({ sessionId: turn.sessionId });
    runners[0].result({ text: "finished anyway" });

    const snap = await settled(engine, turn.sessionId);
    assert.equal(snap.status, "succeeded");
    assert.equal(snap.cancelRequested, true);
    assert.equal(snap.output, "finished anyway");
  });

  test("a cancel plus an error result is cancelled, not failed", async () => {
    const { engine, turn, runners } = await startedEngine();
    engine.cancel({ sessionId: turn.sessionId });
    runners[0].result({
      isError: true,
      subtype: "error_during_execution",
      terminalReason: "aborted_streaming",
    });

    const snap = await settled(engine, turn.sessionId);
    assert.equal(snap.status, "cancelled");
    assert.equal(snap.error, null);
  });

  test("the same race under a turn timeout is timed_out", async () => {
    // A 1ms timeout is the cancel; the watchdog must not get there first.
    const { engine, turn, runners } = await startedEngine("s-1", {
      timeoutMs: 1,
      cancelWatchdogMs: 60_000,
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    runners[0].result({ isError: true, subtype: "error_during_execution" });

    const snap = await settled(engine, turn.sessionId);
    assert.equal(snap.status, "timed_out");
    assert.equal(snap.error.source, "timeout");
    assert.match(snap.error.message, /timed out/);
  });

  test("a stream that ends with no result fails, with a stderr excerpt", async () => {
    const { engine, turn, runners } = await startedEngine();
    runners[0].stderr = `${"noise ".repeat(400)}the last words`;
    runners[0].done();

    const snap = await settled(engine, turn.sessionId);
    assert.equal(snap.status, "failed");
    assert.equal(snap.error.source, "sdk");
    assert.match(snap.error.message, /Claude exited without producing a result/);
    assert.match(snap.error.message, /stderr: \.\.\./, "excerpt is elided");
    assert.match(snap.error.message, /the last words$/, "the tail is kept");
    const excerpt = snap.error.message.split("stderr: ")[1];
    assert.equal(excerpt.length, 600 + 3, "600 chars plus the ellipsis");
  });

  test("a pending cancel wins when the stream ends with no result", async () => {
    // The branch a real CLI only reaches when the child dies mid-interrupt.
    const { engine, turn, runners } = await startedEngine();
    engine.cancel({ sessionId: turn.sessionId });
    runners[0].done();

    const snap = await settled(engine, turn.sessionId);
    assert.equal(snap.status, "cancelled");
    assert.equal(snap.error, null, "a cancel is not a failure");
  });

  test("an ignored interrupt is force-settled by the watchdog", async () => {
    const { engine, turn, runners } = await startedEngine("s-1", {
      cancelWatchdogMs: 20,
    });
    engine.cancel({ sessionId: turn.sessionId });

    const snap = await settled(engine, turn.sessionId);
    assert.equal(snap.status, "cancelled");
    assert.equal(snap.error.source, "cancel");
    assert.match(snap.error.message, /did not respond to interrupt/);
    assert.equal(runners[0].interrupts, 1);
    assert.equal(runners[0].closed, true, "the force path reaps the child");
  });

  test("a turn timeout that overtakes a user cancel settles as timed_out", async () => {
    const { engine, turn } = await startedEngine("s-1", {
      timeoutMs: 10,
      cancelWatchdogMs: 120,
    });
    engine.cancel({ sessionId: turn.sessionId }); // arms the 120ms watchdog

    const snap = await settled(engine, turn.sessionId);
    assert.equal(snap.status, "timed_out", "the harder bound wins");
    assert.equal(snap.error.source, "timeout");
  });

  test("events after a terminal state are ignored", async () => {
    const { engine, turn, runners } = await startedEngine();
    runners[0].result({ text: "first" });
    const settledAt = (await engine.result({ sessionId: turn.sessionId }))
      .finishedAt;

    runners[0].result({ isError: true, text: "second" });
    runners[0].done(new Error("late explosion"));
    runners[0].init("s-hijack");
    runners[0].model("model-hijack");

    const snap = await engine.result({ sessionId: turn.sessionId });
    assert.equal(snap.status, "succeeded");
    assert.equal(snap.output, "first");
    assert.equal(snap.finishedAt, settledAt);
    assert.equal(snap.sessionId, "s-1");
    assert.equal(snap.model, null, "a settled turn's model cannot be rewritten");
  });
});

describe("cancelling a turn that has not initialized", () => {
  /** An engine whose runner never emits `system/init`. */
  function stalledEngine(engineOptions = {}) {
    const createRunner = fakeRunners(() => {}); // no init, no result, ever
    const engine = createEngine({
      createRunner,
      timeoutMs: 60_000,
      cancelWatchdogMs: 20,
      ...engineOptions,
    });
    return { engine, runners: createRunner.created };
  }

  test("beginStart hands back the turn before init", () => {
    const { engine, runners } = stalledEngine();
    const turn = engine.beginStart({ prompt: "hello", cwd: "/repo" });

    assert.equal(turn.sessionId, null, "no session until system/init");
    assert.equal(turn.status, "starting");
    assert.equal(runners.length, 1, "the runner is already started");
  });

  test("cancelTurn reaches a turn no sessionId could find", async () => {
    // The MCP layer's case: a client cancels its request while the child is
    // still starting up. `cancel({sessionId})` has nothing to look up, so
    // without a turn-reference cancel the turn would run to its full timeout.
    const { engine, runners } = stalledEngine();
    const turn = engine.beginStart({ prompt: "hello", cwd: "/repo" });

    engine.cancelTurn(turn);
    assert.equal(turn.cancelRequested, true);
    assert.equal(turn.status, "cancelling");
    assert.equal(runners[0].interrupts, 1);

    // The interrupt is buffered until init that never comes; the watchdog is
    // what bounds the wait.
    const keepAlive = setInterval(() => {}, 5);
    try {
      await turn.readyPromise;
    } finally {
      clearInterval(keepAlive);
    }
    assert.equal(turn.status, "cancelled");
    assert.equal(runners[0].closed, true, "the force path reaps the child");
  });

  test("cancelTurn without a turn is a no-op", () => {
    const { engine } = stalledEngine();
    assert.equal(engine.cancelTurn(null), null);
    assert.equal(engine.cancelTurn(undefined), null);
  });

  test("beginReply is the same, and still claims the session", () => {
    const { engine } = stalledEngine();
    const turn = engine.beginReply({ sessionId: "s-1", prompt: "again" });

    assert.equal(turn.sessionId, "s-1");
    engine.cancelTurn(turn);
    assert.equal(turn.cancelRequested, true);
  });

  test("a reply that reports another id fails under the stable id", async () => {
    const { engine, runners } = stalledEngine();
    const reply = engine.beginReply({ sessionId: "mine", prompt: "resume" });
    runners[0].init("different");

    assert.equal(reply.status, "failed");
    assert.match(reply.error.message, /refusing to change the public sessionId/);
    assert.equal(reply.sessionId, "mine", "settled under the caller's id");

    const snapshot = await engine.result({ sessionId: "mine" });
    assert.equal(snapshot.status, "failed");
    const retry = engine.beginReply({ sessionId: "mine", prompt: "again" });
    assert.equal(retry.status, "starting");
  });

  test("an initialization timeout settles and closes immediately", async () => {
    const { engine, runners } = stalledEngine();
    const turn = engine.beginStart({ prompt: "hello", cwd: "/repo" });

    assert.equal(
      engine.failBeforeInitialization(turn, "init deadline"),
      true,
    );
    await Promise.resolve();

    assert.equal(turn.status, "failed");
    assert.equal(turn.error.source, "init_timeout");
    assert.equal(runners[0].closed, true);
    assert.equal(engine._liveTurns.size, 0, "no unreachable turn is retained");
  });
});

describe("sessions", () => {
  test("a pre-init reply owns the session until settled, including after collisions", async () => {
    const createRunner = fakeRunners();
    const engine = createEngine({ createRunner, timeoutMs: 60_000 });
    try {
      const first = engine.beginReply({ sessionId: "s-1", prompt: "resume" });
      const rejected = engine.beginReply({ sessionId: "s-1", prompt: "overlap" });
      assert.equal(rejected.status, "failed");
      assert.equal(createRunner.created.length, 1);
      assert.deepEqual(
        engine.result({ sessionId: "s-1" }),
        engine.snapshotForSubmission(first),
      );

      // A newly started CLI reporting the same native id must not steal it.
      const collision = engine.beginStart({ prompt: "new", writable: true });
      createRunner.created[1].init("s-1");
      assert.equal(collision.status, "failed");
      assert.equal(engine.result({ sessionId: "s-1" }).status, "starting");
      engine.failBeforeInitialization(first, "startup failed");

      const retry = engine.beginReply({ sessionId: "s-1", prompt: "retry" });
      assert.equal(
        createRunner.created[2].options.writable,
        false,
        "a colliding writable start must not escalate the existing session",
      );
      createRunner.created[0].done(new Error("late old runner event"));
      engine.cancel({ sessionId: "s-1" });
      assert.equal(retry.cancelRequested, true);
      assert.equal(createRunner.created[2].interrupts, 1);
      assert.equal(engine._liveTurns.size, 1);
    } finally {
      await engine.shutdown();
    }
  });

  test("a failed reply stays observable under the stable session id", async () => {
    const createRunner = fakeRunners((runner, index) => {
      runner.init("s-1");
      if (index === 1) {
        runner.result({
          isError: true,
          subtype: "error_during_execution",
          errors: ["boom"],
        });
      }
    });
    const engine = createEngine({ createRunner, timeoutMs: 60_000 });

    await submitStart(engine, { prompt: "hi", cwd: "/repo" });
    createRunner.created[0].result({ text: "ok" });
    await settled(engine, "s-1");

    const reply = await submitReply(engine, { sessionId: "s-1", prompt: "again" });
    const failed = await settled(engine, reply.sessionId);
    assert.equal(failed.status, "failed");
    assert.equal(failed.sessionId, "s-1");
    assert.match(failed.error.message, /boom/);
  });

  test("a known session refuses the wrong cwd and keeps its recorded cwd", async () => {
    const createRunner = fakeRunners((runner) => runner.init("s-1"));
    const engine = createEngine({ createRunner, timeoutMs: 60_000 });

    await submitStart(engine, { prompt: "hi", cwd: "/repo/right" });
    createRunner.created[0].result({ text: "ok" });
    await settled(engine, "s-1");

    const rejected = await submitReply(engine, {
      sessionId: "s-1",
      prompt: "again",
      cwd: "/repo/wrong",
    });
    assert.equal(rejected.status, "failed");
    assert.match(rejected.error.message, /same cwd/);
    assert.equal(createRunner.created.length, 1, "no CLI child was spawned");

    // A later reply with no cwd must still resume from the cwd that worked.
    await submitReply(engine, { sessionId: "s-1", prompt: "once more" });
    assert.equal(createRunner.created[1].options.cwd, "/repo/right");
  });

  test("initialization requires a non-empty native session id", async () => {
    const createRunner = fakeRunners((runner) => runner.init(""));
    const engine = createEngine({ createRunner, timeoutMs: 60_000 });

    const turn = await submitStart(engine, { prompt: "hi", cwd: "/repo" });
    assert.equal(turn.status, "failed");
    assert.equal(turn.sessionId, null);
    assert.match(turn.error.message, /without a sessionId/);
    assert.equal(engine._liveTurns.size, 0);
  });

  test("completed replies leave the live set but keep the latest result", async () => {
    const createRunner = fakeRunners((runner) => runner.init("s-1"));
    const engine = createEngine({ createRunner, timeoutMs: 60_000 });

    await submitStart(engine, { prompt: "hi", cwd: "/repo" });
    createRunner.created[0].result({ text: "ok" });
    await settled(engine, "s-1");

    for (let i = 0; i < 5; i++) {
      await submitReply(engine, { sessionId: "s-1", prompt: `turn ${i}` });
      createRunner.created[i + 1].result({ text: `answer ${i}` });
      await settled(engine, "s-1");
    }

    assert.equal(engine._liveTurns.size, 0, "no completed turn remains live");
    assert.equal(engine.result({ sessionId: "s-1" }).output, "answer 4");
  });

  test("turns that settle before reaching a session are not retained", async () => {
    // Invalid submissions must not accumulate in the live-turn registry.
    const { engine, turn, runners } = await startedEngine();

    await submitStart(engine, { prompt: "   " });
    await submitReply(engine, { prompt: "no session id" });
    await submitReply(engine, { sessionId: turn.sessionId, prompt: "collides" });
    assert.equal(engine._liveTurns.size, 1, "only the live turn is retained");

    runners[0].result({ text: "ok" });
    await settled(engine, turn.sessionId);
  });

  test("shutdown settles live turns instead of leaving callers hanging", async () => {
    const { engine, turn, runners } = await startedEngine();
    const rejected = await submitReply(engine, {
      sessionId: turn.sessionId,
      prompt: "later",
    });
    assert.equal(rejected.status, "failed");
    assert.match(rejected.error.message, /already has an active turn/);
    await engine.shutdown();

    assert.equal(runners[0].closed, true);
    const snap = await engine.result({ sessionId: turn.sessionId });
    assert.equal(snap.status, "failed");
    assert.equal(snap.error.source, "shutdown");
  });

  test(
    "shutdown does not wait for a stuck resume metadata lookup",
    { timeout: 1000 },
    async () => {
      let queries = 0;
      const createRunner = createRunnerFactory({
        getSessionInfo: () => new Promise(() => {}),
        query: () => {
          queries += 1;
          throw new Error("query must not start while metadata is pending");
        },
      });
      const engine = createEngine({ createRunner, timeoutMs: 60_000 });
      const turn = engine.beginReply({
        sessionId: "unknown-session",
        prompt: "continue",
        cwd: "/repo",
      });

      await engine.shutdown();

      assert.equal(turn.status, "failed");
      assert.equal(turn.error.source, "shutdown");
      assert.equal(queries, 0);
    },
  );
});

describe("model reporting", () => {
  test("the reported model follows the CLI's announcements, per turn", async () => {
    const createRunner = fakeRunners((runner, index) => {
      runner.model(index === 0 ? "model-old" : "model-new");
      runner.init("s-1");
    });
    const engine = createEngine({ createRunner, timeoutMs: 60_000 });

    // Turn 1: a mid-turn fallback overrides what init resolved.
    await submitStart(engine, { prompt: "hi", cwd: "/repo" });
    createRunner.created[0].model("model-fallback");
    createRunner.created[0].result({ text: "ok" });
    assert.equal((await settled(engine, "s-1")).model, "model-fallback");

    // Turn 2: a fresh turn reports its own announcement, not its predecessor's.
    await submitReply(engine, { sessionId: "s-1", prompt: "again" });
    createRunner.created[1].result({ text: "resumed" });
    assert.equal((await settled(engine, "s-1")).model, "model-new");
  });

  test("a turn that failed after init still reports its model", async () => {
    const createRunner = fakeRunners((runner) => {
      runner.model("claude-test-model");
      runner.init("s-1");
    });
    const engine = createEngine({ createRunner, timeoutMs: 60_000 });

    await submitStart(engine, { prompt: "hi", cwd: "/repo" });
    createRunner.created[0].result({
      isError: true,
      subtype: "error_during_execution",
      errors: ["boom"],
    });
    const snap = await settled(engine, "s-1");
    assert.equal(snap.status, "failed");
    assert.equal(snap.model, "claude-test-model");
  });
});

test("passive diagnostics keep the latest input, freeze on settlement, and reset on reply", async () => {
  const { engine, turn, runners } = await startedEngine();
  const initial = engine.result({ sessionId: turn.sessionId });
  assert.equal(initial.contextTokens, null);
  assert.equal(initial.compactedThisTurn, false);
  runners[0].events.onUsage({ contextTokens: 80_000 });
  runners[0].events.onCompact();
  runners[0].events.onUsage({ contextTokens: 10_000 });
  runners[0].result({ text: "answer" });
  const snap = await settled(engine, turn.sessionId);
  assert.equal(snap.contextTokens, 10_000);
  assert.equal(snap.compactedThisTurn, true);

  await submitReply(engine, { sessionId: turn.sessionId, prompt: "continue" });
  runners[0].events.onUsage({ contextTokens: 999 });
  runners[0].events.onCompact();
  assert.deepEqual(engine.snapshotForSubmission(turn), snap);
  const reply = engine.result({ sessionId: turn.sessionId });
  assert.equal(reply.contextTokens, null);
  assert.equal(reply.compactedThisTurn, false);
  runners[1].result({ text: "continued" });
  await settled(engine, turn.sessionId);
  runners[1].events.onUsage({ contextTokens: 999 });
  runners[1].events.onCompact();
  assert.equal(engine.result({ sessionId: turn.sessionId }).contextTokens, null);
  assert.equal(engine.result({ sessionId: turn.sessionId }).compactedThisTurn, false);
  await engine.shutdown();
});

describe("model family selection", () => {
  test("each family passes through; omission leaves the operator default alone", async () => {
    for (const model of [undefined, "fable", "opus", "sonnet", "haiku"]) {
      const createRunner = fakeRunners((runner) => {
        runner.init("s-model");
        runner.result();
      });
      const engine = createEngine({ createRunner });
      await submitStart(engine, { prompt: "hello", model });
      assert.equal(createRunner.created[0].options.model, model);
      assert.equal(engine.result({ sessionId: "s-model" }).model, null);
    }
  });

  test("replies inherit the requested family, not a fallback's observed model", async () => {
    const createRunner = fakeRunners((runner) => {
      runner.model("observed-fallback-model");
      runner.init("s-model");
      runner.result();
    });
    const engine = createEngine({ createRunner });
    await submitStart(engine, { prompt: "plan", model: "fable" });
    await submitReply(engine, { sessionId: "s-model", prompt: "continue" });
    await submitReply(engine, { sessionId: "s-model", prompt: "switch", model: "opus" });
    await submitReply(engine, { sessionId: "s-model", prompt: "continue" });
    assert.deepEqual(createRunner.created.map((r) => r.options.model),
      ["fable", "fable", "opus", "opus"]);
    assert.equal(engine.result({ sessionId: "s-model" }).model, "observed-fallback-model");
  });

  test("invalid models fail before creating a runner or replacing the session", async () => {
    const createRunner = fakeRunners((runner) => {
      runner.init("s-model");
      runner.result();
    });
    const engine = createEngine({ createRunner });
    await submitStart(engine, { prompt: "hello", model: "opus" });
    const original = engine.result({ sessionId: "s-model" });
    for (const model of [null, "", "Opus", "opusplan", "best", "claude-opus-5-5", 42, {}, ["opus"]]) {
      for (const submit of [submitStart, submitReply]) {
        const turn = await submit(engine, { sessionId: "s-model", prompt: "hello", model });
        assert.equal(turn.status, "failed");
        assert.match(turn.error.message, /model must be one of/);
      }
    }
    assert.equal(createRunner.created.length, 1);
    assert.deepEqual(engine.result({ sessionId: "s-model" }), original);
  });

  test("failed initialization cannot change the remembered family", async () => {
    const createRunner = fakeRunners((runner, index) => {
      if (index === 1) return runner.done(new Error("startup failed"));
      if (index === 2) return runner.init("wrong-session");
      runner.init("s-model");
      runner.result();
    });
    const engine = createEngine({ createRunner });
    await submitStart(engine, { prompt: "hello", model: "fable" });
    for (let i = 0; i < 2; i++) {
      const failed = await submitReply(engine, { sessionId: "s-model", prompt: "switch", model: "opus" });
      assert.equal(failed.status, "failed");
    }
    await submitReply(engine, { sessionId: "s-model", prompt: "continue" });
    assert.equal(createRunner.created[3].options.model, "fable");
  });

  test("an overlapping reply cannot change the remembered family", async () => {
    const createRunner = fakeRunners((runner) => runner.init("s-model"));
    const engine = createEngine({ createRunner });
    await submitStart(engine, { prompt: "hello", model: "fable" });
    const rejected = await submitReply(engine, { sessionId: "s-model", prompt: "switch", model: "opus" });
    assert.equal(rejected.status, "failed");
    assert.equal(createRunner.created.length, 1);
    createRunner.created[0].result();
    await submitReply(engine, { sessionId: "s-model", prompt: "continue" });
    assert.equal(createRunner.created[1].options.model, "fable");
    createRunner.created[1].result();
  });

  test("unknown sessions accept an explicit family without granting write access", async () => {
    for (const model of [undefined, "opus"]) {
      const createRunner = fakeRunners((runner) => {
        runner.init("s-model");
        runner.result();
      });
      const engine = createEngine({ createRunner });
      await submitReply(engine, { sessionId: "s-model", prompt: "resume", model, writable: true });
      const options = createRunner.created[0].options;
      assert.equal(options.model, model);
      assert.equal(options.writable, false);
      assert.equal(options.verifyResumeCwd, true);
      await submitReply(engine, { sessionId: "s-model", prompt: "continue" });
      assert.equal(createRunner.created[1].options.model, model);
    }
  });
});
