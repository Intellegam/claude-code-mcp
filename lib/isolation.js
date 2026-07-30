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
 *   - nested-session env markers and the transport/credential unit, which
 *     change CLI behaviour or move the consultation elsewhere (below);
 *   - agent-bridge MCP servers. The operator's plugins almost certainly include
 *     one — codex-mcp is what calls *this* server — and a consulted Claude that
 *     can call Codex back closes a recursion loop. Hence the PreToolUse hook.
 *
 * Nothing here ever *widens* what the operator granted themselves: the deny
 * hook is terminal, and the read-only `canUseTool` only answers requests the
 * operator's own rules left open.
 */

/**
 * Env vars never inherited by the child.
 *
 * `CLAUDECODE` and `CLAUDE_CODE_*` are nested-session markers that change CLI
 * behaviour.
 *
 * The Anthropic entries are one unit: a transport override plus the credentials
 * that belong to it. `ANTHROPIC_BASE_URL` and `ANTHROPIC_UNIX_SOCKET` point the
 * consultation at another backend; `ANTHROPIC_AUTH_TOKEN` and
 * `ANTHROPIC_CUSTOM_HEADERS` are that backend's credential (the latter can
 * carry an `Authorization` header outright). They are dropped *together* on
 * purpose — forwarding a gateway credential while dropping the gateway address
 * would send it to the default endpoint instead. `ANTHROPIC_API_KEY` is bound
 * to the default endpoint and is kept, like the rest of the environment: proxy
 * settings, CA bundles and the host's own credentials keep working.
 *
 * A gateway operator configures the destination in a settings file rather than
 * the environment, and settings load in full (`settingSources` is unset), so
 * that deployment is unaffected.
 *
 * Keys are matched upper-cased: Windows environments are case-insensitive, so
 * `Anthropic_Base_Url` is the same variable.
 */
const ENV_DENY_EXACT = new Set([
  "CLAUDECODE",
  "ANTHROPIC_BASE_URL",
  "ANTHROPIC_UNIX_SOCKET",
  "ANTHROPIC_AUTH_TOKEN",
  "ANTHROPIC_CUSTOM_HEADERS",
]);
const ENV_DENY_PREFIX = "CLAUDE_CODE_";
/**
 * Kept despite the prefix: the OAuth token is a supported headless/CI
 * credential, and the Bedrock/Vertex switches select the operator's own
 * backend — a consultation should run where the operator's Claude runs.
 */
const ENV_PREFIX_EXCEPTIONS = new Set([
  "CLAUDE_CODE_OAUTH_TOKEN",
  "CLAUDE_CODE_USE_BEDROCK",
  "CLAUDE_CODE_USE_VERTEX",
]);

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
 * in the 0.3.220 tool surface, which is wider than delegation alone:
 * `DesignSync`, `Projects` and `Artifact` publish or upload workspace content
 * to a hosted surface, which `writable` does not authorize either — it covers
 * edits in the caller's repo, not publication of what the consultation read.
 *
 * `AskUserQuestion`, `EnterPlanMode` and `ExitPlanMode` need a human at the
 * other end. *Verified:* the CLI starts offering them as soon as a
 * permission-prompt host is present (read-only's `canUseTool`), and a call
 * would stall the turn until its timeout, since this wrapper answers
 * permission requests but has no user to put a question to.
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
  "DesignSync",
  "Projects",
  "Artifact",
  "AskUserQuestion",
  "EnterPlanMode",
  "ExitPlanMode",
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
 *
 * `TaskCreate`, `TaskUpdate` and `TaskStop` mutate session state; the reading
 * half of that family (`TaskGet`, `TaskList`, `TaskOutput`) stays.
 */
export const READ_ONLY_DISALLOWED_TOOLS = [
  "Write",
  "Edit",
  "NotebookEdit",
  "Bash",
  "Monitor",
  "REPL",
  "TaskCreate",
  "TaskUpdate",
  "TaskStop",
  ...ALWAYS_DISALLOWED_TOOLS,
];

/**
 * Flag-layer settings applied in read-only mode.
 *
 * The `Skill` tool stays available, and a skill body may carry inline `!`
 * shell commands that the CLI executes when the skill is loaded — outside the
 * `Bash`/`Monitor`/`REPL` tools `disallowedTools` removes. This setting
 * replaces those commands with a placeholder instead of running them.
 *
 * *Verified:* it must be passed as a JSON **string**. The SDK types accept an
 * inline `Settings` object, but 0.3.220 forwards the value through
 * `String(value)` into `--settings`, so an object arrives as
 * `[object Object]` and the CLI exits with "Settings file not found". A JSON
 * string is recognized as inline settings (the CLI checks for a leading `{`).
 *
 * These land in the "flag settings" layer — highest priority among
 * user-controlled settings, and merged key-by-key, so the operator's own
 * settings files still load.
 */
const READ_ONLY_SETTINGS = JSON.stringify({
  disableSkillShellExecution: true,
});

/**
 * MCP servers that would let the consulted agent call an agent back.
 *
 * Matched against the `mcp__<server>__<tool>` name, so it covers every tool of
 * a bridge server. The whole server segment has to be a bridge name — `codex`
 * or `claude`, optionally decorated with `-code`/`-agent`/`-mcp` and a version
 * suffix (`claude_code_2`, `codex-agent-v2`) — and the trailing `__` is what
 * makes that a boundary rather than a prefix: an unrelated `mcp__codexdb__*`
 * or `mcp__claude-agent-inbox__*` must not be caught. Every other MCP server is
 * allowed on purpose — they are part of the environment the operator already
 * works in.
 */
export const AGENT_BRIDGE_PATTERN =
  /^mcp__(codex|claude)(?:[-_](?:code|agent|mcp))*(?:[-_]v?\d+)*__/i;

export const BRIDGE_DENY_MESSAGE =
  "Agent-bridge MCP servers are not available in this consultation";

export const UNGRANTED_DENY_MESSAGE =
  "This consultation cannot grant permissions interactively; the tool was not pre-approved";

/**
 * The recursion guard: a `PreToolUse` hook that denies agent-bridge tools.
 *
 * It is a hook rather than `canUseTool` because hooks run in *every* permission
 * mode and their denies are terminal. `canUseTool` is never invoked under
 * `bypassPermissions` (the SDK auto-approves first and warns about the
 * shadowing), which is exactly the writable mode this wrapper uses — a
 * `canUseTool` deny would have been silently inert there.
 *
 * Denying is *all* it does. A hook `allow` is terminal too, and would override
 * the operator's own `permissions.deny` rules: this wrapper must not hand the
 * consulted agent more than the operator granted themselves. Approving the
 * remaining MCP tools is `canUseTool`'s job (below), because that callback runs
 * after rule evaluation.
 */
export function buildBridgeDenyHooks() {
  return {
    PreToolUse: [
      {
        hooks: [
          async (input) => {
            const toolName =
              typeof input?.tool_name === "string" ? input.tool_name : "";
            if (!AGENT_BRIDGE_PATTERN.test(toolName)) return { continue: true };
            return {
              continue: true,
              hookSpecificOutput: {
                hookEventName: "PreToolUse",
                permissionDecision: "deny",
                permissionDecisionReason: BRIDGE_DENY_MESSAGE,
              },
            };
          },
        ],
      },
    ],
  };
}

/**
 * The read-only permission handler.
 *
 * Read-only mode sets no `permissionMode`, so a tool with no matching rule
 * raises a permission request — and headless there is nobody to answer it. The
 * callback answers instead: an MCP tool from the operator's own configuration
 * is approved (they are part of the environment the operator already works in),
 * and everything else is denied rather than left to hang.
 *
 * *Verified:* `canUseTool` runs only when the CLI actually needs a decision, so
 * `disallowedTools`, the operator's `permissions.deny`/`allow` rules and the
 * bridge hook have all been applied first. A deny rule short-circuits without
 * reaching this callback, which is the point: the operator's settings keep
 * precedence over this wrapper.
 *
 * Not installed in writable mode: `bypassPermissions` auto-approves and the SDK
 * warns that the callback is shadowed.
 */
export function buildReadOnlyPermissionCallback() {
  return async (toolName, input) => {
    const name = typeof toolName === "string" ? toolName : "";
    // The hook has already denied this one; saying so again costs nothing and
    // keeps the callback honest on its own.
    if (AGENT_BRIDGE_PATTERN.test(name)) {
      return { behavior: "deny", message: BRIDGE_DENY_MESSAGE };
    }
    if (name.startsWith("mcp__")) {
      return { behavior: "allow", updatedInput: input ?? {} };
    }
    return { behavior: "deny", message: UNGRANTED_DENY_MESSAGE };
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
 * key — a real credential is never forwarded to a test endpoint. The rest of
 * the credential unit (`ANTHROPIC_AUTH_TOKEN`, `ANTHROPIC_CUSTOM_HEADERS`) is
 * already gone by then, for every child. It is never read from tool arguments.
 */
export function buildChildEnv(parentEnv = process.env) {
  const env = {};
  for (const [key, value] of Object.entries(parentEnv)) {
    if (value == null) continue;
    // Windows environment variables are case-insensitive, so the denylist has
    // to be too: `Anthropic_Base_Url` is `ANTHROPIC_BASE_URL`.
    const name = key.toUpperCase();
    if (ENV_DENY_EXACT.has(name)) continue;
    if (name.startsWith(ENV_DENY_PREFIX) && !ENV_PREFIX_EXCEPTIONS.has(name)) {
      continue;
    }
    env[key] = value;
  }

  const testBaseUrl = parentEnv.CLAUDE_CODE_MCP_TEST_BASE_URL;
  if (testBaseUrl) {
    // The test endpoint has to be the *only* backend the child can reach, with
    // the dummy key as its only credential. Every prefix exception would bypass
    // that: the OAuth token is a real credential, and the Bedrock/Vertex
    // switches make the CLI ignore `ANTHROPIC_BASE_URL` and talk to the
    // operator's cloud backend instead. A parent's own `ANTHROPIC_API_KEY`
    // goes too — under a casing like `Anthropic_Api_Key` it would sit beside
    // the dummy key and win the case-insensitive collision on Windows.
    // Stripped case-insensitively, and over the keys actually present, for the
    // same Windows reason as the denylist — `env` still carries the parent's
    // own casing.
    for (const key of Object.keys(env)) {
      const name = key.toUpperCase();
      if (ENV_PREFIX_EXCEPTIONS.has(name) || name === "ANTHROPIC_API_KEY") {
        delete env[key];
      }
    }
    env.ANTHROPIC_BASE_URL = testBaseUrl;
    env.ANTHROPIC_API_KEY = "sk-ant-mcp-test";
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
  if (writable) {
    options.permissionMode = "bypassPermissions";
    // Required alongside it: the SDK treats the flag as the explicit
    // acknowledgement that permissions are being skipped.
    options.allowDangerouslySkipPermissions = true;
  } else {
    options.settings = READ_ONLY_SETTINGS;
    options.canUseTool = buildReadOnlyPermissionCallback();
  }
  if (resume) options.resume = resume;

  return options;
}
