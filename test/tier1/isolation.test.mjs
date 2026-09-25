import test, { describe } from "node:test";
import assert from "node:assert/strict";
import {
  ALWAYS_DISALLOWED_TOOLS,
  ASK_RULE_DENY_MESSAGE,
  BRIDGE_DENY_MESSAGE,
  UNGRANTED_DENY_MESSAGE,
  buildChildEnv,
  buildQueryOptions,
  resolveAutoCompactWindow,
} from "../../lib/isolation.js";

const PARENT_ENV = {
  PATH: "/usr/bin",
  HOME: "/Users/tester",
  HTTPS_PROXY: "http://proxy.internal:3128",
  NODE_EXTRA_CA_CERTS: "/etc/ssl/corp.pem",
  ANTHROPIC_API_KEY: "sk-ant-real",
  ANTHROPIC_BASE_URL: "https://gateway.internal",
  ANTHROPIC_AUTH_TOKEN: "gateway-credential",
  ANTHROPIC_CUSTOM_HEADERS: "Authorization: Bearer gateway-credential",
  ANTHROPIC_UNIX_SOCKET: "/tmp/anthropic.sock",
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

  test("the transport override and its credentials are dropped together", () => {
    const env = buildChildEnv(PARENT_ENV);
    // Keeping the gateway credential while dropping the gateway address would
    // send it to the default endpoint instead.
    for (const key of [
      "ANTHROPIC_BASE_URL",
      "ANTHROPIC_UNIX_SOCKET",
      "ANTHROPIC_AUTH_TOKEN",
      "ANTHROPIC_CUSTOM_HEADERS",
    ]) {
      assert.equal(env[key], undefined, `${key} must not reach the child`);
    }
    assert.equal(
      env.ANTHROPIC_API_KEY,
      "sk-ant-real",
      "the default-endpoint credential is kept",
    );
  });

  test("denied names are matched case-insensitively", () => {
    // Windows environments are case-insensitive; `Anthropic_Base_Url` is the
    // same variable and must not slip through.
    const env = buildChildEnv({
      PATH: "/usr/bin",
      Anthropic_Base_Url: "https://gateway.internal",
      anthropic_auth_token: "gateway-credential",
      ClaudeCode: "1",
      Claude_Code_Entrypoint: "cli",
    });
    assert.deepEqual(Object.keys(env), ["PATH"]);
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
    assert.equal(env.ANTHROPIC_AUTH_TOKEN, undefined);
    assert.equal(env.ANTHROPIC_CUSTOM_HEADERS, undefined);
  });

  test("the test hook leaves no other way to reach a real backend", () => {
    // The prefix exceptions survive the denylist and each one bypasses the test
    // endpoint: the OAuth token is a live credential, and the Bedrock/Vertex
    // switches make the CLI ignore ANTHROPIC_BASE_URL entirely. Case-insensitive
    // for the same Windows reason as the denylist — `env` keeps the parent's
    // casing, so an upper-case-only delete would miss `Claude_Code_Oauth_Token`.
    const env = buildChildEnv({
      PATH: "/usr/bin",
      Claude_Code_Oauth_Token: "oauth-token",
      CLAUDE_CODE_USE_BEDROCK: "1",
      claude_code_use_vertex: "1",
      Anthropic_Api_Key: "sk-ant-real",
      CLAUDE_CODE_MCP_TEST_BASE_URL: "http://127.0.0.1:9999",
    });
    for (const key of Object.keys(env)) {
      assert.ok(
        !/^CLAUDE_CODE_(OAUTH_TOKEN|USE_BEDROCK|USE_VERTEX)$/.test(
          key.toUpperCase(),
        ),
        `${key} must not reach a child pointed at the test endpoint`,
      );
    }
    assert.equal(env.ANTHROPIC_BASE_URL, "http://127.0.0.1:9999");
    assert.equal(
      env.Anthropic_Api_Key,
      undefined,
      "a real key must not sit beside the dummy key",
    );
    assert.equal(env.ANTHROPIC_API_KEY, "sk-ant-mcp-test", "only the dummy key");
  });
});

describe("query options", () => {
  const base = { cwd: "/repo", parentEnv: PARENT_ENV };

  test("model selection is passed unchanged and omitted by default", () => {
    assert.equal(Object.hasOwn(buildQueryOptions(base), "model"), false);
    for (const writable of [false, true]) {
      for (const model of ["fable", "opus", "sonnet", "haiku"]) {
        assert.equal(buildQueryOptions({ ...base, model, writable }).model, model);
      }
    }
  });

  test("read-only mode removes every write and execute surface", () => {
    const options = buildQueryOptions(base);
    for (const tool of [
      "Write",
      "Edit",
      "NotebookEdit",
      "Bash",
      "Monitor",
      "REPL",
      "TaskCreate",
      "TaskUpdate",
      "TaskStop",
    ]) {
      assert.ok(
        options.disallowedTools.includes(tool),
        `${tool} must be disallowed`,
      );
    }
    for (const tool of ["ListAgents", "TaskGet", "TaskList", "TaskOutput"]) {
      assert.ok(!options.disallowedTools.includes(tool), `${tool} stays`);
    }
    assert.equal(options.permissionMode, undefined);
    assert.equal(options.allowedTools, undefined, "read tools stay available");
  });

  test("read-only mode disables inline shell execution in skills", () => {
    // The Skill tool stays available and a skill body can carry inline `!`
    // commands, which no disallowedTools entry covers. Passed as a JSON string:
    // 0.3.258 stringifies the option with String(), so an object arrives as
    // "[object Object]" and the CLI refuses to start.
    const options = buildQueryOptions(base);
    assert.equal(typeof options.settings, "string");
    assert.deepEqual(JSON.parse(options.settings), {
      autoCompactWindow: 320_000,
      disableSkillShellExecution: true,
    });
  });

  test("the MCP auto-compact window is scoped to both permission modes", () => {
    for (const writable of [false, true]) {
      const options = buildQueryOptions({
        ...base,
        writable,
        parentEnv: {
          ...PARENT_ENV,
          CLAUDE_CODE_MCP_AUTO_COMPACT_WINDOW: "120000",
        },
      });
      assert.equal(JSON.parse(options.settings).autoCompactWindow, 120_000);
      assert.equal(
        options.env.CLAUDE_CODE_MCP_AUTO_COMPACT_WINDOW,
        undefined,
        "the server setting is not forwarded to the child",
      );
    }
  });

  test("off removes only the MCP override", () => {
    const readOnly = buildQueryOptions({
      ...base,
      parentEnv: {
        ...PARENT_ENV,
        CLAUDE_CODE_MCP_AUTO_COMPACT_WINDOW: "off",
      },
    });
    assert.deepEqual(JSON.parse(readOnly.settings), {
      disableSkillShellExecution: true,
    });

    const writable = buildQueryOptions({
      ...base,
      writable: true,
      parentEnv: {
        ...PARENT_ENV,
        CLAUDE_CODE_MCP_AUTO_COMPACT_WINDOW: "off",
      },
    });
    assert.equal(writable.settings, undefined);
  });

  test("invalid MCP auto-compact windows fail closed", () => {
    for (const value of ["300k", "99999", "1000001", "-1"]) {
      assert.throws(
        () =>
          resolveAutoCompactWindow({
            CLAUDE_CODE_MCP_AUTO_COMPACT_WINDOW: value,
          }),
        /must be "off" or an integer between 100000 and 1000000/,
        value,
      );
    }
  });

  test("writable mode bypasses permissions but keeps delegation blocked", () => {
    const options = buildQueryOptions({ ...base, writable: true });
    assert.equal(options.permissionMode, "bypassPermissions");
    // The SDK requires the acknowledgement flag alongside the mode.
    assert.equal(options.allowDangerouslySkipPermissions, true);
    assert.deepEqual(options.disallowedTools, ALWAYS_DISALLOWED_TOOLS);
    assert.deepEqual(JSON.parse(options.settings), {
      autoCompactWindow: 320_000,
    });
    for (const tool of ["Write", "Edit", "Bash", "TaskCreate"]) {
      assert.ok(!options.disallowedTools.includes(tool), `${tool} is allowed`);
    }
    assert.equal(
      options.canUseTool,
      undefined,
      "canUseTool is shadowed under bypassPermissions; the SDK warns when set",
    );
  });

  test("delegation, scheduling and messaging are blocked in both modes", () => {
    for (const writable of [false, true]) {
      const { disallowedTools } = buildQueryOptions({ ...base, writable });
      for (const tool of ALWAYS_DISALLOWED_TOOLS) {
        assert.ok(disallowedTools.includes(tool), `${tool} (writable=${writable})`);
      }
    }
  });

  test("the shipped bridge MCP servers are removed in both modes", () => {
    const bridgeSpecs = [
      "mcp__codex-agent__*",
      "mcp__plugin_codex_codex-agent__*",
      "mcp__claude-agent__*",
      "mcp__plugin_claude-code_claude-agent__*",
    ];
    for (const writable of [false, true]) {
      const { disallowedTools } = buildQueryOptions({ ...base, writable });
      for (const spec of bridgeSpecs) {
        assert.ok(disallowedTools.includes(spec), `${spec} (writable=${writable})`);
      }
    }
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
});

const BRIDGE_TOOLS = [
  "mcp__codex-agent__codex",
  "mcp__codex__reply",
  "mcp__claude-agent__claude",
  "mcp__claude-code-mcp__claude",
  "mcp__CLAUDE_CODE__claude",
  // Versioned decorations of the same bridge names.
  "mcp__claude_code_2__claude",
  "mcp__codex-agent-v2__codex",
];

const HOOK_PASSTHROUGH_TOOLS = [
  "mcp__logfire__query_run",
  // Plugin-normalized bridge identities are owned by the exact
  // disallowedTools specs; the hook must not guess their underscore boundary.
  "mcp__plugin_codex_codex-agent__codex",
  "mcp__plugin_claude-code_claude-agent__claude",
  // Near-misses: the bridge names are a whole server segment, not a prefix, so
  // an unrelated server that starts with one is not denied.
  "mcp__codexdb__query",
  "mcp__claude-agent-inbox__list",
  "mcp__plugin_foo_claude-agent-inbox__list",
];

describe("the fallback agent-bridge PreToolUse gate", () => {
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
      for (const tool of BRIDGE_TOOLS) {
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

    test(`the hook decides nothing else (writable=${writable})`, async () => {
      // A hook `allow` is terminal and would override the operator's own
      // permissions.deny rules. Everything but a bridge tool falls through to
      // the CLI's rule evaluation.
      const options = buildQueryOptions({ cwd: "/repo", writable });
      for (const tool of [...HOOK_PASSTHROUGH_TOOLS, "Read", "Bash"]) {
        const decision = await decide(options, tool);
        assert.equal(decision.hookSpecificOutput, undefined, tool);
        assert.equal(decision.continue, true, tool);
      }
    });
  }
});

describe("the read-only permission callback", () => {
  const callback = () => buildQueryOptions({ cwd: "/repo" }).canUseTool;

  test("MCP tools from the operator's configuration are approved", async () => {
    for (const tool of HOOK_PASSTHROUGH_TOOLS) {
      const decision = await callback()(tool, { a: 1 }, {});
      assert.equal(decision.behavior, "allow", tool);
      assert.deepEqual(decision.updatedInput, { a: 1 });
    }
  });

  test("a bridge tool is denied here too", async () => {
    for (const tool of BRIDGE_TOOLS) {
      const decision = await callback()(tool, {}, {});
      assert.equal(decision.behavior, "deny", tool);
      assert.equal(decision.message, BRIDGE_DENY_MESSAGE);
    }
  });

  test("anything else asking for a grant is denied, not left hanging", async () => {
    // The callback only runs when the CLI needs a decision the operator's own
    // rules did not make — headless there is nobody to ask.
    const decision = await callback()("WebFetch", {}, {});
    assert.equal(decision.behavior, "deny");
    assert.match(decision.message, /not pre-approved/);
  });

  // The exact reason string the pinned CLI attaches to the out-of-tree gate,
  // as captured from a real permission request in the tier-2 suite.
  const GATE = { decisionReason: "Path is outside allowed working directories" };

  test("the built-in read tools are approved at the out-of-tree gate", async () => {
    // An out-of-tree Read/Glob/Grep raises a permission request the operator's
    // rules did not decide; the visibility contract says approve it.
    for (const tool of ["Read", "Glob", "Grep"]) {
      const input = { file_path: "/somewhere/else/entirely" };
      const decision = await callback()(tool, input, GATE);
      assert.equal(decision.behavior, "allow", tool);
      assert.deepEqual(decision.updatedInput, input, tool);
    }
  });

  test("a read tool asking for any other reason is denied", async () => {
    // An ask-forced request arrives with no `decisionReason` at all; a future
    // tool-own reason (a safety check, say) deserves deny-by-default too.
    for (const context of [{}, { decisionReason: "safety check tripped" }]) {
      const decision = await callback()("Read", {}, context);
      assert.equal(decision.behavior, "deny", JSON.stringify(context));
      assert.equal(decision.message, UNGRANTED_DENY_MESSAGE);
    }
  });

  test("a matchedAskRule request is denied even with the gate reason", async () => {
    // The CLI populates `matchedAskRule` when an ask rule coincides with a
    // tool-own decisionReason (tier 2 pins the real-CLI case: a bare `Read`
    // ask rule on an out-of-tree read). The branch must outrank the gate
    // approval — this is what keeps an ask-ruled out-of-tree read a human
    // decision. Ask requests with no other reason arrive unmarked and are
    // covered by the generic-deny test above; an ask rule on an MCP tool is
    // NOT honored (its request is indistinguishable from an unruled one).
    for (const tool of ["Read", "mcp__github__get_issue"]) {
      const decision = await callback()(
        tool,
        {},
        { ...GATE, matchedAskRule: { source: "userSettings", toolName: tool } },
      );
      assert.equal(decision.behavior, "deny", tool);
      assert.equal(decision.message, ASK_RULE_DENY_MESSAGE, tool);
    }
  });

  test("a bridge tool is denied even when an ask rule matched", async () => {
    const decision = await callback()(
      "mcp__codex__codex",
      {},
      { matchedAskRule: { source: "userSettings", toolName: "mcp__codex__codex" } },
    );
    assert.equal(decision.behavior, "deny");
    assert.equal(decision.message, BRIDGE_DENY_MESSAGE);
  });
});
