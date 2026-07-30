/**
 * Integration tier: real interrupts against the real CLI.
 *
 * The mock streams 500 lines 30ms apart (~15s of turn), so a turn that settles
 * in a couple of seconds can only have been interrupted.
 */

import test, { after, before, describe } from "node:test";
import assert from "node:assert/strict";
import { startMock } from "../helpers/mock-api.mjs";
import { createSandbox } from "../helpers/fixtures.mjs";
import {
  sessionIdFrom,
  snapshot,
  sleep,
  spawnServer,
} from "../helpers/harness.mjs";

const LONG_STREAM = {
  text: Array.from({ length: 500 }, (_, i) => `line ${i + 1}`).join("\n"),
  slow: 30,
};

function makeServer(sandbox, mock) {
  return spawnServer({
    useMockQuery: false,
    cwd: sandbox.repo,
    env: {
      HOME: sandbox.home,
      CLAUDE_CODE_MCP_TEST_BASE_URL: mock.url,
      CLAUDE_TIMEOUT_MS: "120000",
      CLAUDE_CANCEL_WATCHDOG_MS: "30000",
    },
  });
}

describe("cancelling a running turn", () => {
  const sandbox = createSandbox({ poison: false });
  let mock;
  let server;

  before(async () => {
    mock = await startMock({ turns: [LONG_STREAM] });
    server = makeServer(sandbox, mock);
    await server.init();
  });

  after(async () => {
    server?.close();
    await mock?.stop();
    sandbox.cleanup();
  });

  test("claude-cancel interrupts the CLI mid-stream", async () => {
    const submitted = snapshot(
      await server.call(
        "claude",
        { prompt: "Count to 500, one per line.", cwd: sandbox.repo, async: true },
        120000,
      ),
    );
    assert.ok(submitted.sessionId);
    assert.equal(submitted.done, false);

    await sleep(500); // let the stream get going
    const started = Date.now();
    const cancelled = snapshot(
      await server.call("claude-cancel", { sessionId: submitted.sessionId }),
    );
    assert.equal(cancelled.cancelRequested, true);

    const final = snapshot(
      await server.call(
        "claude-result",
        { sessionId: submitted.sessionId, wait: true },
        120000,
      ),
    );
    const elapsed = Date.now() - started;
    assert.equal(final.status, "cancelled");
    assert.equal(final.done, true);
    assert.equal(final.error, null);
    assert.ok(elapsed < 10000, `settled in ${elapsed}ms, well before the 15s turn`);
  });
});

describe("cancelling before the turn is up", () => {
  const sandbox = createSandbox({ poison: false });
  let mock;
  let server;

  before(async () => {
    mock = await startMock({ turns: [{ text: "seeded" }, LONG_STREAM] });
    server = makeServer(sandbox, mock);
    await server.init();
  });

  after(async () => {
    server?.close();
    await mock?.stop();
    sandbox.cleanup();
  });

  test("a cancel racing the CLI startup is still delivered", async () => {
    const seed = await server.call(
      "claude",
      { prompt: "Say seeded.", cwd: sandbox.repo },
      120000,
    );
    const sessionId = sessionIdFrom(seed);

    // The reply's session id is known before the CLI has even started, so this
    // cancel lands in the pre-init window where interrupt() is a no-op.
    const pending = server.callAsyncPending(
      "claude-reply",
      {
        sessionId,
        prompt: "Now count to 500, one per line.",
        cwd: sandbox.repo,
        async: true,
      },
      120000,
    );
    const started = Date.now();
    const cancelled = snapshot(
      await server.call("claude-cancel", { sessionId }),
    );
    assert.equal(cancelled.cancelRequested, true);
    assert.equal(cancelled.status, "cancelling");
    assert.equal(cancelled.done, false);
    await pending;

    const final = snapshot(
      await server.call("claude-result", { sessionId, wait: true }, 120000),
    );
    const elapsed = Date.now() - started;
    assert.equal(final.status, "cancelled");
    assert.ok(elapsed < 12000, `settled in ${elapsed}ms, before the 15s turn`);
  });
});
