/**
 * Integration tier: what a shutdown mid-turn does to the client and the child.
 *
 * The turn is a ~15s stream, so it is still very much in flight when the signal
 * arrives.
 */

import test, { after, before, describe } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { runSession, sleep, snapshot } from "../helpers/harness.mjs";
import { LONG_STREAM, startTier2 } from "../helpers/fixtures.mjs";

/** Direct children of `pid`. `pgrep` exits 1 — i.e. throws — when there are none. */
function childrenOf(pid) {
  try {
    return execFileSync("pgrep", ["-P", String(pid)])
      .toString()
      .split("\n")
      .filter(Boolean)
      .map(Number);
  } catch {
    return [];
  }
}

const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

describe("shutdown mid-turn", () => {
  let ctx;

  before(async () => {
    ctx = await startTier2({ turns: [{ text: "seeded" }, LONG_STREAM] });
  });

  after(async () => ctx?.stop());

  test("SIGTERM reaps the CLI child of an active turn", async () => {
    const seed = await runSession(
      ctx.server,
      "claude",
      { prompt: "Say seeded.", cwd: ctx.sandbox.repo },
      120000,
    );
    const sessionId = seed.sessionId;
    await ctx.restart();

    const submitted = snapshot(
      await ctx.server.call(
        "claude-reply",
        {
          sessionId,
          prompt: "Now count to 500, one per line.",
          cwd: ctx.sandbox.repo,
        },
        120000,
      ),
    );
    assert.equal(submitted.done, false);

    // Wait for the CLI itself rather than a fixed delay — a signal that beats
    // the child would test nothing.
    let children = [];
    for (let i = 0; i < 200 && children.length === 0; i++) {
      children = childrenOf(ctx.server.proc.pid);
      if (children.length === 0) await sleep(50);
    }
    assert.ok(children.length > 0, "the SDK spawned a CLI child");

    const exited = new Promise((resolve) => ctx.server.proc.once("exit", resolve));
    ctx.server.proc.kill("SIGTERM");

    await exited;

    // The SDK's close() resolves before the CLI is actually gone; the child
    // finishes exiting on its own within a beat of losing its stdin. What must
    // not happen is an orphan that outlives the server indefinitely.
    for (let i = 0; i < 20 && children.some(alive); i++) await sleep(250);
    assert.deepEqual(children.filter(alive), [], "no orphaned CLI child");
  });
});
