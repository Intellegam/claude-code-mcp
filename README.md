# Claude Code MCP Server

An MCP server that lets another AI agent — typically OpenAI Codex — consult
Claude Code for a second opinion, plan validation, or code review.

It is the mirror image of [`codex-mcp`](https://github.com/Intellegam/codex-mcp),
which points the other way. Same contract, same async model, same session
semantics.

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
args = ["-y", "github:Intellegam/claude-code-mcp#v0.1.1"]
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
// Synchronous (blocks until Claude answers)
claude({ prompt: "Does this plan handle the retry case?", cwd: "/path/to/repo" })

// Asynchronous (returns a sessionId immediately)
claude({ prompt: "Review the auth module", cwd: "/path/to/repo", async: true })

// Allow edits and commands (scope it in the prompt)
claude({ prompt: "Fix the failing test in tests/test_auth.py", cwd: "/repo", writable: true })
```

Parameters: `prompt` (required), `cwd`, `writable` (default false), `async`
(default false).

Pass `cwd` — it is the repo Claude reads, and the CLI loads that repo's own
configuration and `CLAUDE.md` from there.

### `claude-reply` — continue a session

```
claude-reply({ sessionId: "e0dbaa09-…", prompt: "What about the timeout path?", cwd: "/path/to/repo" })
```

Parameters: `sessionId` (required), `prompt` (required), `cwd`, `async` (default
false).

Resume is keyed by session id **and** cwd, so pass the same `cwd` the session was
created with — always, if the server may have restarted. A mismatch fails with a
message telling you which cwd was tried.

A follow-up inherits the permission level recorded for the session and cannot
ask for more: `claude-reply` has no `writable` parameter. A server restart drops
that memory, so a reply to a session it no longer knows is **read-only** — start
a new `claude` session if you need write access again.

### `claude-result` — poll for the latest turn

```
claude-result({ sessionId: "e0dbaa09-…" })              // immediate check
claude-result({ sessionId: "e0dbaa09-…", wait: true })  // block until done
```

Returns the latest turn's snapshot: `status`, `done`, `output`, `error`,
`elapsed`, …

### `claude-cancel` — cancel the active turn

```
claude-cancel({ sessionId: "e0dbaa09-…" })
```

Sends an interrupt if a turn is in flight; otherwise returns the current state
unchanged. Safe to call at any time, including before the turn is fully up.

### Failures

A tool call that fails answers with a normal result marked `isError`, carrying
the message as text — the calling model reads the failure instead of losing it.
JSON-RPC error codes are reserved for requests the server could not act on at
all: `-32602` for an unknown tool, `-32601`/`-32600`/`-32700` for bad envelopes.

## Async mode

Use `async: true` when you have other work to do while Claude thinks. If you
would just poll in a loop, use sync (the default) instead.

```
claude({ prompt: "Complex analysis task", cwd: "/repo", async: true })
// → { sessionId: "e0dbaa09-…", status: "running", done: false }

claude-result({ sessionId: "e0dbaa09-…", wait: true })
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

## What the consulted Claude can see and do

**It runs as your own Claude Code.** User, project and local settings all load:
memory files, hooks, skills, plugins and MCP servers. The trade is a wider tool
surface than a sealed sandbox, and the startup cost of your MCP servers on every
turn — in exchange the consultation has the context and tooling you do.

Read-only is the default: no `Write`, `Edit`, `NotebookEdit`, `Bash`, `Monitor`,
`REPL` or `TaskCreate`/`TaskUpdate`/`TaskStop`, and inline `!` shell commands in
skills are disabled too. Delegation, scheduling, worktree switching, messaging,
publishing and interactive tools (`Task`/`Agent`, `Workflow`, `Cron*`,
`ScheduleWakeup`, `RemoteTrigger`, `SendMessage`, `SendFeedback`,
`PushNotification`, `Enter/ExitWorktree`, `DesignSync`, `Projects`, `Artifact`,
`AskUserQuestion`, `Enter/ExitPlanMode`) are blocked in **both** modes.
`writable: true` adds the file and shell tools and runs without permission
prompts — scope it explicitly in the prompt.

Read-only restricts *mutation through Claude Code's built-in tools*, not
visibility, and not your MCP servers: `Read`, `Glob` and `Grep` work outside
`cwd` (out-of-tree permission requests are auto-approved), and the MCP tools
your configuration provides stay available in both modes and may have side
effects of their own. Be aware what that delegates: anything your Claude Code
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

The one thing always denied is an **agent-bridge MCP server**
(`mcp__codex__*`, `mcp__codex-agent__*`, `mcp__claude-code-mcp__*`, …) — because
a consulted Claude calling Codex back would close a Codex → Claude → Codex loop.
The exact matching rule is in DESIGN.md → Trust model.

The child's environment is your environment minus `CLAUDECODE` and
`CLAUDE_CODE_*` (nested-session markers that change CLI behaviour;
`CLAUDE_CODE_OAUTH_TOKEN` is kept) and minus the transport/credential unit
`ANTHROPIC_BASE_URL`, `ANTHROPIC_UNIX_SOCKET`, `ANTHROPIC_AUTH_TOKEN` and
`ANTHROPIC_CUSTOM_HEADERS` — a gateway credential must not outlive the gateway
address it belongs to. `ANTHROPIC_API_KEY` is kept, and a gateway configured
through a settings file keeps working.

## Configuration

| Environment variable        | Default            | Description                                        |
| --------------------------- | ------------------ | -------------------------------------------------- |
| `CLAUDE_TIMEOUT_MS`         | `1800000` (30 min) | Maximum time for one turn                          |
| `CLAUDE_CANCEL_WATCHDOG_MS` | `30000` (30s)      | How long to wait after an interrupt before forcing  |

## Development

```bash
npm test              # tier 1: fast, mocked SDK
npm run test:integration  # tier 2: real CLI against a mock Anthropic API
npm run test:smoke    # tier 3: real model, needs CLAUDE_CODE_MCP_SMOKE=1
npm run check         # node --check over the sources

node test/send.js claude "prompt"                  # try it by hand
node test/send.js claude --async "prompt"
node test/send.js claude-reply <sessionId> "prompt"
```

See [DESIGN.md](./DESIGN.md) for the architecture, the SDK mechanics the runner
depends on, and the terminal-state precedence rules.
