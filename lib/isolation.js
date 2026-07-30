/**
 * Isolation layer: everything that decides *what the spawned Claude Code sees*.
 *
 * Two concerns live here:
 *   1. The environment handed to the child process (denylist).
 *   2. The Claude Agent SDK options that pin the tool surface to the requested
 *      permission level.
 *
 * The trust model is *the operator's own Claude Code*: `settingSources` is left
 * unset, so the CLI loads its normal user + project + local configuration —
 * memory files, settings, hooks, skills, plugins and MCP servers. A
 * consultation therefore sees the same environment the operator would.
 *
 * Two things are still taken away, because they break that arrangement rather
 * than serve it:
 *   - nested-session env markers, which change CLI behaviour (below);
 *   - agent-bridge MCP servers. The operator's plugins almost certainly include
 *     one — codex-mcp is what calls *this* server — and a consulted Claude that
 *     can call Codex back closes a recursion loop. Hence the PreToolUse hook.
 */

/**
 * Env vars never inherited by the child.
 *
 * `CLAUDECODE` and `CLAUDE_CODE_*` are nested-session markers that change CLI
 * behaviour; `ANTHROPIC_BASE_URL` would silently redirect the consulted agent
 * to a different backend. Everything else is inherited, so proxy settings, CA
 * bundles and the host's own credentials keep working.
 */
const ENV_DENY_EXACT = new Set(["CLAUDECODE", "ANTHROPIC_BASE_URL"]);
const ENV_DENY_PREFIX = "CLAUDE_CODE_";
/** Supported credential for headless/CI deployments — kept despite the prefix. */
const ENV_PREFIX_EXCEPTIONS = new Set(["CLAUDE_CODE_OAUTH_TOKEN"]);

/**
 * Tools blocked in *both* modes.
 *
 * `writable: true` authorizes edits in the caller's repo — not delegation to
 * further autonomous agents, not scheduled or backgrounded execution, not
 * moving the session to another working directory (which would also break
 * cwd-keyed resume), and not messaging anybody.
 *
 * `Task` is the name `system/init` reports for the delegation tool; `Agent` is
 * the name the model actually sees in CLI 2.1.x. Both are listed because
 * `disallowedTools` matches by name. The rest are the same class of capability
 * in the 0.3.220 tool surface, which is wider than delegation alone.
 */
export const ALWAYS_DISALLOWED_TOOLS = [
  "Task",
  "Agent",
  "Workflow",
  "CronCreate",
  "CronDelete",
  "CronList",
  "ScheduleWakeup",
  "RemoteTrigger",
  "SendMessage",
  "SendFeedback",
  "PushNotification",
  "EnterWorktree",
  "ExitWorktree",
];

/**
 * Tools removed on top of that in read-only mode. `disallowedTools` removes
 * them before the model ever sees them (rather than denying at call time),
 * propagates to subagents, and beats on-disk allow rules.
 *
 * `Monitor` and `REPL` are here because they execute code: Monitor's own
 * guidance tells the model to run `until <check>; do sleep 2; done`, and REPL
 * evaluates JavaScript. Without them, blocking `Bash` would not actually make
 * the session read-only.
 */
export const READ_ONLY_DISALLOWED_TOOLS = [
  "Write",
  "Edit",
  "NotebookEdit",
  "Bash",
  "Monitor",
  "REPL",
  ...ALWAYS_DISALLOWED_TOOLS,
];

/**
 * MCP servers that would let the consulted agent call an agent back.
 *
 * Matched against the `mcp__<server>__<tool>` name, so it covers every tool of
 * a bridge server. Every other MCP server is allowed on purpose — they are part
 * of the environment the operator already works in.
 */
export const AGENT_BRIDGE_PATTERN = /^mcp__(codex|claude[-_]?code)/i;

export const BRIDGE_DENY_MESSAGE =
  "Agent-bridge MCP servers are not available in this consultation";

/**
 * The single runtime authorization gate: a `PreToolUse` hook.
 *
 * It is a hook rather than `canUseTool` because hooks run in *every*
 * permission mode. `canUseTool` is never invoked under `bypassPermissions`
 * (the SDK auto-approves first and warns about the shadowing), which is
 * exactly the writable mode this wrapper uses — a `canUseTool` deny would have
 * been silently inert there.
 *
 * Two decisions, in order:
 *   - an agent-bridge tool is denied, in both modes (recursion guard);
 *   - any other `mcp__*` tool is allowed, because read-only mode has no
 *     `permissionMode` and the CLI would otherwise leave every MCP tool stuck
 *     on an ungranted permission request.
 * Built-in tools fall through to the CLI's own handling; the read-only surface
 * is already pinned by `disallowedTools`.
 */
export function buildBridgeDenyHooks() {
  return {
    PreToolUse: [
      {
        hooks: [
          async (input) => {
            const toolName =
              typeof input?.tool_name === "string" ? input.tool_name : "";
            if (!toolName.startsWith("mcp__")) return { continue: true };
            const bridged = AGENT_BRIDGE_PATTERN.test(toolName);
            return {
              continue: true,
              hookSpecificOutput: {
                hookEventName: "PreToolUse",
                permissionDecision: bridged ? "deny" : "allow",
                permissionDecisionReason: bridged
                  ? BRIDGE_DENY_MESSAGE
                  : "MCP servers in the operator's configuration are trusted",
              },
            };
          },
        ],
      },
    ],
  };
}

export const CONSULTATION_PREAMBLE = `You are being consulted by another AI coding agent (typically OpenAI Codex) that is
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
  report rather than proposing to make the change yourself.

Your tools: you have the operator's normal Claude Code environment, minus the
ability to delegate, schedule, message, or switch worktrees. Agent-bridge MCP
servers (Codex, other Claude Code servers) are deliberately unavailable — you
are the second opinion, so do not try to obtain another one.`;

/**
 * Build the child environment by removing the denied vars from the parent's.
 *
 * `CLAUDE_CODE_MCP_TEST_BASE_URL` on the *server* process is the one escape
 * hatch: the child gets `ANTHROPIC_BASE_URL` pointed at it, always with a dummy
 * key — a real credential is never forwarded to a test endpoint. It is never
 * read from tool arguments.
 */
export function buildChildEnv(parentEnv = process.env) {
  const env = {};
  for (const [key, value] of Object.entries(parentEnv)) {
    if (value == null) continue;
    if (ENV_DENY_EXACT.has(key)) continue;
    if (key.startsWith(ENV_DENY_PREFIX) && !ENV_PREFIX_EXCEPTIONS.has(key)) {
      continue;
    }
    env[key] = value;
  }

  const testBaseUrl = parentEnv.CLAUDE_CODE_MCP_TEST_BASE_URL;
  if (testBaseUrl) {
    env.ANTHROPIC_BASE_URL = testBaseUrl;
    env.ANTHROPIC_API_KEY = "sk-ant-mcp-test";
    delete env.CLAUDE_CODE_OAUTH_TOKEN;
  }

  return env;
}

/**
 * Build the Claude Agent SDK `options` for one turn.
 *
 * `settingSources` is deliberately absent: the CLI default (user + project +
 * local) is what gives the consultation the operator's own environment. The
 * accepted costs are a larger tool surface and the per-turn startup of whatever
 * MCP servers the operator has installed.
 *
 * *Verified:* `systemPrompt` must name the `claude_code` preset — the SDK's
 * default prompt is a ~150 character generic one, not Claude Code's.
 */
export function buildQueryOptions({
  cwd,
  writable = false,
  resume = null,
  parentEnv = process.env,
} = {}) {
  const options = {
    cwd,
    systemPrompt: {
      type: "preset",
      preset: "claude_code",
      append: CONSULTATION_PREAMBLE,
    },
    env: buildChildEnv(parentEnv),
    disallowedTools: writable
      ? [...ALWAYS_DISALLOWED_TOOLS]
      : [...READ_ONLY_DISALLOWED_TOOLS],
    hooks: buildBridgeDenyHooks(),
  };

  // Read-only mode leaves `allowedTools` unset on purpose: the read tools stay
  // available, and an allowlist would have to be maintained against every SDK
  // release.
  if (writable) options.permissionMode = "bypassPermissions";
  if (resume) options.resume = resume;

  return options;
}
