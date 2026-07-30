/**
 * Integration tier: session resume against the real CLI's on-disk transcripts.
 */

import test, { after, before, describe } from "node:test";
import assert from "node:assert/strict";
import { startMock } from "../helpers/mock-api.mjs";
import { createSandbox } from "../helpers/fixtures.mjs";
import { sessionIdFrom, spawnServer } from "../helpers/harness.mjs";

describe("resume", () => {
  const sandbox = createSandbox({ poison: false });
  let mock;
  let server;
  let sessionId;

  const serverEnv = () => ({
    HOME: sandbox.home,
    CLAUDE_CODE_MCP_TEST_BASE_URL: mock.url,
    CLAUDE_TIMEOUT_MS: "120000",
  });

  before(async () => {
    mock = await startMock({
      turns: [
        { text: "Understood: the magic word is kumquat." },
        { text: "The magic word is kumquat." },
        { text: "Still kumquat." },
      ],
    });
    server = spawnServer({
      useMockQuery: false,
      cwd: sandbox.repo,
      env: serverEnv(),
    });
    await server.init();
  });

  after(async () => {
    server?.close();
    await mock?.stop();
    sandbox.cleanup();
  });

  test("a first turn returns a session id", async () => {
    const response = await server.call(
      "claude",
      { prompt: "Remember: the magic word is kumquat.", cwd: sandbox.repo },
      120000,
    );
    assert.equal(response.error, undefined, JSON.stringify(response.error));
    sessionId = sessionIdFrom(response);
    assert.match(sessionId, /^[0-9a-f-]{36}$/);
  });

  test("a reply keeps the id and replays the conversation", async () => {
    const response = await server.call(
      "claude-reply",
      { sessionId, prompt: "What is the magic word?", cwd: sandbox.repo },
      120000,
    );
    assert.equal(response.error, undefined, JSON.stringify(response.error));
    assert.equal(sessionIdFrom(response), sessionId, "session id is preserved");

    const replayed = JSON.stringify(mock.mainCalls()[1].messages);
    assert.match(replayed, /kumquat/, "the earlier turn was replayed");
    assert.match(replayed, /What is the magic word/);
  });

  test("resuming from the wrong cwd fails with an actionable message", async () => {
    const response = await server.call(
      "claude-reply",
      { sessionId, prompt: "And again?", cwd: sandbox.root },
      120000,
    );
    assert.ok(response.error, "expected a failure");
    assert.match(response.error.message, /same cwd the session was created in/);
    assert.match(response.error.message, /No conversation found with session ID/);
  });

  test("resume works across a server restart", async () => {
    server.close();
    server = spawnServer({
      useMockQuery: false,
      cwd: sandbox.repo,
      env: serverEnv(),
    });
    await server.init();

    const response = await server.call(
      "claude-reply",
      { sessionId, prompt: "Once more: the magic word?", cwd: sandbox.repo },
      120000,
    );
    assert.equal(response.error, undefined, JSON.stringify(response.error));
    assert.equal(sessionIdFrom(response), sessionId);
  });
});
