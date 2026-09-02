/**
 * Integration tier: session resume against the real CLI's on-disk transcripts.
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test, { after, before, describe } from "node:test";
import { sessionIdFrom, toolError } from "../helpers/harness.mjs";
import { startTier2 } from "../helpers/fixtures.mjs";

describe("resume", () => {
  let ctx;
  let repoLink;
  let sessionId;

  before(async () => {
    ctx = await startTier2({
      turns: [
        { text: "Understood: the magic word is kumquat." },
        { text: "The magic word is kumquat." },
        { text: "Still kumquat." },
      ],
    });
    repoLink = path.join(ctx.sandbox.root, "repo-link");
    fs.symlinkSync(ctx.sandbox.repo, repoLink, "dir");
  });

  after(async () => ctx?.stop());

  test("a first turn returns a session id", async () => {
    const response = await ctx.server.call(
      "claude",
      { prompt: "Remember: the magic word is kumquat.", cwd: repoLink },
      120000,
    );
    assert.equal(response.error, undefined, JSON.stringify(response.error));
    sessionId = sessionIdFrom(response);
    assert.match(sessionId, /^[0-9a-f-]{36}$/);
  });

  test("a reply keeps the id and replays the conversation", async () => {
    const response = await ctx.server.call(
      "claude-reply",
      { sessionId, prompt: "What is the magic word?", cwd: repoLink },
      120000,
    );
    assert.equal(response.error, undefined, JSON.stringify(response.error));
    // Not a tautology: the engine adopts whatever id `system/init` reports, so
    // this compares the id the CLI answered with against the one we resumed.
    assert.equal(sessionIdFrom(response), sessionId, "session id is preserved");

    const replayed = JSON.stringify(ctx.mock.mainCalls()[1].messages);
    assert.match(replayed, /kumquat/, "the earlier turn was replayed");
    assert.match(replayed, /What is the magic word/);
  });

  test("resuming from the wrong cwd fails with an actionable message", async () => {
    const response = await ctx.server.call(
      "claude-reply",
      { sessionId, prompt: "And again?", cwd: ctx.sandbox.root },
      120000,
    );
    const failure = toolError(response);
    assert.match(failure, /same cwd the session was created in/);
    assert.match(failure, new RegExp(ctx.sandbox.repo));
    assert.match(failure, new RegExp(ctx.sandbox.root));
    assert.match(failure, /sessionId: /, "the handle is kept");
  });

  test("resume works across a server restart", async () => {
    await ctx.restart();
    const response = await ctx.server.call(
      "claude-reply",
      { sessionId, prompt: "Once more: the magic word?", cwd: repoLink },
      120000,
    );
    assert.equal(response.error, undefined, JSON.stringify(response.error));
    assert.equal(sessionIdFrom(response), sessionId);
  });

  test("the original cwd is still enforced after a server restart", async () => {
    await ctx.restart();
    for (let attempt = 1; attempt <= 2; attempt++) {
      const response = await ctx.server.call(
        "claude-reply",
        { sessionId, prompt: "And from elsewhere?", cwd: ctx.sandbox.root },
        120000,
      );
      const failure = toolError(response);
      assert.match(failure, /same cwd the session was created in/);
      assert.match(failure, new RegExp(ctx.sandbox.repo));
      assert.match(failure, new RegExp(ctx.sandbox.root));
    }
  });
});
