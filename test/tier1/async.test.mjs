import test, { after, describe } from "node:test";
import assert from "node:assert/strict";
import {
  pollUntil,
  sessionIdFrom,
  sleep,
  snapshot,
  spawnServer,
} from "../helpers/harness.mjs";

function interruptReport(output) {
  const match = /interrupt-report:(\{.*?\})/.exec(output ?? "");
  if (!match) throw new Error(`no interrupt report in output: ${output}`);
  return JSON.parse(match[1]);
}

describe("async submissions", () => {
  const server = spawnServer();
  after(() => server.close());

  test("start, poll, and collect the result", async () => {
    await server.init();
    const submitted = snapshot(
      await server.call("claude", { prompt: "#work=150 async hello", async: true }),
    );

    assert.ok(submitted.sessionId, "sessionId available immediately");
    assert.equal(submitted.toolName, "claude");
    assert.equal(submitted.done, false);
    assert.equal(submitted.status, "running");
    assert.equal(submitted.output, "");
    assert.equal(submitted.cancelRequested, false);
    assert.equal(submitted.error, null);
    assert.equal(submitted.finishedAt, null);
    assert.match(submitted.createdAt, /^\d{4}-\d{2}-\d{2}T/);
    assert.match(submitted.elapsed, /\(running\)$/);

    const final = snapshot(
      await server.call("claude-result", {
        sessionId: submitted.sessionId,
        wait: true,
      }),
    );
    assert.equal(final.status, "succeeded");
    assert.equal(final.done, true);
    assert.equal(final.sessionId, submitted.sessionId);
    assert.match(final.output, /Mock response to: async hello/);
    assert.equal(final.error, null);
    assert.match(final.finishedAt, /^\d{4}-\d{2}-\d{2}T/);
    assert.match(final.elapsed, /^\d+s$/);
  });

  test("claude-result without wait returns immediately", async () => {
    const submitted = snapshot(
      await server.call("claude", { prompt: "#work=4000 slow", async: true }),
    );
    const before = Date.now();
    const current = snapshot(
      await server.call("claude-result", { sessionId: submitted.sessionId }),
    );
    assert.ok(Date.now() - before < 1500, "a round trip, not the turn");
    assert.equal(current.done, false);
    assert.equal(current.status, "running");

    await server.call("claude-cancel", { sessionId: submitted.sessionId });
    await server.call("claude-result", {
      sessionId: submitted.sessionId,
      wait: true,
    });
  });

  test("cancel while running yields cancelled with one interrupt", async () => {
    const submitted = snapshot(
      await server.call("claude", { prompt: "#work=5000 cancel me", async: true }),
    );
    await pollUntil(server, submitted.sessionId, (s) => s.status === "running");

    const cancelled = snapshot(
      await server.call("claude-cancel", { sessionId: submitted.sessionId }),
    );
    assert.equal(cancelled.cancelRequested, true);

    const final = snapshot(
      await server.call("claude-result", {
        sessionId: submitted.sessionId,
        wait: true,
      }),
    );
    assert.equal(final.status, "cancelled");
    assert.equal(final.done, true);
    assert.equal(final.cancelRequested, true);
    assert.equal(final.error, null);
    assert.deepEqual(interruptReport(final.output), {
      interrupts: 1,
      preInitInterrupts: 0,
    });
  });

  test("a cancel arriving before init is buffered and delivered once", async () => {
    const first = await server.call("claude", { prompt: "seed" });
    const sessionId = sessionIdFrom(first);

    // The reply's session id is known up front, so a cancel can beat init.
    // Deliberately not awaited: `call()` has already written the request.
    const pending = server.call("claude-reply", {
      sessionId,
      prompt: "#init=800 #work=5000 slow reply",
      async: true,
    });
    await sleep(50);
    // Assert the precondition: without it a slow machine silently degrades this
    // into a post-init cancel, and the buffering path goes untested.
    const before = snapshot(await server.call("claude-result", { sessionId }));
    assert.equal(before.status, "starting", "the turn has not initialized yet");

    const cancelled = snapshot(
      await server.call("claude-cancel", { sessionId }),
    );
    assert.equal(cancelled.cancelRequested, true);
    assert.equal(cancelled.status, "cancelling");
    await pending;

    const started = Date.now();
    const final = snapshot(
      await server.call("claude-result", { sessionId, wait: true }),
    );
    assert.equal(final.status, "cancelled");
    assert.ok(Date.now() - started < 4000, "cancelled well before the 5s turn");
    assert.deepEqual(interruptReport(final.output), {
      interrupts: 1,
      preInitInterrupts: 0,
    });
  });

  test("cancel after completion is a no-op", async () => {
    const submitted = snapshot(
      await server.call("claude", { prompt: "fast", async: true }),
    );
    await server.call("claude-result", {
      sessionId: submitted.sessionId,
      wait: true,
    });
    const cancelled = snapshot(
      await server.call("claude-cancel", { sessionId: submitted.sessionId }),
    );
    assert.equal(cancelled.status, "succeeded");
    assert.equal(cancelled.cancelRequested, false);
  });

  test("one active turn per session", async () => {
    const submitted = snapshot(
      await server.call("claude", { prompt: "#work=5000 first", async: true }),
    );
    await pollUntil(server, submitted.sessionId, (s) => s.status === "running");

    const rejected = snapshot(
      await server.call("claude-reply", {
        sessionId: submitted.sessionId,
        prompt: "second",
        async: true,
      }),
    );
    assert.equal(rejected.status, "failed");
    assert.equal(rejected.done, true);
    assert.equal(rejected.error.source, "setup");
    assert.match(rejected.error.message, /already has an active turn/);

    // The running turn is untouched and still observable.
    const running = snapshot(
      await server.call("claude-result", { sessionId: submitted.sessionId }),
    );
    assert.equal(running.done, false);

    await server.call("claude-cancel", { sessionId: submitted.sessionId });
    await server.call("claude-result", {
      sessionId: submitted.sessionId,
      wait: true,
    });
  });

  test("invalid async args return a failed snapshot, not a protocol error", async () => {
    const snap = snapshot(await server.call("claude", { async: true }));
    assert.equal(snap.toolName, "claude");
    assert.equal(snap.status, "failed");
    assert.equal(snap.done, true);
    assert.equal(snap.sessionId, null);
    assert.equal(snap.error.source, "setup");
    assert.match(snap.error.message, /non-empty prompt/);
  });

  test("unknown session ids are rejected", async () => {
    const result = await server.call("claude-result", { sessionId: "nope" });
    assert.match(result.error.message, /Unknown sessionId/);
    const cancel = await server.call("claude-cancel", { sessionId: "nope" });
    assert.match(cancel.error.message, /Unknown sessionId/);
  });

  test("claude-result(wait) answers about the turn it observed", async () => {
    const submitted = snapshot(
      await server.call("claude", { prompt: "seed", async: true }),
    );
    const { sessionId } = submitted;
    await server.call("claude-result", { sessionId, wait: true });

    // Both requests are dispatched before either can await, so the reply
    // attaches a *new* turn while the wait is in flight. The wait was asked
    // about the finished turn and must answer about that one.
    const [waited, replied] = await Promise.all(
      server.callInOneChunk([
        { name: "claude-result", args: { sessionId, wait: true } },
        {
          name: "claude-reply",
          args: { sessionId, prompt: "#work=300 follow-up", async: true },
        },
      ]),
    );
    const observed = snapshot(waited);
    assert.equal(observed.done, true, "the finished turn is still done");
    assert.equal(observed.status, "succeeded");
    assert.equal(snapshot(replied).done, false, "the reply really did start");

    await server.call("claude-result", { sessionId, wait: true });
  });

  test("sessions run in parallel without interfering", async () => {
    const a = snapshot(
      await server.call("claude", { prompt: "#work=200 alpha", async: true }),
    );
    const b = snapshot(
      await server.call("claude", { prompt: "#work=200 beta", async: true }),
    );
    assert.notEqual(a.sessionId, b.sessionId);

    const [finalA, finalB] = await Promise.all([
      server
        .call("claude-result", { sessionId: a.sessionId, wait: true })
        .then(snapshot),
      server
        .call("claude-result", { sessionId: b.sessionId, wait: true })
        .then(snapshot),
    ]);
    assert.match(finalA.output, /alpha/);
    assert.match(finalB.output, /beta/);
  });
});

describe("the turn timeout", () => {
  const server = spawnServer({
    env: { CLAUDE_TIMEOUT_MS: "400", CLAUDE_CANCEL_WATCHDOG_MS: "800" },
  });
  after(() => server.close());

  test("a turn past its timeout becomes timed_out", async () => {
    await server.init();
    const submitted = snapshot(
      await server.call("claude", { prompt: "#work=9000 slow", async: true }),
    );
    const final = snapshot(
      await server.call("claude-result", {
        sessionId: submitted.sessionId,
        wait: true,
      }),
    );
    assert.equal(final.status, "timed_out");
    assert.equal(final.done, true);
    assert.equal(final.cancelRequested, true);
    assert.match(final.error.message, /timed out/);
    assert.equal(final.error.source, "timeout");
  });
});
