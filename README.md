# Claude Code MCP Server

An MCP server that lets another AI agent — typically OpenAI Codex — consult
Claude Code for a second opinion, plan validation, or code review.

It is the directional counterpart of
[`codex-mcp`](https://github.com/Intellegam/codex-mcp), which points the other
way; their public execution contracts are independent.

## How it works

1. Speaks the MCP JSON-RPC protocol over stdio.
2. Runs each turn as a Claude Code session through the
   [Claude Agent SDK](https://www.npmjs.com/package/@anthropic-ai/claude-agent-sdk),
   with the operator's own configuration — the consulted agent sees what you
   would see.

## Prerequisites

- Node.js 20.11 or higher
- Working Claude Code authentication (an `ANTHROPIC_API_KEY` or
  `CLAUDE_CODE_OAUTH_TOKEN` in the environment, or a host already logged in via
  Claude Code — the credentials in `~/.claude` are reachable because the child
  inherits your environment)

The Claude Code CLI itself ships with the SDK dependency; nothing else to
install.

## Installation

### For Codex users (`~/.codex/config.toml`)

```toml
[mcp_servers.claude-agent]
command = "npx"
args = ["-y", "github:Intellegam/claude-code-mcp#v0.2.1"]
```

Or from a local checkout:

```toml
[mcp_servers.claude-agent]
command = "node"
args = ["/absolute/path/to/claude-code-mcp/server.js"]
```

Restart Codex and the four `claude*` tools appear.

### For any other MCP client

Run `node server.js` as a stdio MCP server. Tools are namespaced under whatever
server name the client is configured with.

## Tools

### `claude` — start a new session

```
// Returns once Claude initializes; the answer continues in the background
claude({ prompt: "Does this plan handle the retry case?", cwd: "/path/to/repo" })
// → { sessionId: "e0dbaa09-…", status: "running", done: false }

// Allow edits and commands (scope it in the prompt)
claude({ prompt: "Fix the failing test in tests/test_auth.py", cwd: "/repo", writable: true })
```

Parameters: `prompt` (required), `cwd`, `writable` (default false).

Pass `cwd` — it is the repo Claude reads, and the CLI loads that repo's own
configuration and `CLAUDE.md` from there.

The submission waits for Claude's initialization handshake (normally about
0.3–3 seconds, with a 30-second safety bound). This makes the stable native
`sessionId` available and surfaces startup failures before the tool call
returns; it does not wait for Claude's answer. A startup that misses the bound
is stopped and returns an actionable tool error.

### `claude-reply` — continue a session

```
claude-reply({ sessionId: "e0dbaa09-…", prompt: "What about the timeout path?", cwd: "/path/to/repo" })
```

Parameters: `sessionId` (required), `prompt` (required), `cwd`.

Resume is keyed by session id **and** cwd, so pass the same `cwd` the session was
created with. While the server retains the session record, the engine rejects a
mismatch before the CLI starts. After a server restart, persisted SDK metadata
is used to verify the requested cwd before the resumed query starts.

A follow-up inherits the permission level recorded for the session and cannot
ask for more: `claude-reply` has no `writable` parameter. A server restart drops
that memory, so a reply to a session it no longer knows is **read-only** — start
a new `claude` session if you need write access again.

### `claude-result` — poll for the latest turn

```
claude-result({ sessionId: "e0dbaa09-…" })
```

Returns the latest turn's snapshot: `status`, `done`, `output`, `model`,
`error`, `elapsed`, and two passive diagnostics. It returns immediately.

- `contextTokens`: latest observed model request's input tokens, including
  cache-write and cache-read input; `null` until observed. Excludes output and
  is not exact post-turn context fullness.
- `compactedThisTurn`: whether a `compact_boundary` was observed in this turn.

Both reset on each reply. Neither measures cache freshness or subscription usage.

### `claude-cancel` — cancel the active turn

```
claude-cancel({ sessionId: "e0dbaa09-…" })
```

Sends an interrupt if a turn is in flight; otherwise returns the current state
unchanged. For a reply, the existing session ID can cancel even before that
turn initializes. A fresh `claude` request has no session ID before init, so its
MCP request itself must be cancelled in that window.

### Failures

A tool call that fails answers with a normal result marked `isError`, carrying
the message as text — the calling model reads the failure instead of losing it.
JSON-RPC error codes are reserved for requests the server could not act on at
all: `-32602` for an unknown tool, `-32601`/`-32600`/`-32700` for bad envelopes.

## Session lifecycle

All Claude turns are asynchronous after initialization. Use the same stable
native `sessionId` to inspect, continue, or cancel the conversation.

```
claude({ prompt: "Complex analysis task", cwd: "/repo" })
// → { sessionId: "e0dbaa09-…", status: "running", done: false }

claude-result({ sessionId: "e0dbaa09-…" })
// → { sessionId: "e0dbaa09-…", status: "succeeded", output: "…", done: true }

claude-reply({ sessionId: "e0dbaa09-…", prompt: "follow-up", cwd: "/repo" })
claude-cancel({ sessionId: "e0dbaa09-…" })
```

`sessionId` is the only identifier; it works across `claude-reply`,
`claude-result` and `claude-cancel`.

Turn states: `starting` → `running` → `succeeded` | `failed` | `cancelled` |
`timed_out` (with a transient `cancelling`).

Multiple sessions run in parallel and are independent. Within one session, only
one turn may be active at a time.

Start a fresh session at a meaningful task or topic boundary; use
`claude-reply` only when the follow-up benefits from exact conversational
continuity. Include a short handoff when the new session needs prior
conclusions. The server never makes that semantic decision automatically.

## What the consulted Claude can see and do

**It runs as your own Claude Code.** User, project and local settings all load:
memory files, hooks, skills, plugins and MCP servers. The trade is a wider tool
surface than a sealed sandbox, and the startup cost of your MCP servers on every
turn — in exchange the consultation has the context and tooling you do.

That includes the **model**: consultations use your `model` setting
(`~/.claude/settings.json` or project settings) or an inherited
`ANTHROPIC_MODEL` env var, else the CLI default — whatever an interactive
client did or didn't persist there. The result snapshot's `model` field tells
you what a turn actually ran.

Read-only is the default: no `Write`, `Edit`, `NotebookEdit`, `Bash`, `Monitor`,
`REPL` or `TaskCreate`/`TaskUpdate`/`TaskStop`, and inline `!` shell commands in
skills are disabled too. Delegation, scheduling, worktree switching, messaging,
publishing and interactive tools (`Task`/`Agent`, `Workflow`, `Cron*`,
`ScheduleWakeup`, `RemoteTrigger`, `Brief`, `SendUserMessage`, `SendMessage`,
`SendFeedback`,
`PushNotification`, `Enter/ExitWorktree`, `DesignSync`, `Projects`, `Artifact`,
`AskUserQuestion`, `Enter/ExitPlanMode`) are blocked in **both** modes.
`writable: true` adds the file and shell tools and runs without permission
prompts — scope it explicitly in the prompt.

Read-only restricts *mutation through Claude Code's built-in tools*, not
visibility, and not your non-bridge MCP servers: `Read`, `Glob` and `Grep` work
outside `cwd` (out-of-tree permission requests are auto-approved), and the
non-bridge MCP tools your configuration provides stay available in both modes
and may have side effects of their own. Be aware what that delegates: anything your Claude Code
can read, the consultation can read — and what it reads may flow back into the
*calling agent's* transcript. That second hop is part of the trust boundary.

Your own permission rules still decide — with one asymmetry to know about.
**`deny` is the hard guarantee**: a `permissions.deny` rule is respected even
for the reads and MCP tools this wrapper otherwise approves, including inside
`Grep`/`Glob` sweeps, and it holds in writable mode too. **`ask` is
best-effort**: in read-only mode a direct read of an ask-ruled file is denied
rather than auto-approved (headless, there is no human to ask) — but an ask
rule cannot be honored on MCP tools (the CLI surfaces their forced requests
indistinguishably from unruled ones), a `Grep` sweep still discloses an
ask-ruled file's contents, and writable mode bypasses ask rules entirely. Use
`deny` for anything that must hold.

The one thing always denied is an **agent-bridge MCP server**. The shipped
manual and plugin-normalized bridge identities are removed from the model's
tool schema with `disallowedTools`; a `PreToolUse` deny hook catches aliases
such as `mcp__codex__*` or versioned bridge names. A consulted Claude calling
Codex back would otherwise close a Codex → Claude → Codex loop. The exact
matching rule is in DESIGN.md → Trust model.

The child's environment is your environment minus `CLAUDECODE` and
`CLAUDE_CODE_*` (nested-session markers that change CLI behaviour;
`CLAUDE_CODE_OAUTH_TOKEN` and the `CLAUDE_CODE_USE_BEDROCK`/
`CLAUDE_CODE_USE_VERTEX` backend switches are kept) and minus the
transport/credential unit
`ANTHROPIC_BASE_URL`, `ANTHROPIC_UNIX_SOCKET`, `ANTHROPIC_AUTH_TOKEN` and
`ANTHROPIC_CUSTOM_HEADERS` — a gateway credential must not outlive the gateway
address it belongs to. `ANTHROPIC_API_KEY` is kept, and a gateway configured
through a settings file keeps working.

## Configuration

| Environment variable                  | Default            | Description                                                         |
| ------------------------------------- | ------------------ | ------------------------------------------------------------------- |
| `CLAUDE_INIT_TIMEOUT_MS`              | `30000` (30s)      | Initialization wait; may be lowered, capped at 30s                   |
| `CLAUDE_TIMEOUT_MS`                   | `1800000` (30 min) | Maximum time for one turn                                            |
| `CLAUDE_CANCEL_WATCHDOG_MS`           | `30000` (30s)      | How long to wait after an interrupt before forcing                   |
| `CLAUDE_CODE_MCP_AUTO_COMPACT_WINDOW` | `320000` tokens    | MCP-only window, 100k–1M; `off` leaves the operator/CLI policy alone |

The auto-compact window is passed in the CLI's flag-settings layer for both
permission modes, so it overrides an operator file's value only for sessions
started through this MCP. It is a context-quality guardrail, not a claimed
subscription-cost optimization. The CLI owns the actual trigger and may clamp
the window to the serving model; the configured window is not a hard token cap.
Auto-compaction can occur mid-task and summarize evidence still in use. Set a
larger window or `off` if retaining that history is more important for your work.

## Development

```bash
npm test              # tier 1: fast, mocked SDK
npm run test:integration  # tier 2: real CLI against a mock Anthropic API
npm run test:smoke    # tier 3: real model, needs CLAUDE_CODE_MCP_SMOKE=1
npm run check         # node --check over the sources

node test/send.js claude "prompt"                  # try it by hand
node test/send.js claude-reply <sessionId> "prompt"
```

See [DESIGN.md](./DESIGN.md) for the architecture, the SDK mechanics the runner
depends on, and the terminal-state precedence rules.
