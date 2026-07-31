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

/**
 * Await a turn's terminal snapshot.
 *
 * The engine unrefs its timeout and watchdog timers (the server is kept alive
 * by stdin, not by them), so a test waiting on one has to hold the event loop
 * open itself.
 */
async function settled(engine, sessionId) {
  const keepAlive = setInterval(() => {}, 5);
  try {
    return await engine.result({ sessionId, wait: true });
  } finally {
    clearInterval(keepAlive);
  }
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
  const turn = await engine.submitStart({ prompt: "hello", cwd: "/repo" });
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

    const snap = await engine.result({ sessionId: turn.sessionId });
    assert.equal(snap.status, "succeeded");
    assert.equal(snap.output, "first");
    assert.equal(snap.finishedAt, settledAt);
    assert.equal(snap.sessionId, "s-1");
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
      await turn.donePromise;
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

  test("a resume re-keyed onto a busy session fails under the caller's id", async () => {
    // The CLI is free to answer a resume with another session's id. When that
    // id has a live turn the claim is rejected — and the failure must settle
    // under the id the caller used, or the caller's session is left pointing
    // at a turn record the settle path just deleted.
    const { engine, runners } = stalledEngine();

    const busy = engine.beginStart({ prompt: "hold the line", cwd: "/repo" });
    runners[0].init("taken");
    assert.equal(busy.status, "running");

    const reply = engine.beginReply({ sessionId: "mine", prompt: "resume" });
    runners[1].init("taken");

    assert.equal(reply.status, "failed");
    assert.match(reply.error.message, /already has an active turn/);
    assert.equal(reply.sessionId, "mine", "settled under the caller's id");

    // The caller's session still resolves to a real turn record…
    const snapshot = await engine.result({ sessionId: "mine" });
    assert.equal(snapshot.status, "failed");
    // …the busy session was left alone…
    assert.equal(busy.status, "running");
    // …and the caller's session is not wedged: it accepts the next reply.
    const retry = engine.beginReply({ sessionId: "mine", prompt: "again" });
    assert.equal(retry.status, "starting");
  });
});

describe("sessions", () => {
  test("a failed sync turn keeps the sessionId in its error", async () => {
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

    await engine.submitStart({ prompt: "hi", cwd: "/repo" });
    createRunner.created[0].result({ text: "ok" });
    await settled(engine, "s-1");

    await assert.rejects(
      () => engine.runReply({ sessionId: "s-1", prompt: "again" }),
      /^Error: boom \(sessionId: s-1 — use claude-reply\/claude-result to continue\)$/,
    );
  });

  test("a failed resume does not overwrite the session's recorded cwd", async () => {
    const createRunner = fakeRunners((runner, index) => {
      if (index === 0) runner.init("s-1");
      else if (index === 1) runner.done(); // resume failed: no init at all
      else runner.init("s-1");
    });
    const engine = createEngine({ createRunner, timeoutMs: 60_000 });

    await engine.submitStart({ prompt: "hi", cwd: "/repo/right" });
    createRunner.created[0].result({ text: "ok" });
    await settled(engine, "s-1");

    await engine.submitReply({
      sessionId: "s-1",
      prompt: "again",
      cwd: "/repo/wrong",
    });
    const failed = await settled(engine, "s-1");
    assert.equal(failed.status, "failed");

    // A later reply with no cwd must still resume from the cwd that worked.
    await engine.submitReply({ sessionId: "s-1", prompt: "once more" });
    assert.equal(createRunner.created[2].options.cwd, "/repo/right");
  });

  test("init adopting a different session id re-keys the session", async () => {
    const createRunner = fakeRunners((runner, index) =>
      runner.init(index === 0 ? "s-1" : "s-2"),
    );
    const engine = createEngine({ createRunner, timeoutMs: 60_000 });

    await engine.submitStart({ prompt: "hi", cwd: "/repo", writable: true });
    createRunner.created[0].result({ text: "ok" });
    await settled(engine, "s-1");

    const turn = await engine.submitReply({ sessionId: "s-1", prompt: "again" });
    assert.equal(turn.sessionId, "s-2", "the reported id is the live handle");
    createRunner.created[1].result({ text: "resumed" });

    const snap = await settled(engine, "s-2");
    assert.equal(snap.status, "succeeded");
    assert.equal(snap.sessionId, "s-2");
    await assert.rejects(
      () => engine.result({ sessionId: "s-1" }),
      /Unknown sessionId/,
    );
    // The re-keyed record is the original one: its permission level survives.
    assert.equal(createRunner.created[1].options.writable, true);
  });

  test("repeated replies do not grow the turn map", async () => {
    const createRunner = fakeRunners((runner) => runner.init("s-1"));
    const engine = createEngine({ createRunner, timeoutMs: 60_000 });

    await engine.submitStart({ prompt: "hi", cwd: "/repo" });
    createRunner.created[0].result({ text: "ok" });
    await settled(engine, "s-1");

    for (let i = 0; i < 5; i++) {
      await engine.submitReply({ sessionId: "s-1", prompt: `turn ${i}` });
      createRunner.created[i + 1].result({ text: `answer ${i}` });
      await settled(engine, "s-1");
    }

    assert.equal(engine._turns.size, 1, "only the latest turn is retained");
  });

  test("turns that settle before reaching a session are not retained", async () => {
    // All client-repeatable: an unbounded map is a denial of service.
    const { engine, turn, runners } = await startedEngine();

    await engine.submitStart({ prompt: "   " });
    await engine.submitReply({ prompt: "no session id" });
    await engine.submitReply({ sessionId: turn.sessionId, prompt: "collides" });
    assert.equal(engine._turns.size, 1, "only the live turn is retained");

    runners[0].result({ text: "ok" });
    await settled(engine, turn.sessionId);
  });

  test("shutdown settles live turns instead of leaving callers hanging", async () => {
    const { engine, turn, runners } = await startedEngine();
    const pending = assert.rejects(
      () => engine.runReply({ sessionId: turn.sessionId, prompt: "later" }),
      /already has an active turn/,
    );
    await engine.shutdown();

    assert.equal(runners[0].closed, true);
    const snap = await engine.result({ sessionId: turn.sessionId });
    assert.equal(snap.status, "failed");
    assert.equal(snap.error.source, "shutdown");
    await pending;
  });
});
