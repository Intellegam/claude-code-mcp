/** Real CLI alias resolution, precedence, resume selection, and observed model. */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { runSession } from "../helpers/harness.mjs";
import { startTier2 } from "../helpers/fixtures.mjs";

test("family selection reaches the API across fresh sessions, replies and restart", async () => {
  const ctx = await startTier2({
    env: { ANTHROPIC_MODEL: "sonnet", ANTHROPIC_DEFAULT_HAIKU_MODEL: "custom-haiku-model" },
    turns: Array.from({ length: 12 }, () => ({ text: "done", model: "observed-serving-model" })),
  });
  try {
    // An explicit selection must beat both environment and project defaults.
    fs.writeFileSync(path.join(ctx.sandbox.repo, ".claude", "settings.local.json"),
      JSON.stringify({ model: "haiku" }));
    const submit = async (tool, args) => {
      const result = await runSession(ctx.server, tool, { cwd: ctx.sandbox.repo, prompt: "Say done.", ...args });
      assert.equal(result.model, "observed-serving-model", "report response metadata, not the requested alias");
      return { sessionId: result.sessionId, requested: ctx.mock.mainCalls().at(-1).model };
    };
    const implicit = await submit("claude", {});
    assert.equal(implicit.requested, "claude-sonnet-5", "omission preserves environment default");
    const first = await submit("claude", { model: "opus" });
    assert.equal(first.requested, "claude-opus-5-5");
    const resumed = await submit("claude-reply", { sessionId: first.sessionId });
    assert.equal(resumed.requested, "claude-opus-5-5", "remember alias, not observed-serving-model");
    const switched = await submit("claude-reply", { sessionId: first.sessionId, model: "haiku" });
    assert.equal(switched.requested, "custom-haiku-model", "the CLI owns configured alias overrides");
    assert.equal((await submit("claude-reply", { sessionId: first.sessionId })).requested, "custom-haiku-model");
    await ctx.restart();
    assert.equal((await submit("claude-reply", { sessionId: first.sessionId })).requested, "claude-sonnet-5",
      "after restart omission uses CLI defaults, not lost MCP memory");
    assert.equal((await submit("claude-reply", { sessionId: first.sessionId, model: "opus" })).requested, "claude-opus-5-5");
    assert.equal((await submit("claude-reply", { sessionId: first.sessionId })).requested, "claude-opus-5-5");
    assert.equal((await submit("claude", { model: "fable" })).requested, "claude-fable-5-1");
    assert.equal((await submit("claude", { model: "sonnet", writable: true })).requested, "claude-sonnet-5");
  } finally {
    await ctx.stop();
  }
});
