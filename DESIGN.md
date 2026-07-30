# claude-code-mcp — design

The mirror image of [`codex-mcp`](https://github.com/Intellegam/codex-mcp): that
server lets Claude Code consult OpenAI Codex; this one lets Codex (or any MCP
client) consult Claude Code as a second-opinion agent.

Everything below that is marked *verified* was established empirically against
`@anthropic-ai/claude-agent-sdk@0.3.220` and its bundled CLI.

## Shape

```
server.js            MCP JSON-RPC over stdio, tool schemas, dispatch
lib/engine.js        turns, sessions, waiters, guards, watchdogs
lib/claude-runner.js SDK adapter — one runner per turn
lib/isolation.js     env allowlist, SDK options, CLAUDE.md injection
```

ESM, Node >= 18, one runtime dependency (`@anthropic-ai/claude-agent-sdk`,
pinned exactly — the recipes below depend on observed SDK behaviour, not on
documented API).

The turn/session engine is ported from codex-mcp: turn records, session records,
long-poll waiters, the one-active-turn guard, the cancel watchdog, terminal
states and snapshot shapes are all the same. What is dropped is codex-mcp's
app-server connection layer: there is no persistent Claude daemon. Each turn
spawns its own CLI child through the SDK, and continuity comes from `resume`.

## Tools

| Tool            | Arguments                                     |
| --------------- | --------------------------------------------- |
| `claude`        | `prompt` (req), `cwd`, `writable`, `async`     |
| `claude-reply`  | `sessionId` (req), `prompt` (req), `cwd`, `async` |
| `claude-result` | `sessionId` (req), `wait`                      |
| `claude-cancel` | `sessionId` (req)                              |

Sync calls return the output text plus a `[SESSION_ID: ...]` trailer. Async
submissions return the JSON snapshot: `sessionId`, `toolName`, `status`, `done`,
`createdAt`, `finishedAt`, `elapsed`, `cancelRequested`, `output`, `error`.

Turn states: `starting` → `running` → `succeeded` | `failed` | `cancelled` |
`timed_out`, with a transient `cancelling` between a cancel request and the
terminal state.

There is no `claude-review` tool: Claude Code has no equivalent of Codex's
review mode, and a review is just a prompt.

`CLAUDE_TIMEOUT_MS` (default 30 min) bounds a turn;
`CLAUDE_CANCEL_WATCHDOG_MS` (default 30s) bounds the wait after an interrupt.

## The runner

Per turn the runner calls `query()` with a **hold-open AsyncIterable prompt**: it
yields exactly one user message and then awaits a promise the runner resolves
only once the turn has settled.

> *Verified:* if the prompt iterable completes, the SDK closes the child's stdin
> immediately and `interrupt()` silently becomes undeliverable — the turn can
> then never be cancelled. This is the single most important mechanic in the
> file.

Turn state inside the runner: `starting → initialized → running → terminal`.

- **`system/init`** marks initialization and carries the session id. It is
  emitted once per *turn*, not per session.
- **Interrupt gating.** *Verified:* before init, `interrupt()` resolves but does
  nothing (a window of roughly 350ms for a fresh session, longer whenever the
  CLI start is slow). A cancel arriving in that window is buffered as
  `cancelPending` and sent exactly once when init is observed. After init it is
  sent straight through.
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
- **Force path** is `query.close()` (*verified:* reaps the child in ~1.5s).
  `interrupt()` is preferred over `abortController.abort()`, because abort emits
  no result message.

## Terminal-state precedence

When events race, the engine resolves them in this order:

1. An observed `result` beats an iterator throw. A throw after a result is
   suppressed entirely.
2. A **success** result wins over a pending cancel: the turn finished before the
   interrupt landed, and its answer is worth keeping. (This is a deliberate
   difference from codex-mcp, which maps "completed after interrupt sent" to
   `cancelled`.)
3. Cancel requested + **error** result → `cancelled`, or `timed_out` when the
   cancel came from the turn timeout.
4. Stream ended with no result → `failed`, with an excerpt of the child's
   stderr; unless a cancel was pending, in which case the cancel reason wins.
5. Interrupt ignored for `CLAUDE_CANCEL_WATCHDOG_MS` → force `close()` and
   settle as `cancelled`/`timed_out`.

Every query and prompt stream is closed exactly once: `turn.cleanup` and
`runner.close()` are both idempotent, and cleanup runs on every terminal path.

## Isolation

Common to every turn:

- `settingSources: []` — no user/project/local settings, memory files, custom
  commands or agents.
- `strictMcpConfig: true`, `mcpServers: {}` — *verified:* `mcpServers: {}` alone
  does nothing; `strictMcpConfig` is the knob that strips plugin/user/project MCP
  servers. Without it, a host with codex-mcp installed would let the consulted
  Claude call Codex back.
- `systemPrompt: { type: "preset", preset: "claude_code", append: … }` —
  *verified:* the SDK's default system prompt is ~150 characters, not Claude
  Code's ~28k preset. The preset is mandatory.
- `env`: an explicit allowlist (`PATH`, `HOME`, `USER`, `LOGNAME`, `SHELL`,
  `TMPDIR`, `LANG`, `LC_*`, `TERM`), plus `ANTHROPIC_API_KEY` when set. Nothing
  else is inherited — in particular not `CLAUDECODE` / `CLAUDE_CODE_*` (nested
  session markers) and not `ANTHROPIC_BASE_URL` or any other `ANTHROPIC_*`
  override.
- `CLAUDE_CODE_MCP_TEST_BASE_URL` on the *server* process is the one escape
  hatch: it passes `ANTHROPIC_BASE_URL` (plus a dummy key) to the child. That is
  how the integration tier points the real CLI at a mock API. It is never read
  from tool arguments.

### Permission levels

| | read-only (default) | `writable: true` |
| --- | --- | --- |
| `permissionMode` | unset | `bypassPermissions` |
| removed tools | `Write`, `Edit`, `NotebookEdit`, `Bash`, `Monitor` + the always-blocked set | the always-blocked set |

Always blocked, in both modes: `Task`, `Workflow`, `CronCreate`, `CronDelete`,
`ScheduleWakeup`, `SendMessage`, `PushNotification`, `EnterWorktree`,
`ExitWorktree`. `writable` authorizes edits in the caller's repo — not
delegation, not scheduled or backgrounded execution, not moving the session to
another working directory (which would also break cwd-keyed resume), and not
messaging.

`disallowedTools` removes tools from the schema entirely rather than denying at
call time; it propagates to subagents and beats on-disk allow rules.
`allowedTools` is deliberately left unset so the read tools stay available
without maintaining an allowlist against every SDK release.

*Verified:* `bypassPermissions` needs no extra flags headless, and the read-only
recipe never hangs on a permission prompt — a blocked tool comes back as
"No such tool available".

### Runtime tool policy

`buildToolPolicy({ writable })` returns the `canUseTool` callback installed in
both modes. Today it default-denies every tool whose name starts with `mcp__`
and allows everything else (which is already governed statically by
`disallowedTools` and `permissionMode`).

`strictMcpConfig` should keep MCP servers from loading at all, so this is a
belt-and-braces authorization boundary rather than the primary one — but
`disallowedTools` is a static list and cannot cover dynamically named
`mcp__<server>__<tool>` tools, so a static list alone could never be sufficient.
The policy is a function of the mode because it is the seam where a
deployment-level allowlist of per-server read/write tool patterns (MCP
passthrough for observability servers) will plug in.

> **Deviation from the original spec.** The spec's read-only list was
> `[Write, Edit, NotebookEdit, Bash, Task]`. Probing the 0.3.220 tool surface
> showed that leaves `Monitor` — whose own guidance tells the model to run
> `until <check>; do sleep 2; done` — i.e. a shell bypass, plus a set of
> delegation/scheduling/messaging tools that the spec's intent ("no writes, no
> shell, no subagents") clearly excludes. The list above is the spec's intent
> applied to the tool surface that actually exists.

### Project context

With `settingSources: []` the CLI loads no memory files, so the wrapper reads the
**root `CLAUDE.md` at the turn's cwd** itself and appends it to the system prompt
under a `# Project context` header, behind a short consultation preamble.

Limitations, by design: no `@`-import resolution, no nested `CLAUDE.md`
discovery, no user-level (`~/.claude/CLAUDE.md`) memory, 64 KB cap.

## Sessions and resume

The public `sessionId` is the SDK's `session_id`. Sessions live in an in-memory
map that records the cwd and the permission level of the session.

`claude-reply` always resumes from disk (`resume: sessionId`), whether or not the
session is known in memory — there is no long-lived process holding the
conversation. *Verified:* resume preserves the session id, works after an
interrupted turn, and works across server restarts — **but only from the same
cwd**, because cwd is part of Claude's on-disk session key. A cwd mismatch
surfaces as an error result with no init; the engine turns that into a failure
that names the cwd it tried and tells the caller to pass the original one.

Follow-ups inherit the permission level the session was created with, the way a
codex thread inherits its sandbox. After a server restart that memory is gone and
a reply is read-only unless `cwd` and a fresh `writable` session are used.

One active turn per session is enforced by the ported thread guard; a second
concurrent turn fails fast with `already has an active turn`.

Because a new session has no id until `system/init`, an async submission waits
for init (or a terminal state) before returning, so the caller always gets a
`sessionId` back.

## Tests

**Tier 1 — `npm test`** (fast, no SDK, no child process). The SDK's `query()` is
swapped for a scripted mock via `CLAUDE_CODE_MCP_QUERY_MODULE`, so the *real*
runner state machine is exercised. Covers the protocol surface, sync and async
completion, snapshot shapes, session mapping and resume options, the one-turn
guard, cancel before and after init, timeout, the cancel watchdog, the
interrupt-vs-completion race, error mapping (including results with no
`errors[]`), stderr surfacing, malformed tool arguments, and the isolation
layer's env/option/context construction.

**Tier 2 — `npm run test:integration`** (real SDK, real bundled CLI, mock
Anthropic API, temp `HOME`). Covers a poisoned fixture repo and a poisoned
user-level `HOME` (project hooks, `.mcp.json`, project settings, user memory —
none of it may load or execute), the env allowlist canary, the tool surface in
both modes, read-only denial of `Write`, a successful writable `Write`, resume
from the same and a different cwd, resume across a server restart, a real
interrupt mid-stream, and a cancel that races CLI startup.

**Tier 3 — `npm run test:smoke`** (real model, opt-in with
`CLAUDE_CODE_MCP_SMOKE=1`). Release gate only: a read-only consultation that
cites a file, session continuity, read-only refusal, a writable write in a temp
dir, and async submit + cancel.

`npm run check` is `node --check` over the sources — the repo has no linter.

## Known limitations

- No `@`-imports or nested `CLAUDE.md` (above).
- Sessions are in-memory: after a restart, `claude-reply` needs an explicit `cwd`
  and falls back to read-only.
- An async submission blocks until `system/init` (~0.3–3s).
- A turn whose child never starts and never exits is only released by the turn
  timeout.
