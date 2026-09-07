// Real CLI compaction and persisted continuation, against a mock API.

import test from "node:test";
import assert from "node:assert/strict";
import { startTier2 } from "../helpers/fixtures.mjs";
import { runSession } from "../helpers/harness.mjs";

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
    assert.equal(oversized.contextTokens, 80_000);
    assert.equal(oversized.compactedThisTurn, false);
    const compacted = await runSession(ctx.server, "claude-reply", {
      sessionId: first.sessionId,
      cwd: ctx.sandbox.repo,
      prompt: "Continue the task.",
    });
    assert.equal(compacted.sessionId, first.sessionId);
    assert.equal(compacted.compactedThisTurn, true);
    assert.ok(compacted.contextTokens < oversized.contextTokens);
    assert.match(compacted.output, /Continued after compaction/);

    const resumed = await runSession(ctx.server, "claude-reply", {
      sessionId: first.sessionId,
      cwd: ctx.sandbox.repo,
      prompt: "Continue once more.",
    });
    assert.equal(resumed.sessionId, first.sessionId);
    assert.equal(resumed.compactedThisTurn, false);
    assert.match(resumed.output, /Resumed compacted session/);
    const resumedHistory = JSON.stringify(ctx.mock.mainCalls().at(-1).messages);
    assert.match(resumedHistory, /Historical evidence summary/);
    assert.ok(resumedHistory.length < 100_000, "resume uses the compacted history");
  } finally {
    await ctx.stop();
  }
});
