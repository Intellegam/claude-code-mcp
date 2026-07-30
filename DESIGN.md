# claude-code-mcp — design

The mirror image of [`codex-mcp`](https://github.com/Intellegam/codex-mcp): that
server lets Claude Code consult OpenAI Codex; this one lets Codex (or any MCP
client) consult Claude Code as a second-opinion agent.

The layout, the tools and the environment variables are described in
[README.md](./README.md) and [CLAUDE.md](./CLAUDE.md). This file covers only
what is not obvious from the code: the SDK mechanics the runner depends on, the
order events are resolved in, and the trust model.

Everything marked *verified* was established empirically against
`@anthropic-ai/claude-agent-sdk@0.3.220` and its bundled CLI 2.1.x.

The turn/session engine is ported from codex-mcp: turn records, session records,
the one-active-turn guard, the cancel watchdog, terminal states and snapshot
shapes are all the same. What is dropped is codex-mcp's app-server connection
layer: there is no persistent Claude daemon. Each turn spawns its own CLI child
through the SDK, and continuity comes from `resume`.

## The runner

Per turn the runner calls `query()` with a **hold-open AsyncIterable prompt**: it
yields exactly one user message and then awaits a promise the runner resolves
only once the turn has settled.

> *Verified:* if the prompt iterable completes, the SDK closes the child's stdin
> immediately and `interrupt()` silently becomes undeliverable — the turn can
> then never be cancelled. This is the single most important mechanic in the
> file.

- **`system/init`** marks initialization and carries the session id. It is
  emitted once per *turn*, not per session. The id it reports is authoritative:
  the engine adopts it even when it differs from the id being resumed.
- **Interrupt gating.** *Verified:* before init, `interrupt()` resolves but does
  nothing (a window of roughly 350ms for a fresh session, longer whenever the
  CLI start is slow). A cancel arriving in that window is buffered as
  `cancelPending` and sent exactly once when init is observed.
- **Result.** On a `result` message the runner settles the turn *first*, then
  releases the hold-open promise — releasing closes stdin and can make the
  iterator throw.
- *Verified:* a successful interrupt produces `subtype:
  "error_during_execution"` with `terminal_reason: "aborted_streaming"`, and the
  message iterator then **throws** (`Claude Code returned an error result:
  [ede_diagnostic]…`). That throw is suppressed when a terminal result was
  already observed; any earlier throw is a genuine failure.
- *Verified:* the SDK emits error results with no `errors[]` array at all, so
  every read of it is guarded.
- **stderr** is silent on healthy runs and is captured for error messages. A bad
  resume, for example, prints `No conversation found with session ID: …` with no
  init at all.
- **Force path** is `query.close()`. *Verified:* it resolves before the child is
  actually gone, so shutdown settles turns itself rather than waiting for the
  runner's `onDone`; the orphan finishes exiting within about a second of losing
  its stdin.
- **Resume is keyed by session id *and* cwd.** *Verified:* resume preserves the
  session id, works after an interrupted turn and across server restarts, but
  only from the same cwd — a mismatch surfaces as an error result with no init.

## Terminal-state precedence

When events race, the engine resolves them in this order:

1. An observed `result` beats an iterator throw. A throw after a result is
   suppressed entirely.
2. A **success** result wins over a pending cancel: the turn finished before the
   interrupt landed, and its answer is worth keeping. (This is a deliberate
   difference from codex-mcp, which maps "completed after interrupt sent" to
   `cancelled`.)
3. Cancel requested + **error** result → `cancelled`, or `timed_out` when the
   cancel came from the turn timeout. A turn timeout that arrives *after* a user
   cancel takes over the terminal state — it is the harder bound — without
   moving the watchdog's deadline later.
4. Stream ended with no result → `failed`, with an excerpt of the child's
   stderr; unless a cancel was pending, in which case the cancel reason wins.
5. Interrupt ignored for `CLAUDE_CANCEL_WATCHDOG_MS` → force `close()` and
   settle as `cancelled`/`timed_out`.

Every query and prompt stream is closed exactly once: `turn.cleanup` and
`runner.close()` are both idempotent, and cleanup runs on every terminal path.

## Trust model

A consultation runs as **the operator's own Claude Code**. `settingSources` is
left unset, so the CLI loads its normal user + project + local configuration:
memory files, settings, hooks, skills, plugins and MCP servers. The consulted
agent therefore sees what the operator would see, and repo contents are trusted
org code — the same position codex-mcp takes.

That is a deliberate trade. The accepted costs are a wider tool surface than a
sealed sandbox would have, and the startup cost of the operator's MCP servers on
every turn. What read-only mode restricts is *mutation through built-in tools*,
not visibility: cross-repo reading is intended and common, and MCP tools may
have side effects.

Two things are still taken away, because they break the arrangement rather than
serve it:

- **Nested-session env markers.** `CLAUDECODE` and `CLAUDE_CODE_*` change CLI
  behaviour when a Claude Code session spawns another; the child environment is
  the parent's minus those (plus `ANTHROPIC_BASE_URL`, which would silently
  redirect the consultation to another backend). `CLAUDE_CODE_OAUTH_TOKEN` is
  the one exception kept, as a supported headless credential.
- **Agent-bridge MCP servers.** The operator's plugins almost certainly include
  one — codex-mcp is what calls *this* server — and a consulted Claude that can
  call Codex back closes a recursion loop. Tool names matching
  `/^mcp__(codex|claude)(?:[-_](?:code|agent|mcp))*__/i` are denied in both
  permission modes; every other MCP tool is allowed. The trailing `__` matters:
  the whole server segment has to be a bridge name, so `mcp__codexdb__*` and
  `mcp__claude-agent-inbox__*` are not caught by it.

### Permission levels

| | read-only (default) | `writable: true` |
| --- | --- | --- |
| `permissionMode` | unset | `bypassPermissions` |
| removed tools | `Write`, `Edit`, `NotebookEdit`, `Bash`, `Monitor`, `REPL` + the always-blocked set | the always-blocked set |

Always blocked, in both modes: `Task`/`Agent` (init reports the first name, the
model sees the second), `Workflow`, `CronCreate`, `CronDelete`, `CronList`,
`ScheduleWakeup`, `RemoteTrigger`, `SendMessage`, `SendFeedback`,
`PushNotification`, `EnterWorktree`, `ExitWorktree`. `writable` authorizes edits
in the caller's repo — not delegation, not scheduled or backgrounded execution,
not moving the session to another working directory (which would also break
cwd-keyed resume), and not messaging.

*Verified:* `disallowedTools` removes tools from the schema entirely rather than
denying at call time; it propagates to subagents and beats on-disk allow rules,
including a project `permissions.allow`. `allowedTools` is deliberately left
unset so the read tools stay available without maintaining an allowlist against
every SDK release. `bypassPermissions` needs no extra flags headless, and the
read-only recipe never hangs on a permission prompt — a blocked tool comes back
as "No such tool available".

### Why the gate is a hook

*Verified:* `canUseTool` is **never invoked** under `bypassPermissions` — the SDK
auto-approves first and warns that the callback is shadowed. Since that is the
writable mode this wrapper uses, a `canUseTool` deny would have been silently
inert exactly where it mattered. A `PreToolUse` hook runs in every permission
mode, and its denies bypass `canUseTool` entirely, so it is the only gate.

The hook also *allows* non-bridge `mcp__*` tools: read-only mode sets no
`permissionMode`, and without an explicit allow the CLI leaves every MCP tool
stuck on an ungranted permission request.

> **Deviation from the original spec.** The spec's read-only list was
> `[Write, Edit, NotebookEdit, Bash, Task]`. Probing the 0.3.220 tool surface
> showed that leaves `Monitor` and `REPL` — whose own guidance is to run
> `until <check>; do sleep 2; done` and to evaluate JavaScript, i.e. shell
> bypasses — plus a set of delegation/scheduling/messaging tools that the spec's
> intent ("no writes, no shell, no subagents") clearly excludes. The list above
> is the spec's intent applied to the tool surface that actually exists; the
> tier-2 drift guard pins that surface so the next SDK bump has to be looked at.

## Known limitations

- Sessions are in-memory: after a restart, `claude-reply` needs an explicit `cwd`
  and falls back to read-only.
- An async submission blocks until `system/init` (~0.3–3s).
- A turn whose child never starts and never exits is only released by the turn
  timeout.
