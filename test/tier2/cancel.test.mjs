/**
 * Integration tier: real interrupts against the real CLI.
 *
 * The mock streams 500 lines 30ms apart (~15s of turn), so a turn that settles
 * in a couple of seconds can only have been stopped.
 */

import test, { after, before, describe } from "node:test";
import assert from "node:assert/strict";
import {
  pollUntil,
  runSession,
  snapshot,
  sleep,
} from "../helpers/harness.mjs";
import { LONG_STREAM, startTier2 } from "../helpers/fixtures.mjs";

const CANCEL_ENV = { CLAUDE_CANCEL_WATCHDOG_MS: "30000" };

describe("cancelling a running turn", () => {
  let ctx;

  before(async () => {
    ctx = await startTier2({ turns: [LONG_STREAM], env: CANCEL_ENV });
  });

  after(async () => ctx?.stop());

  test("claude-cancel interrupts the CLI mid-stream", async () => {
    const submitted = snapshot(
      await ctx.server.call(
        "claude",
        {
          prompt: "Count to 500, one per line.",
          cwd: ctx.sandbox.repo,
        },
        120000,
      ),
    );
    assert.ok(submitted.sessionId);
    assert.equal(submitted.done, false);

    await sleep(500); // let the stream get going
    const started = Date.now();
    const cancelled = snapshot(
      await ctx.server.call("claude-cancel", { sessionId: submitted.sessionId }),
    );
    assert.equal(cancelled.cancelRequested, true);

    const final = await pollUntil(
      ctx.server,
      submitted.sessionId,
      (state) => state.done,
    );
    const elapsed = Date.now() - started;
    assert.equal(final.status, "cancelled");
    assert.equal(final.done, true);
    assert.equal(final.error, null);
    assert.ok(elapsed < 10000, `settled in ${elapsed}ms, well before the 15s turn`);
  });
});

describe("cancelling before the turn is up", () => {
  let ctx;

  before(async () => {
    ctx = await startTier2({
      turns: [{ text: "seeded" }, LONG_STREAM],
      env: CANCEL_ENV,
    });
  });

  after(async () => ctx?.stop());

  test("a post-restart cancel racing the CLI startup is still delivered", async () => {
    const seed = await runSession(
      ctx.server,
      "claude",
      { prompt: "Say seeded.", cwd: ctx.sandbox.repo },
      120000,
    );
    const sessionId = seed.sessionId;
    await ctx.restart();

    // The reply's session id is known before persisted-cwd validation and the
    // CLI have started, so this cancel lands in the pre-init window where the
    // runner must buffer it and the validation proxy must preserve interrupt().
    // Deliberately not awaited: `call()` has already written the request.
    const pending = ctx.server.call(
      "claude-reply",
      {
        sessionId,
        prompt: "Now count to 500, one per line.",
        cwd: ctx.sandbox.repo,
      },
      120000,
    );
    const started = Date.now();
    // Assert the precondition: on a slow machine this test would otherwise
    // quietly become another post-init cancel.
    const before = snapshot(
      await ctx.server.call("claude-result", { sessionId }),
    );
    assert.equal(before.status, "starting", "the CLI has not initialized yet");

    const cancelled = snapshot(
      await ctx.server.call("claude-cancel", { sessionId }),
    );
    assert.equal(cancelled.cancelRequested, true);
    assert.equal(cancelled.status, "cancelling");
    assert.equal(cancelled.done, false);
    await pending;

    const final = await pollUntil(
      ctx.server,
      sessionId,
      (state) => state.done,
    );
    const elapsed = Date.now() - started;
    assert.equal(final.status, "cancelled");
    assert.ok(elapsed < 12000, `settled in ${elapsed}ms, before the 15s turn`);
  });
});
