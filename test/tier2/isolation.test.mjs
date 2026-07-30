/**
 * Integration tier: the real Claude Code CLI (bundled with the SDK) against a
 * mock Anthropic API. No network, no real model, no OAuth.
 */

import test, { after, before, describe } from "node:test";
import assert from "node:assert/strict";
import { startMock, systemText, toolResults } from "../helpers/mock-api.mjs";
import {
  PROJECT_MARKER,
  USER_MARKER,
  createSandbox,
} from "../helpers/fixtures.mjs";
import { spawnServer } from "../helpers/harness.mjs";

describe("ambient configuration is not loaded", () => {
  const sandbox = createSandbox();
  let mock;
  let server;

  before(async () => {
    mock = await startMock({ turns: [{ text: "isolation check done" }] });
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

  test("a turn completes against the real CLI", async () => {
    const response = await server.call(
      "claude",
      { prompt: "Say hello.", cwd: sandbox.repo },
      120000,
    );
    assert.equal(response.error, undefined, JSON.stringify(response.error));
    assert.match(response.result.content[0].text, /isolation check done/);
  });

  test("no project or user hook fired, and no project MCP server started", () => {
    assert.deepEqual(sandbox.firedSentinels(), []);
  });

  test("no MCP tools were offered to the model", () => {
    const call = mock.mainCalls()[0];
    assert.ok(call, "a main turn was recorded");
    const mcpTools = call.tools.filter((name) => name.startsWith("mcp__"));
    assert.deepEqual(mcpTools, []);
    assert.ok(!call.tools.includes("poison_ping"));
  });

  test("the project CLAUDE.md reaches the model only through our injection", () => {
    const system = systemText(mock.mainCalls()[0].system);
    const occurrences = system.split(PROJECT_MARKER).length - 1;
    assert.equal(occurrences, 1, "injected exactly once");
    assert.match(system, /# Project context/);
    assert.ok(
      system.indexOf("# Project context") < system.indexOf(PROJECT_MARKER),
      "the marker sits under our header",
    );
  });

  test("user-level memory is not loaded", () => {
    const system = systemText(mock.mainCalls()[0].system);
    assert.ok(!system.includes(USER_MARKER));
  });

  test("the Claude Code preset system prompt is used", () => {
    const system = systemText(mock.mainCalls()[0].system);
    assert.ok(system.length > 5000, `system prompt is only ${system.length} chars`);
    assert.match(system, /second\s+opinion/i, "consultation preamble present");
  });

  test("read-only mode offers no write, shell or delegation tools", () => {
    const tools = mock.mainCalls()[0].tools;
    for (const blocked of [
      "Write",
      "Edit",
      "NotebookEdit",
      "Bash",
      "Monitor",
      "Task",
      "Workflow",
      "EnterWorktree",
      "CronCreate",
      "SendMessage",
    ]) {
      assert.ok(!tools.includes(blocked), `${blocked} must not be offered`);
    }
    assert.ok(tools.includes("Read"), "Read is still available");
  });
});

describe("the child process environment", () => {
  const sandbox = createSandbox({ poison: false });
  let mock;
  let server;

  before(async () => {
    mock = await startMock({
      turns: [
        {
          tool: "Bash",
          input: {
            command:
              'echo "CANARY=[$CCMCP_CANARY_VAR] NESTED=[$CLAUDECODE] SECRET=[$CCMCP_SECRET]"',
            description: "probe the environment",
          },
        },
        { text: "environment probed" },
      ],
    });
    server = spawnServer({
      useMockQuery: false,
      cwd: sandbox.repo,
      env: {
        HOME: sandbox.home,
        CLAUDE_CODE_MCP_TEST_BASE_URL: mock.url,
        CLAUDE_TIMEOUT_MS: "120000",
        CCMCP_CANARY_VAR: "canary-value-must-not-leak",
        CCMCP_SECRET: "secret-value-must-not-leak",
        CLAUDECODE: "1",
      },
    });
    await server.init();
  });

  after(async () => {
    server?.close();
    await mock?.stop();
    sandbox.cleanup();
  });

  test("the canary variables are not visible to the child", async () => {
    const response = await server.call(
      "claude",
      { prompt: "Probe the environment.", cwd: sandbox.repo, writable: true },
      120000,
    );
    assert.equal(response.error, undefined, JSON.stringify(response.error));

    const followUp = mock.mainCalls()[1];
    assert.ok(followUp, "the tool result was sent back to the model");
    const results = toolResults(followUp);
    assert.equal(results.length, 1, JSON.stringify(results));
    const output = results[0].text;
    assert.match(output, /CANARY=\[\]/);
    assert.match(output, /SECRET=\[\]/);
    assert.ok(!output.includes("must-not-leak"));
  });

  test("writable mode offers the write tools but still no delegation", () => {
    const tools = mock.mainCalls()[0].tools;
    assert.ok(tools.includes("Write"));
    assert.ok(tools.includes("Bash"));
    for (const blocked of ["Task", "Workflow", "SendMessage", "EnterWorktree"]) {
      assert.ok(!tools.includes(blocked), `${blocked} must not be offered`);
    }
  });
});
