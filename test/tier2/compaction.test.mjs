/**
 * Pin the installed CLI's effective MCP-only auto-compaction policy through
 * its emitted state and context-usage control response, without real-model
 * traffic. The effective window is model-clamped, so assert the invariant
 * rather than assuming every operator's default model has a 320k window.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { startTier2 } from "../helpers/fixtures.mjs";
import { runSession } from "../helpers/harness.mjs";

async function configuredSnapshot(window) {
  const ctx = await startTier2({
    env: {
      // Keep the installed-CLI assertion deterministic when the test runner
      // itself has an MCP compaction override configured.
      CLAUDE_CODE_MCP_AUTO_COMPACT_WINDOW: String(window ?? 320_000),
    },
    turns: [{ text: "done" }],
  });
  try {
    return await runSession(ctx.server, "claude", {
      prompt: "Say done.",
      cwd: ctx.sandbox.repo,
    });
  } finally {
    await ctx.stop();
  }
}

test("100k setting produces the installed CLI's 67k threshold", async () => {
  const snapshot = await configuredSnapshot(100_000);
  assert.equal(snapshot.autoCompactWindow, 100_000);
  assert.equal(snapshot.contextWindow, 100_000);
  assert.equal(snapshot.autoCompactThreshold, 67_000);
  assert.equal(snapshot.isAutoCompactEnabled, true);
});

test("the 320k default reports its model-clamped effective threshold", async () => {
  const snapshot = await configuredSnapshot();
  assert.equal(snapshot.autoCompactWindow, 320_000);
  assert.ok(snapshot.contextWindow > 0);
  assert.ok(snapshot.contextWindow <= 320_000);
  assert.equal(
    snapshot.autoCompactThreshold,
    snapshot.contextWindow - 33_000,
  );
  assert.equal(snapshot.isAutoCompactEnabled, true);
});
