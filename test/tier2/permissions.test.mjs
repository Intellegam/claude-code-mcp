/**
 * Integration tier: what the spawned Claude Code can actually do to the disk.
 */

import test, { after, before, describe } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { startMock, toolResults } from "../helpers/mock-api.mjs";
import { createSandbox } from "../helpers/fixtures.mjs";
import { spawnServer } from "../helpers/harness.mjs";

function writeTurn(target) {
  return {
    tool: "Write",
    input: { file_path: target, content: "written by the model\n" },
  };
}

describe("read-only mode (the default)", () => {
  const sandbox = createSandbox({ poison: false });
  const target = path.join(sandbox.repo, "written.txt");
  let mock;
  let server;

  before(async () => {
    mock = await startMock({
      turns: [writeTurn(target), { text: "I could not write the file." }],
    });
    server = spawnServer({
      useMockQuery: false,
      cwd: sandbox.repo,
      env: {
        HOME: sandbox.home,
        CLAUDE_CODE_MCP_TEST_BASE_URL: mock.url,
        CLAUDE_TIMEOUT_MS: "120000",
      },
    });
    await server.init();
  });

  after(async () => {
    server?.close();
    await mock?.stop();
    sandbox.cleanup();
  });

  test("a Write attempt is refused and nothing lands on disk", async () => {
    const response = await server.call(
      "claude",
      { prompt: "Create written.txt", cwd: sandbox.repo },
      120000,
    );
    assert.equal(response.error, undefined, JSON.stringify(response.error));

    const results = toolResults(mock.mainCalls()[1] ?? {});
    assert.equal(results.length, 1, JSON.stringify(results));
    assert.match(results[0].text, /No such tool available/i);
    assert.equal(fs.existsSync(target), false, "no file was written");
  });
});

describe("writable mode", () => {
  const sandbox = createSandbox({ poison: false });
  const target = path.join(sandbox.repo, "written.txt");
  let mock;
  let server;

  before(async () => {
    mock = await startMock({
      turns: [writeTurn(target), { text: "Wrote the file." }],
    });
    server = spawnServer({
      useMockQuery: false,
      cwd: sandbox.repo,
      env: {
        HOME: sandbox.home,
        CLAUDE_CODE_MCP_TEST_BASE_URL: mock.url,
        CLAUDE_TIMEOUT_MS: "120000",
      },
    });
    await server.init();
  });

  after(async () => {
    server?.close();
    await mock?.stop();
    sandbox.cleanup();
  });

  test("a Write succeeds without any permission prompt", async () => {
    const response = await server.call(
      "claude",
      { prompt: "Create written.txt", cwd: sandbox.repo, writable: true },
      120000,
    );
    assert.equal(response.error, undefined, JSON.stringify(response.error));
    assert.match(response.result.content[0].text, /Wrote the file/);

    const results = toolResults(mock.mainCalls()[1] ?? {});
    assert.equal(results[0].isError, false, JSON.stringify(results));
    assert.equal(fs.readFileSync(target, "utf8"), "written by the model\n");
  });
});
