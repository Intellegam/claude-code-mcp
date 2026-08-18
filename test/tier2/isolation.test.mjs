/**
 * Integration tier: the real Claude Code CLI (bundled with the SDK) against a
 * mock Anthropic API. No network, no real model, no OAuth.
 *
 * This is where the trust model is asserted end to end: a consultation runs as
 * the operator's own Claude Code — user *and* project configuration load — and
 * the tool surface is exactly what the wrapper intends.
 */

import test, { after, before, describe } from "node:test";
import assert from "node:assert/strict";
import { systemText, toolResults } from "../helpers/mock-api.mjs";
import {
  ALIAS_BRIDGE_MCP_TOOL,
  BRIDGE_MCP_TOOL,
  CLAUDE_BRIDGE_MCP_TOOL,
  DENIED_MCP_TOOL,
  MCP_TOOL_OUTPUT,
  PLUGIN_BRIDGE_MCP_TOOL,
  PLUGIN_CLAUDE_BRIDGE_MCP_TOOL,
  PROJECT_MARKER,
  REPO_MCP_TOOL,
  USER_MARKER,
  USER_MCP_TOOL,
  startTier2,
} from "../helpers/fixtures.mjs";

/**
 * The built-in tools a read-only consultation may use, as the CLI reports them.
 *
 * This is a drift guard, not a description: an SDK/CLI bump that introduces a
 * new capability tool has to fail here rather than silently widen the surface.
 * When it does, decide whether the newcomer belongs on a disallow list in
 * lib/isolation.js before updating this snapshot.
 */
const READ_ONLY_BUILTIN_TOOLS = [
  "Glob",
  "Grep",
  "Read",
  "ReportFindings",
  "Skill",
  "TaskGet",
  "TaskList",
  "TaskOutput",
  "WebFetch",
  "WebSearch",
];

describe("the operator's own configuration is what loads", () => {
  let ctx;

  before(async () => {
    ctx = await startTier2({
      mcpServers: true,
      turns: [{ text: "isolation check done" }],
    });
  });

  after(async () => ctx?.stop());

  test("a turn completes against the real CLI", async () => {
    const response = await ctx.server.call(
      "claude",
      { prompt: "Say hello.", cwd: ctx.sandbox.repo },
      120000,
    );
    assert.equal(response.error, undefined, JSON.stringify(response.error));
    assert.match(response.result.content[0].text, /isolation check done/);
    // "mock-model" is the mock API's assistant-message model: through the real
    // CLI, the trailer follows what actually served the turn.
    assert.match(response.result.content[1].text, /\[MODEL: mock-model\]/);
  });

  test("both the user and the project hook ran", () => {
    assert.deepEqual(ctx.sandbox.firedSentinels(), [
      "project-hook",
      "user-hook",
    ]);
  });

  test("user and project memory both reach the model", () => {
    const conversation = JSON.stringify(ctx.mock.mainCalls()[0].messages);
    assert.match(conversation, new RegExp(PROJECT_MARKER));
    assert.match(conversation, new RegExp(USER_MARKER));
  });

  test("MCP servers from both scopes are offered to the model", () => {
    const { tools } = ctx.mock.mainCalls()[0];
    assert.ok(tools.includes(USER_MCP_TOOL), JSON.stringify(tools));
    assert.ok(tools.includes(REPO_MCP_TOOL), JSON.stringify(tools));
    assert.ok(!tools.includes(BRIDGE_MCP_TOOL), "manual bridge tool is hidden");
    assert.ok(
      !tools.includes(PLUGIN_BRIDGE_MCP_TOOL),
      "plugin-normalized bridge tool is hidden",
    );
    assert.ok(
      tools.includes(ALIAS_BRIDGE_MCP_TOOL),
      "an alias outside the exact deny-list reaches the fallback hook",
    );
  });

  test("the Claude Code preset system prompt is used", () => {
    const system = systemText(ctx.mock.mainCalls()[0].system);
    assert.ok(system.length > 5000, `system prompt is only ${system.length} chars`);
    assert.match(system, /second\s+opinion/i, "consultation preamble present");
  });

  test("the read-only built-in tool surface matches the snapshot", () => {
    const builtins = ctx.mock
      .mainCalls()[0]
      .tools.filter((name) => !name.startsWith("mcp__"))
      .sort();
    // The fixture's project settings allow Bash and Write; `disallowedTools`
    // has to beat that.
    assert.deepEqual(builtins, READ_ONLY_BUILTIN_TOOLS);
  });
});

describe("MCP tool availability", () => {
  let ctx;

  before(async () => {
    ctx = await startTier2({
      mcpServers: true,
      turns: [
        { tool: REPO_MCP_TOOL, input: {} },
        { text: "the repo tool ran" },
        { tool: DENIED_MCP_TOOL, input: {} },
        { text: "the operator's rule refused it" },
        ...[
          BRIDGE_MCP_TOOL,
          PLUGIN_BRIDGE_MCP_TOOL,
          CLAUDE_BRIDGE_MCP_TOOL,
          PLUGIN_CLAUDE_BRIDGE_MCP_TOOL,
        ].flatMap((tool) => [
          { tool, input: {} },
          { text: "the bridge was refused" },
          { tool, input: {} },
          { text: "the bridge was refused again" },
        ]),
        { tool: ALIAS_BRIDGE_MCP_TOOL, input: {} },
        { text: "the alias was refused" },
        { tool: ALIAS_BRIDGE_MCP_TOOL, input: {} },
        { text: "the alias was refused again" },
      ],
    });
  });

  after(async () => ctx?.stop());

  test("a benign MCP tool runs even in read-only mode", async () => {
    // Read-only sets no permissionMode, so this tool raises a permission
    // request; `canUseTool` is what answers it headless. The fixture puts a
    // `permissions.ask` rule on this very tool: its forced request reaches
    // the callback indistinguishable from an unruled one (no `decisionReason`,
    // no `matchedAskRule` on the pinned CLI), so the tool still runs — the
    // documented ask-on-MCP limitation, pinned here.
    const response = await ctx.server.call(
      "claude",
      { prompt: "Use the repo tool.", cwd: ctx.sandbox.repo },
      120000,
    );
    assert.equal(response.error, undefined, JSON.stringify(response.error));
    const results = toolResults(ctx.mock.mainCalls()[1]);
    assert.equal(results[0].isError, false, JSON.stringify(results));
    assert.match(results[0].text, new RegExp(MCP_TOOL_OUTPUT));
  });

  test("the operator's own deny rule beats the wrapper's approval", async () => {
    // `canUseTool` runs *after* rule evaluation, so a project `permissions.deny`
    // short-circuits before it. A wrapper that approved MCP tools terminally
    // would be escalating privileges against the operator's settings.
    const before = ctx.mock.mainCalls().length;
    const response = await ctx.server.call(
      "claude",
      { prompt: "Use the deny tool.", cwd: ctx.sandbox.repo },
      120000,
    );
    assert.equal(response.error, undefined, JSON.stringify(response.error));
    const results = toolResults(ctx.mock.mainCalls()[before + 1]);
    assert.equal(results[0].isError, true, JSON.stringify(results));
    assert.ok(
      !results[0].text.includes(MCP_TOOL_OUTPUT),
      "the denied tool never ran",
    );
  });

  for (const bridgeTool of [
    BRIDGE_MCP_TOOL,
    PLUGIN_BRIDGE_MCP_TOOL,
    CLAUDE_BRIDGE_MCP_TOOL,
    PLUGIN_CLAUDE_BRIDGE_MCP_TOOL,
  ]) {
    for (const writable of [false, true]) {
      test(`${bridgeTool} is hidden (writable=${writable})`, async () => {
        const before = ctx.mock.mainCalls().length;
        const response = await ctx.server.call(
          "claude",
          { prompt: "Call the agent bridge.", cwd: ctx.sandbox.repo, writable },
          120000,
        );
        assert.equal(response.error, undefined, JSON.stringify(response.error));
        const results = toolResults(ctx.mock.mainCalls()[before + 1]);
        assert.equal(results[0].isError, true, JSON.stringify(results));
        assert.match(results[0].text, /No such tool available/i);
        assert.ok(!results[0].text.includes(MCP_TOOL_OUTPUT), "bridge never ran");
      });
    }
  }

  for (const writable of [false, true]) {
    test(`the fallback hook denies an alias (writable=${writable})`, async () => {
      const before = ctx.mock.mainCalls().length;
      const response = await ctx.server.call(
        "claude",
        { prompt: "Call the Codex alias.", cwd: ctx.sandbox.repo, writable },
        120000,
      );
      assert.equal(response.error, undefined, JSON.stringify(response.error));
      const results = toolResults(ctx.mock.mainCalls()[before + 1]);
      assert.equal(results[0].isError, true, JSON.stringify(results));
      assert.match(results[0].text, /Agent-bridge MCP servers are not available/);
      assert.ok(!results[0].text.includes(MCP_TOOL_OUTPUT), "bridge never ran");
    });
  }
});

describe("the child process environment", () => {
  let ctx;

  before(async () => {
    ctx = await startTier2({
      turns: [
        {
          tool: "Bash",
          input: {
            command:
              'echo "PREFIXED=[$CLAUDE_CODE_CANARY] OAUTH=[$CLAUDE_CODE_OAUTH_TOKEN] INHERITED=[$CCMCP_ORDINARY_VAR]"',
            description: "probe the environment",
          },
        },
        { text: "environment probed" },
      ],
      env: {
        CCMCP_ORDINARY_VAR: "inherited-on-purpose",
        CLAUDE_CODE_CANARY: "canary-must-not-leak",
        CLAUDE_CODE_OAUTH_TOKEN: "token-must-not-leak",
      },
    });
  });

  after(async () => ctx?.stop());

  test("CLAUDE_CODE_* is stripped, ordinary vars are inherited", async () => {
    const response = await ctx.server.call(
      "claude",
      { prompt: "Probe the environment.", cwd: ctx.sandbox.repo, writable: true },
      120000,
    );
    assert.equal(response.error, undefined, JSON.stringify(response.error));

    const results = toolResults(ctx.mock.mainCalls()[1]);
    assert.equal(results.length, 1, JSON.stringify(results));
    const output = results[0].text;
    assert.match(output, /PREFIXED=\[\]/, "CLAUDE_CODE_* must not be inherited");
    assert.match(
      output,
      /OAUTH=\[\]/,
      "a credential is never forwarded to the test endpoint",
    );
    assert.match(output, /INHERITED=\[inherited-on-purpose\]/);
    assert.ok(!output.includes("must-not-leak"));
  });

  test("writable mode offers the write tools but still no delegation", () => {
    const { tools } = ctx.mock.mainCalls()[0];
    assert.ok(tools.includes("Write"));
    assert.ok(tools.includes("Bash"));
    for (const blocked of [
      "Task",
      "Agent",
      "Workflow",
      "SendMessage",
      "EnterWorktree",
      "RemoteTrigger",
      "CronList",
    ]) {
      assert.ok(!tools.includes(blocked), `${blocked} must not be offered`);
    }
  });
});
