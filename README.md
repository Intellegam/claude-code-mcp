# Claude Code MCP Server

An MCP server that lets another AI agent — typically OpenAI Codex — consult
Claude Code for a second opinion, plan validation, or code review.

It is the mirror image of [`codex-mcp`](https://github.com/Intellegam/codex-mcp),
which points the other way. Same contract, same async model, same session
semantics.

## How it works

1. Speaks the MCP JSON-RPC protocol over stdio.
2. Runs each turn as an isolated Claude Code session through the
   [Claude Agent SDK](https://www.npmjs.com/package/@anthropic-ai/claude-agent-sdk)
   — no ambient plugins, MCP servers, hooks or settings are loaded, so a
   consulted Claude cannot call back into Codex.
3. Tracks sessions in memory and continues them through the SDK's `resume`,
   which also works after a restart.
4. Enforces a configurable turn timeout (default 30 minutes) and supports
   cancellation with a watchdog.
5. Supports async mode — return a sessionId immediately and poll for the result.

## Prerequisites

- Node.js 18 or higher
- Working Claude Code authentication (an `ANTHROPIC_API_KEY` in the environment,
  or a host already logged in via Claude Code — the credentials in `~/.claude`
  are reachable because `HOME` is passed through)

The Claude Code CLI itself ships with the SDK dependency; nothing else to
install.

## Installation

### For Codex users (`~/.codex/config.toml`)

```toml
[mcp_servers.claude-agent]
command = "npx"
args = ["-y", "github:Intellegam/claude-code-mcp"]
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

Pass `cwd` — it is the repo Claude reads, and the repo's root `CLAUDE.md` is
injected into the system prompt from there.

### `claude-reply` — continue a session

```
claude-reply({ sessionId: "e0dbaa09-…", prompt: "What about the timeout path?", cwd: "/path/to/repo" })
```

Resume is keyed by session id **and** cwd, so pass the same `cwd` the session was
created with — always, if the server may have restarted. A mismatch fails with a
message telling you which cwd was tried.

A follow-up inherits the permission level of the session (a session started with
`writable: true` stays writable, until the server restarts).

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

Read-only is the default: no `Write`, `Edit`, `NotebookEdit`, `Bash` or
`Monitor`. Delegation, scheduling, worktree switching and messaging tools
(`Task`, `Workflow`, `Cron*`, `ScheduleWakeup`, `SendMessage`,
`PushNotification`, `Enter/ExitWorktree`) are blocked in **both** modes.
`writable: true` adds the file and shell tools and runs without permission
prompts — scope it explicitly in the prompt.

The session is isolated from the host's configuration: no user, project or local
settings, no hooks, no custom commands or agents, and no MCP servers (which is
what stops a Codex → Claude → Codex loop). The environment is an explicit
allowlist, so nothing else in your shell leaks into the child.

Because settings are not loaded, the wrapper reads the root `CLAUDE.md` at `cwd`
itself and appends it to the system prompt. **Limitation:** only the root file —
no `@`-import resolution, no nested `CLAUDE.md`, no `~/.claude/CLAUDE.md`.

## Configuration

| Environment variable            | Default            | Description                                        |
| ------------------------------- | ------------------ | -------------------------------------------------- |
| `CLAUDE_TIMEOUT_MS`             | `1800000` (30 min) | Maximum time for one turn                          |
| `CLAUDE_CANCEL_WATCHDOG_MS`     | `30000` (30s)      | How long to wait after an interrupt before forcing  |
| `CLAUDE_CODE_MCP_QUERY_MODULE`  | —                  | Test hook: module exporting a `query()` to use      |
| `CLAUDE_CODE_MCP_TEST_BASE_URL` | —                  | Test hook: `ANTHROPIC_BASE_URL` for the child       |

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
