/**
 * Integration tier: what a shutdown mid-turn does to the client and the child.
 *
 * The mock streams 500 lines 30ms apart (~15s of turn), so the turn is still
 * very much in flight when the signal arrives.
 */

import test, { after, before, describe } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { sleep } from "../helpers/harness.mjs";
import { startTier2 } from "../helpers/fixtures.mjs";

const LONG_STREAM = {
  text: Array.from({ length: 500 }, (_, i) => `line ${i + 1}`).join("\n"),
  slow: 30,
};

describe("shutdown mid-turn", () => {
  let ctx;

  before(async () => {
    ctx = await startTier2({ turns: [LONG_STREAM] });
  });

  after(async () => ctx?.stop());

  test("SIGTERM answers the pending request and reaps the CLI child", async () => {
    const pending = ctx.server.callAsyncPending(
      "claude",
      { prompt: "Count to 500, one per line.", cwd: ctx.sandbox.repo },
      120000,
    );
    await sleep(2000); // the CLI is up and streaming

    const children = execFileSync("pgrep", ["-P", String(ctx.server.proc.pid)])
      .toString()
      .split("\n")
      .filter(Boolean)
      .map(Number);
    assert.ok(children.length > 0, "the SDK spawned a CLI child");

    const exited = new Promise((resolve) => ctx.server.proc.once("exit", resolve));
    ctx.server.proc.kill("SIGTERM");

    // The blocked sync call is answered rather than dropped on the floor.
    const response = await pending;
    assert.ok(response.error ?? response.result, JSON.stringify(response));
    await exited;

    // The SDK's close() resolves before the CLI is actually gone; the child
    // finishes exiting on its own within a beat of losing its stdin. What must
    // not happen is an orphan that outlives the server indefinitely.
    const alive = (pid) => {
      try {
        process.kill(pid, 0);
        return true;
      } catch {
        return false;
      }
    };
    for (let i = 0; i < 20 && children.some(alive); i++) await sleep(250);
    assert.deepEqual(children.filter(alive), [], "no orphaned CLI child");
  });
});
