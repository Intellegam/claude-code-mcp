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

test("the CLI compacts an oversized session and resumes the same session", async () => {
  const ctx = await startTier2({
    env: { CLAUDE_CODE_MCP_AUTO_COMPACT_WINDOW: "100000" },
    turns: [
      // Create summarizable history before reporting high input usage. A high
      // first-request usage is treated as fixed system/tool overhead, which
      // the CLI correctly refuses to compact.
      { text: "Historical evidence. ".repeat(20_000) },
      { text: "More evidence.", inputTokens: 80_000 },
      // The pinned CLI's summary request carries tools and consumes a turn.
      { text: "Historical evidence summary." },
      { text: "Continued after compaction." },
      { text: "Resumed compacted session." },
    ],
  });
  try {
    const first = await runSession(ctx.server, "claude", {
      prompt: "Remember the initial context.",
      cwd: ctx.sandbox.repo,
    });
    const oversized = await runSession(ctx.server, "claude-reply", {
      sessionId: first.sessionId,
      cwd: ctx.sandbox.repo,
      prompt: "Gather more evidence.",
    });
    assert.ok(oversized.contextTokens > oversized.autoCompactThreshold);
    const compacted = await runSession(ctx.server, "claude-reply", {
      sessionId: first.sessionId,
      cwd: ctx.sandbox.repo,
      prompt: "Continue the task.",
    });
    assert.equal(compacted.sessionId, first.sessionId);
    assert.ok(compacted.turnCompactionCount >= 1);
    assert.equal(compacted.lastCompaction.trigger, "auto");
    assert.ok(compacted.lastCompaction.preTokens >= oversized.autoCompactThreshold);
    assert.ok(compacted.lastCompaction.postTokens < compacted.lastCompaction.preTokens);
    assert.ok(compacted.contextTokens < oversized.contextTokens);
    assert.match(compacted.output, /Continued after compaction/);

    const resumed = await runSession(ctx.server, "claude-reply", {
      sessionId: first.sessionId,
      cwd: ctx.sandbox.repo,
      prompt: "Continue once more.",
    });
    assert.equal(resumed.sessionId, first.sessionId);
    assert.equal(resumed.turnCompactionCount, 0);
    assert.equal(resumed.compactionCount, compacted.compactionCount);
    assert.match(resumed.output, /Resumed compacted session/);
    const resumedHistory = JSON.stringify(ctx.mock.mainCalls().at(-1).messages);
    assert.match(resumedHistory, /Historical evidence summary/);
    assert.ok(resumedHistory.length < 100_000, "resume uses the compacted history");
  } finally {
    await ctx.stop();
  }
});
