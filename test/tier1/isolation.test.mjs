import test, { describe } from "node:test";
import assert from "node:assert/strict";
import {
  ALWAYS_DISALLOWED_TOOLS,
  BRIDGE_DENY_MESSAGE,
  buildChildEnv,
  buildQueryOptions,
} from "../../lib/isolation.js";

const PARENT_ENV = {
  PATH: "/usr/bin",
  HOME: "/Users/tester",
  HTTPS_PROXY: "http://proxy.internal:3128",
  NODE_EXTRA_CA_CERTS: "/etc/ssl/corp.pem",
  ANTHROPIC_API_KEY: "sk-ant-real",
  ANTHROPIC_BASE_URL: "https://proxy.internal",
  CLAUDECODE: "1",
  CLAUDE_CODE_ENTRYPOINT: "cli",
  CLAUDE_CODE_OAUTH_TOKEN: "oauth-token",
};

describe("child environment denylist", () => {
  test("inherits the parent environment, including proxy and TLS settings", () => {
    const env = buildChildEnv(PARENT_ENV);
    assert.equal(env.PATH, "/usr/bin");
    assert.equal(env.HOME, "/Users/tester");
    assert.equal(env.HTTPS_PROXY, "http://proxy.internal:3128");
    assert.equal(env.NODE_EXTRA_CA_CERTS, "/etc/ssl/corp.pem");
    assert.equal(env.ANTHROPIC_API_KEY, "sk-ant-real");
  });

  test("drops nested-session markers but keeps the OAuth credential", () => {
    const env = buildChildEnv(PARENT_ENV);
    assert.equal(env.CLAUDECODE, undefined);
    assert.equal(env.CLAUDE_CODE_ENTRYPOINT, undefined);
    assert.equal(env.CLAUDE_CODE_OAUTH_TOKEN, "oauth-token");
  });

  test("an inherited ANTHROPIC_BASE_URL never reaches the child", () => {
    assert.equal(buildChildEnv(PARENT_ENV).ANTHROPIC_BASE_URL, undefined);
  });

  test("the test hook substitutes a dummy key and drops real credentials", () => {
    const env = buildChildEnv({
      ...PARENT_ENV,
      CLAUDE_CODE_MCP_TEST_BASE_URL: "http://127.0.0.1:9999",
    });
    assert.equal(env.ANTHROPIC_BASE_URL, "http://127.0.0.1:9999");
    assert.notEqual(
      env.ANTHROPIC_API_KEY,
      "sk-ant-real",
      "a real key must never be forwarded to a test endpoint",
    );
    assert.ok(env.ANTHROPIC_API_KEY, "a dummy key is provided");
    assert.equal(env.CLAUDE_CODE_OAUTH_TOKEN, undefined);
  });
});

describe("query options", () => {
  const base = { cwd: "/repo", parentEnv: PARENT_ENV };

  test("read-only mode removes every write and execute surface", () => {
    const options = buildQueryOptions(base);
    for (const tool of ["Write", "Edit", "NotebookEdit", "Bash", "Monitor", "REPL"]) {
      assert.ok(
        options.disallowedTools.includes(tool),
        `${tool} must be disallowed`,
      );
    }
    assert.equal(options.permissionMode, undefined);
    assert.equal(options.allowedTools, undefined, "read tools stay available");
  });

  test("writable mode bypasses permissions but keeps delegation blocked", () => {
    const options = buildQueryOptions({ ...base, writable: true });
    assert.equal(options.permissionMode, "bypassPermissions");
    assert.deepEqual(options.disallowedTools, ALWAYS_DISALLOWED_TOOLS);
    for (const tool of ["Write", "Edit", "Bash"]) {
      assert.ok(!options.disallowedTools.includes(tool), `${tool} is allowed`);
    }
  });

  test("delegation, scheduling and messaging are blocked in both modes", () => {
    for (const writable of [false, true]) {
      const { disallowedTools } = buildQueryOptions({ ...base, writable });
      // `Task` is the name init reports, `Agent` the one the model sees.
      for (const tool of ["Task", "Agent", "Workflow", "RemoteTrigger", "CronList"]) {
        assert.ok(
          disallowedTools.includes(tool),
          `${tool} must be disallowed (writable=${writable})`,
        );
      }
      for (const tool of ALWAYS_DISALLOWED_TOOLS) {
        assert.ok(disallowedTools.includes(tool), `${tool} (writable=${writable})`);
      }
    }
  });

  test("the operator's own configuration sources are left alone", () => {
    const options = buildQueryOptions(base);
    assert.equal(
      options.settingSources,
      undefined,
      "the CLI default (user + project + local) is the point",
    );
    assert.equal(options.env.CLAUDECODE, undefined);
  });

  test("the claude_code preset is requested explicitly", () => {
    const options = buildQueryOptions(base);
    assert.equal(options.systemPrompt.type, "preset");
    assert.equal(options.systemPrompt.preset, "claude_code");
    assert.match(options.systemPrompt.append, /second\s+opinion/i);
    assert.match(
      options.systemPrompt.append,
      /Agent-bridge MCP\s+servers[\s\S]*unavailable/,
      "the consulted agent is told not to go looking for a bridge",
    );
  });

  test("resume is only set when asked for", () => {
    assert.equal(buildQueryOptions(base).resume, undefined);
    assert.equal(buildQueryOptions({ ...base, resume: "abc" }).resume, "abc");
  });
});

describe("the agent-bridge PreToolUse gate", () => {
  const decide = async (options, toolName) => {
    const [matcher] = options.hooks.PreToolUse;
    const [hook] = matcher.hooks;
    return hook({ hook_event_name: "PreToolUse", tool_name: toolName }, "id", {
      signal: new AbortController().signal,
    });
  };

  // A hook rather than canUseTool because canUseTool is never invoked under
  // `bypassPermissions` — the writable mode this wrapper uses.
  for (const writable of [false, true]) {
    test(`bridge servers are denied (writable=${writable})`, async () => {
      const options = buildQueryOptions({ cwd: "/repo", writable });
      for (const tool of [
        "mcp__codex-agent__codex",
        "mcp__codex__reply",
        "mcp__claude-code-mcp__claude",
        "mcp__CLAUDE_CODE__claude",
      ]) {
        const decision = await decide(options, tool);
        assert.equal(
          decision.hookSpecificOutput.permissionDecision,
          "deny",
          tool,
        );
        assert.equal(
          decision.hookSpecificOutput.permissionDecisionReason,
          BRIDGE_DENY_MESSAGE,
        );
      }
    });

    test(`repo-declared MCP tools are allowed (writable=${writable})`, async () => {
      const options = buildQueryOptions({ cwd: "/repo", writable });
      const decision = await decide(options, "mcp__logfire__query_run");
      assert.equal(decision.hookSpecificOutput.permissionDecision, "allow");
    });
  }

  test("built-in tools fall through to the CLI's own handling", async () => {
    const options = buildQueryOptions({ cwd: "/repo" });
    const decision = await decide(options, "Read");
    assert.equal(decision.hookSpecificOutput, undefined);
    assert.equal(decision.continue, true);
  });
});
