import test, { describe } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  buildChildEnv,
  buildQueryOptions,
  buildSystemPromptAppend,
  readProjectContext,
} from "../../lib/isolation.js";
import { normalizeResult } from "../../lib/claude-runner.js";

const PARENT_ENV = {
  PATH: "/usr/bin",
  HOME: "/Users/tester",
  USER: "tester",
  LOGNAME: "tester",
  SHELL: "/bin/zsh",
  TMPDIR: "/tmp/",
  LANG: "en_US.UTF-8",
  LC_ALL: "en_US.UTF-8",
  LC_CTYPE: "UTF-8",
  TERM: "xterm-256color",
  ANTHROPIC_API_KEY: "sk-ant-real",
  ANTHROPIC_BASE_URL: "https://proxy.internal",
  ANTHROPIC_MODEL: "some-override",
  CLAUDECODE: "1",
  CLAUDE_CODE_ENTRYPOINT: "cli",
  CLAUDE_CODE_SSE_PORT: "1234",
  MY_SECRET_TOKEN: "hunter2",
  npm_config_registry: "https://registry.internal",
};

describe("child environment allowlist", () => {
  test("passes through the allowlisted vars only", () => {
    const env = buildChildEnv(PARENT_ENV);
    assert.equal(env.PATH, "/usr/bin");
    assert.equal(env.HOME, "/Users/tester");
    assert.equal(env.USER, "tester");
    assert.equal(env.SHELL, "/bin/zsh");
    assert.equal(env.LANG, "en_US.UTF-8");
    assert.equal(env.LC_ALL, "en_US.UTF-8");
    assert.equal(env.LC_CTYPE, "UTF-8");
    assert.equal(env.TERM, "xterm-256color");
    assert.equal(env.MY_SECRET_TOKEN, undefined);
    assert.equal(env.npm_config_registry, undefined);
  });

  test("keeps ANTHROPIC_API_KEY but drops every other ANTHROPIC_* override", () => {
    const env = buildChildEnv(PARENT_ENV);
    assert.equal(env.ANTHROPIC_API_KEY, "sk-ant-real");
    assert.equal(env.ANTHROPIC_BASE_URL, undefined);
    assert.equal(env.ANTHROPIC_MODEL, undefined);
  });

  test("drops nested-session markers", () => {
    const env = buildChildEnv(PARENT_ENV);
    assert.equal(env.CLAUDECODE, undefined);
    assert.equal(env.CLAUDE_CODE_ENTRYPOINT, undefined);
    assert.equal(env.CLAUDE_CODE_SSE_PORT, undefined);
  });

  test("the test hook injects a base URL and a key", () => {
    const env = buildChildEnv({
      PATH: "/usr/bin",
      CLAUDE_CODE_MCP_TEST_BASE_URL: "http://127.0.0.1:9999",
    });
    assert.equal(env.ANTHROPIC_BASE_URL, "http://127.0.0.1:9999");
    assert.ok(env.ANTHROPIC_API_KEY, "a dummy key is provided");
  });
});

describe("query options", () => {
  const base = { cwd: "/repo", parentEnv: PARENT_ENV, readContext: () => null };

  test("read-only mode removes the write tools and delegation", () => {
    const options = buildQueryOptions(base);
    assert.deepEqual(options.disallowedTools, [
      "Write",
      "Edit",
      "NotebookEdit",
      "Bash",
      "Task",
    ]);
    assert.equal(options.permissionMode, undefined);
    assert.equal(options.allowedTools, undefined, "read tools stay available");
  });

  test("writable mode bypasses permissions but keeps Task blocked", () => {
    const options = buildQueryOptions({ ...base, writable: true });
    assert.equal(options.permissionMode, "bypassPermissions");
    assert.deepEqual(options.disallowedTools, ["Task"]);
  });

  test("ambient configuration is stripped", () => {
    const options = buildQueryOptions(base);
    assert.deepEqual(options.settingSources, []);
    assert.equal(options.strictMcpConfig, true);
    assert.deepEqual(options.mcpServers, {});
    assert.equal(options.env.CLAUDECODE, undefined);
  });

  test("the claude_code preset is requested explicitly", () => {
    const options = buildQueryOptions(base);
    assert.equal(options.systemPrompt.type, "preset");
    assert.equal(options.systemPrompt.preset, "claude_code");
    assert.match(options.systemPrompt.append, /second\s+opinion/i);
  });

  test("resume is only set when asked for", () => {
    assert.equal(buildQueryOptions(base).resume, undefined);
    assert.equal(buildQueryOptions({ ...base, resume: "abc" }).resume, "abc");
  });
});

describe("project context injection", () => {
  test("the root CLAUDE.md is read and appended under a header", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ccmcp-ctx-"));
    try {
      fs.writeFileSync(
        path.join(dir, "CLAUDE.md"),
        "# Fixture\n\nMARKER-XYZZY: always say plugh.\n",
      );
      const context = readProjectContext(dir);
      assert.match(context.text, /MARKER-XYZZY/);
      assert.equal(context.truncated, false);

      const append = buildSystemPromptAppend(dir);
      assert.match(append, /# Project context/);
      assert.match(append, /MARKER-XYZZY/);
      assert.match(append, /second\s+opinion/i);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a missing or empty CLAUDE.md leaves just the preamble", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ccmcp-ctx-"));
    try {
      assert.equal(readProjectContext(dir), null);
      const append = buildSystemPromptAppend(dir);
      assert.doesNotMatch(append, /# Project context/);

      fs.writeFileSync(path.join(dir, "CLAUDE.md"), "   \n");
      assert.equal(readProjectContext(dir), null);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("result normalization", () => {
  test("a success result is not an error", () => {
    const result = normalizeResult({
      type: "result",
      subtype: "success",
      is_error: false,
      result: "done",
      errors: [],
    });
    assert.equal(result.isError, false);
    assert.equal(result.text, "done");
  });

  test("an error result without errors[] does not throw", () => {
    const result = normalizeResult({
      type: "result",
      subtype: "error_during_execution",
      is_error: true,
    });
    assert.equal(result.isError, true);
    assert.deepEqual(result.errors, []);
    assert.equal(result.text, "");
  });

  test("aborted interrupts are recognizable", () => {
    const result = normalizeResult({
      type: "result",
      subtype: "error_during_execution",
      is_error: true,
      terminal_reason: "aborted_streaming",
    });
    assert.equal(result.terminalReason, "aborted_streaming");
  });

  test("error objects and strings both become messages", () => {
    const result = normalizeResult({
      type: "result",
      subtype: "error_during_execution",
      is_error: true,
      errors: ["plain string", { message: "object error" }],
    });
    assert.deepEqual(result.errors, ["plain string", "object error"]);
  });
});
