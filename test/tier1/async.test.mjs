import test, { after, describe } from "node:test";
import assert from "node:assert/strict";
import {
  pollUntil,
  sleep,
  snapshot,
  spawnServer,
  toolError,
} from "../helpers/harness.mjs";

function interruptReport(output) {
  const match = /interrupt-report:(\{.*?\})/.exec(output ?? "");
  if (!match) throw new Error(`no interrupt report in output: ${output}`);
  return JSON.parse(match[1]);
}

describe("asynchronous session API", () => {
  const server = spawnServer();
  after(() => server.close());

  test("submission waits for init, then returns the stable native session id", async () => {
    await server.init();
    const started = Date.now();
    const submitted = snapshot(
      await server.call("claude", {
        prompt: "#init=250 #work=2000 first turn",
      }),
    );

    assert.ok(Date.now() - started >= 200, "the call waited for system/init");
    assert.ok(Date.now() - started < 1500, "the call did not wait for the answer");
    assert.match(submitted.sessionId, /^mock-/);
    assert.equal(submitted.status, "running");
    assert.equal(submitted.done, false);

    const first = await pollUntil(server, submitted.sessionId, (state) => state.done);
    assert.equal(first.status, "succeeded");
    assert.match(first.output, /first turn/);

    const reply = snapshot(
      await server.call("claude-reply", {
        sessionId: submitted.sessionId,
        prompt: "#work=300 follow-up",
      }),
    );
    assert.equal(reply.sessionId, submitted.sessionId);
    assert.equal(reply.status, "running");

    const final = await pollUntil(server, submitted.sessionId, (state) => state.done);
    assert.equal(final.sessionId, submitted.sessionId);
    assert.match(final.output, /follow-up/);
  });

  test("startup failures return a terminal error instead of a session handle", async () => {
    const failed = await server.call("claude", {
      prompt: "#noinit cannot start",
    });
    assert.match(toolError(failed), /error_during_execution/);
  });

  test("a stuck initialization returns a bounded actionable error", async () => {
    const bounded = spawnServer({
      env: {
        CLAUDE_INIT_TIMEOUT_MS: "100",
        CLAUDE_CANCEL_WATCHDOG_MS: "100",
      },
    });
    await bounded.init();
    const started = Date.now();
    try {
      const failed = await bounded.call("claude", {
        prompt: "#init=6000 never ready",
      });
      assert.match(toolError(failed), /did not initialize within 100ms/);
      assert.ok(Date.now() - started < 1000, "the MCP request was bounded");
      assert.deepEqual((await bounded.request("ping")).result, {});

      const seed = snapshot(await bounded.call("claude", { prompt: "seed" }));
      await pollUntil(bounded, seed.sessionId, (state) => state.done);
      const replyFailure = await bounded.call("claude-reply", {
        sessionId: seed.sessionId,
        prompt: "#init=6000 stalled reply",
      });
      assert.match(toolError(replyFailure), /did not initialize within 100ms/);

      const retry = snapshot(
        await bounded.call("claude-reply", {
          sessionId: seed.sessionId,
          prompt: "retry immediately",
        }),
      );
      assert.equal(retry.sessionId, seed.sessionId);
      assert.equal(
        (await pollUntil(bounded, seed.sessionId, (state) => state.done)).status,
        "succeeded",
      );
    } finally {
      await bounded.close();
    }
  });

  test("every terminal pre-init outcome is a tool error", async () => {
    const bounded = spawnServer({
      env: {
        CLAUDE_TIMEOUT_MS: "50",
        CLAUDE_CANCEL_WATCHDOG_MS: "50",
        CLAUDE_INIT_TIMEOUT_MS: "500",
      },
    });
    await bounded.init();
    try {
      const failed = await bounded.call("claude", {
        prompt: "#init=6000 turn deadline first",
      });
      assert.match(toolError(failed), /timed out/);
    } finally {
      await bounded.close();
    }
  });

  test("claude-result always returns the current state immediately", async () => {
    const submitted = snapshot(
      await server.call("claude", { prompt: "#work=5000 slow" }),
    );
    const started = Date.now();
    const current = snapshot(
      await server.call("claude-result", { sessionId: submitted.sessionId }),
    );
    assert.ok(Date.now() - started < 500, "result did not wait for the turn");
    assert.equal(current.status, "running");
    assert.equal(current.done, false);

    await server.call("claude-cancel", { sessionId: submitted.sessionId });
    await pollUntil(server, submitted.sessionId, (state) => state.done);
  });

  test("runtime failure is reported through the same session", async () => {
    const submitted = snapshot(
      await server.call("claude", { prompt: "#work=100 #error boom" }),
    );
    const final = await pollUntil(server, submitted.sessionId, (state) => state.done);
    assert.equal(final.status, "failed");
    assert.equal(final.sessionId, submitted.sessionId);
    assert.match(final.error.message, /mock failure/);
  });

  test("cancelling a running turn preserves the stable session id", async () => {
    const submitted = snapshot(
      await server.call("claude", { prompt: "#work=5000 cancel me" }),
    );
    const cancelling = snapshot(
      await server.call("claude-cancel", { sessionId: submitted.sessionId }),
    );
    assert.equal(cancelling.sessionId, submitted.sessionId);
    assert.equal(cancelling.cancelRequested, true);

    const final = await pollUntil(server, submitted.sessionId, (state) => state.done);
    assert.equal(final.status, "cancelled");
    assert.deepEqual(interruptReport(final.output), {
      interrupts: 1,
      preInitInterrupts: 0,
    });
  });

  test("one active turn per session is enforced", async () => {
    const seed = snapshot(await server.call("claude", { prompt: "seed" }));
    await pollUntil(server, seed.sessionId, (state) => state.done);

    const active = snapshot(
      await server.call("claude-reply", {
        sessionId: seed.sessionId,
        prompt: "#work=5000 first reply",
      }),
    );
    assert.equal(active.status, "running");

    const rejected = await server.call("claude-reply", {
      sessionId: seed.sessionId,
      prompt: "second reply",
    });
    assert.match(toolError(rejected), /already has an active turn/);

    await server.call("claude-cancel", { sessionId: seed.sessionId });
    await pollUntil(server, seed.sessionId, (state) => state.done);
  });

  test("independent sessions run in parallel", async () => {
    const a = snapshot(
      await server.call("claude", { prompt: "#work=200 alpha" }),
    );
    const b = snapshot(
      await server.call("claude", { prompt: "#work=200 beta" }),
    );
    assert.notEqual(a.sessionId, b.sessionId);

    const [finalA, finalB] = await Promise.all([
      pollUntil(server, a.sessionId, (state) => state.done),
      pollUntil(server, b.sessionId, (state) => state.done),
    ]);
    assert.match(finalA.output, /alpha/);
    assert.match(finalB.output, /beta/);
  });

  test("invalid submissions and unknown sessions are actionable", async () => {
    assert.match(toolError(await server.call("claude", {})), /non-empty prompt/);

    assert.match(
      toolError(await server.call("claude-result", { sessionId: "missing" })),
      /Unknown sessionId/,
    );
    assert.match(
      toolError(await server.call("claude-cancel", { sessionId: "missing" })),
      /Unknown sessionId/,
    );
  });
});

describe("request cancellation during initialization", () => {
  const server = spawnServer({
    env: { CLAUDE_CANCEL_WATCHDOG_MS: "150" },
  });
  after(() => server.close());

  test("closes a fresh pre-init turn that has no public session id", async () => {
    await server.init();
    const { id, response } = server.beginCall(
      "claude",
      { prompt: "#init=6000 stalled fresh startup" },
      1000,
    );
    await sleep(50);

    server.send({
      jsonrpc: "2.0",
      method: "notifications/cancelled",
      params: { requestId: id, reason: "the client went away" },
    });

    await assert.rejects(() => response, /timed out waiting for response/);
    assert.deepEqual((await server.request("ping")).result, {});
  });

  test("stops the pre-init turn and sends no response", async () => {
    await server.init();
    const seed = snapshot(await server.call("claude", { prompt: "seed" }));
    await pollUntil(server, seed.sessionId, (state) => state.done);

    const { id, response } = server.beginCall(
      "claude-reply",
      {
        sessionId: seed.sessionId,
        prompt: "#init=6000 stalled startup",
      },
      1000,
    );
    await sleep(50);
    const before = snapshot(
      await server.call("claude-result", { sessionId: seed.sessionId }),
    );
    assert.equal(before.status, "starting");

    server.send({
      jsonrpc: "2.0",
      method: "notifications/cancelled",
      params: { requestId: id },
    });

    const final = await pollUntil(server, seed.sessionId, (state) => state.done);
    assert.equal(final.status, "cancelled");
    assert.equal(final.error.source, "cancel");
    await assert.rejects(() => response, /timed out waiting for response/);
  });
});

describe("turn timeout", () => {
  const server = spawnServer({
    env: { CLAUDE_TIMEOUT_MS: "120", CLAUDE_CANCEL_WATCHDOG_MS: "300" },
  });
  after(() => server.close());

  test("a hung turn becomes timed_out without holding a result request", async () => {
    await server.init();
    const submitted = snapshot(
      await server.call("claude", { prompt: "#work=9000 hung" }),
    );
    const final = await pollUntil(server, submitted.sessionId, (state) => state.done);
    assert.equal(final.status, "timed_out");
    assert.equal(final.error.source, "timeout");
  });
});
