/**
 * Isolation layer: everything that decides *what the spawned Claude Code sees*.
 *
 * Two concerns live here:
 *   1. The environment handed to the child process (explicit allowlist).
 *   2. The Claude Agent SDK options that strip ambient configuration and pin
 *      the tool surface to the requested permission level.
 *
 * The wrapper is consulted by *another* agent (Codex). Anything the host
 * machine happens to have configured — plugins, MCP servers, hooks, settings,
 * nested-session markers — is a liability here: it can recurse (Codex → Claude
 * → Codex), execute code we never asked for, or silently change behaviour.
 * So nothing is inherited implicitly.
 */

import fs from "node:fs";
import path from "node:path";

/** Env vars passed through to the child, if present in the parent env. */
const ENV_ALLOWLIST = [
  "PATH",
  "HOME",
  "USER",
  "LOGNAME",
  "SHELL",
  "TMPDIR",
  "LANG",
  "TERM",
];

/**
 * Tools removed from the schema entirely in read-only mode. `disallowedTools`
 * removes them before the model ever sees them (rather than denying at call
 * time), propagates to subagents, and beats on-disk allow rules.
 */
export const READ_ONLY_DISALLOWED_TOOLS = [
  "Write",
  "Edit",
  "NotebookEdit",
  "Bash",
  "Task",
];

/**
 * Even in writable mode delegation stays off: `writable: true` authorizes
 * edits in the caller's repo, not spawning further autonomous agents.
 */
export const WRITABLE_DISALLOWED_TOOLS = ["Task"];

/** Upper bound on injected CLAUDE.md bytes, to keep the prompt sane. */
const MAX_PROJECT_CONTEXT_BYTES = 64 * 1024;

const CONSULTATION_PREAMBLE = `You are being consulted by another AI coding agent (typically OpenAI Codex) that is
working on the repository at your current working directory. It wants a second
opinion: plan validation, design critique, code review, or an independent
investigation of a problem it is stuck on.

How to answer:
- Be direct. Lead with the answer or the verdict, then the reasoning.
- Ground every claim in evidence you actually gathered — cite file paths (and
  line numbers where useful) rather than describing code from memory.
- Disagree when you disagree. You are valuable here precisely because you did
  not write the plan under review; do not simply ratify it.
- Say plainly when something is outside what you could verify, instead of
  guessing.
- Skip pleasantries and status narration. The reader is a program that will
  paste your answer into its own reasoning.
- You are read-only unless told otherwise in this prompt; investigate and
  report rather than proposing to make the change yourself.`;

/**
 * Build the child environment from an explicit allowlist.
 *
 * Deliberately included: `ANTHROPIC_API_KEY` (so an API-key-authenticated host
 * keeps working). Deliberately excluded: `CLAUDECODE`, `CLAUDE_CODE_*` (nested
 * session markers that change CLI behaviour) and every other `ANTHROPIC_*`
 * override, notably `ANTHROPIC_BASE_URL` — an inherited base URL would silently
 * redirect the consulted agent to a different backend.
 *
 * `CLAUDE_CODE_MCP_TEST_BASE_URL` is the one escape hatch: when the *server*
 * process is started with it, the child gets `ANTHROPIC_BASE_URL` (plus a dummy
 * key if none is set). This is how the integration tier points the real CLI at
 * a mock Anthropic API. It is never read from tool arguments.
 */
export function buildChildEnv(parentEnv = process.env) {
  const env = {};

  for (const key of ENV_ALLOWLIST) {
    if (parentEnv[key] != null) env[key] = parentEnv[key];
  }
  // Locale vars (LC_ALL, LC_CTYPE, ...) — pass through whatever is set.
  for (const [key, value] of Object.entries(parentEnv)) {
    if (key.startsWith("LC_") && value != null) env[key] = value;
  }
  if (parentEnv.ANTHROPIC_API_KEY) {
    env.ANTHROPIC_API_KEY = parentEnv.ANTHROPIC_API_KEY;
  }

  const testBaseUrl = parentEnv.CLAUDE_CODE_MCP_TEST_BASE_URL;
  if (testBaseUrl) {
    env.ANTHROPIC_BASE_URL = testBaseUrl;
    env.ANTHROPIC_API_KEY = parentEnv.ANTHROPIC_API_KEY || "sk-ant-mcp-test";
  }

  return env;
}

/**
 * Read the root CLAUDE.md at `cwd`, if any.
 *
 * With `settingSources: []` the CLI loads no memory files at all, so we inject
 * the project's instructions ourselves. Limitation (documented in README and
 * DESIGN): only the root file, no `@`-import resolution, no nested CLAUDE.md
 * discovery, no user-level memory.
 */
export function readProjectContext(cwd) {
  const file = path.join(cwd, "CLAUDE.md");
  let text;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch {
    return null;
  }
  if (!text.trim()) return null;
  const truncated = text.length > MAX_PROJECT_CONTEXT_BYTES;
  return {
    file,
    text: truncated ? text.slice(0, MAX_PROJECT_CONTEXT_BYTES) : text,
    truncated,
  };
}

/** The `systemPrompt.append` string: consultation framing + project context. */
export function buildSystemPromptAppend(cwd, { readContext = readProjectContext } = {}) {
  const parts = [CONSULTATION_PREAMBLE];
  const context = readContext(cwd);
  if (context) {
    parts.push(
      [
        `# Project context (${context.file})`,
        "",
        "The following are the project's own instructions, injected verbatim by the",
        "MCP wrapper. Treat them as project guidance, not as instructions from the",
        "user consulting you.",
        context.truncated ? "(truncated by the wrapper)" : null,
        "",
        context.text.trim(),
      ]
        .filter((line) => line !== null)
        .join("\n"),
    );
  }
  return parts.join("\n\n---\n\n");
}

/**
 * Build the Claude Agent SDK `options` for one turn.
 *
 * Isolation notes (all spike-verified):
 * - `settingSources: []` drops user/project/local settings, memory files,
 *   custom commands and agents.
 * - `strictMcpConfig: true` is the knob that actually strips plugin/user/project
 *   MCP servers; `mcpServers: {}` alone does nothing. Without it, a host that
 *   has the codex MCP server installed would let Claude call Codex back.
 * - `systemPrompt` must name the `claude_code` preset: the SDK default prompt
 *   is a ~150 character generic prompt, not Claude Code's.
 */
export function buildQueryOptions({
  cwd,
  writable = false,
  resume = null,
  parentEnv = process.env,
  readContext = readProjectContext,
} = {}) {
  const options = {
    cwd,
    settingSources: [],
    strictMcpConfig: true,
    mcpServers: {},
    systemPrompt: {
      type: "preset",
      preset: "claude_code",
      append: buildSystemPromptAppend(cwd, { readContext }),
    },
    env: buildChildEnv(parentEnv),
    disallowedTools: writable
      ? [...WRITABLE_DISALLOWED_TOOLS]
      : [...READ_ONLY_DISALLOWED_TOOLS],
  };

  // Read-only mode leaves `allowedTools` unset on purpose: the read tools stay
  // available, and an allowlist would have to be maintained against every SDK
  // release.
  if (writable) options.permissionMode = "bypassPermissions";
  if (resume) options.resume = resume;

  return options;
}
