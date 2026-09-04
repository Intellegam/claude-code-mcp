# claude-code-mcp — design

The mirror image of [`codex-mcp`](https://github.com/Intellegam/codex-mcp): that
server lets Claude Code consult OpenAI Codex; this one lets Codex (or any MCP
client) consult Claude Code as a second-opinion agent.

The layout, the tools and the environment variables are described in
[README.md](./README.md) and [CLAUDE.md](./CLAUDE.md). This file covers only
what is not obvious from the code: the SDK mechanics the runner depends on, the
order events are resolved in, and the trust model.

Everything marked *verified* was established empirically against
`@anthropic-ai/claude-agent-sdk@0.3.258` and its bundled CLI 2.1.x.

The turn/session engine is ported from codex-mcp: turn records, session records,
the one-active-turn guard, the cancel watchdog, terminal states and snapshot
shapes are all the same, apart from the `model` field this server adds. What is
dropped is codex-mcp's app-server connection layer: there is no persistent
Claude daemon. Each turn spawns its own CLI child through the SDK, and
continuity comes from `resume`.

Submissions wait only for `system/init`, then return the stable native Claude
`sessionId`. The answer continues asynchronously. `claude-result` is an
immediate snapshot lookup and `claude-cancel` targets the active turn on that
same session. No MCP request waits for the answer itself.

## The runner

Per turn the runner calls `query()` with a **hold-open AsyncIterable prompt**: it
yields exactly one user message and then awaits a promise the runner resolves
only once the turn has settled.

> *Verified:* if the prompt iterable completes, the SDK closes the child's stdin
> immediately and `interrupt()` silently becomes undeliverable — the turn can
> then never be cancelled. This is the single most important mechanic in the
> file.

- **`system/init`** marks initialization and carries the session id. It is
  emitted once per *turn*, not per session. A new session adopts the non-empty
  id it reports; a reply must report the same id it was asked to resume or the
  turn fails without changing the public handle.
  *Verified* (tier 2): it also carries the model the CLI resolved, and assistant
  messages carry the model that served them. The runner reports both through a
  single `onModel` event, last-write-wins — so a mid-turn fallback, if the CLI
  performs one, reports truthfully and stores it per turn for snapshots.
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
  session id and works after an interrupted turn and across server restarts.
  While the server retains the session record, the engine rejects a mismatched
  cwd before spawning the CLI. After a server restart, the SDK adapter validates
  the requested cwd against persisted session metadata before it starts the
  resumed query.

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

- **Nested-session env markers and the transport/credential unit.**
  `CLAUDECODE` and `CLAUDE_CODE_*` change CLI behaviour when a Claude Code
  session spawns another; the child environment is the parent's minus those.
  The exceptions kept: `CLAUDE_CODE_OAUTH_TOKEN` (a supported headless
  credential) and the `CLAUDE_CODE_USE_BEDROCK`/`CLAUDE_CODE_USE_VERTEX`
  backend switches, which keep the consultation on the operator's own backend. Dropped with them, and *as one unit*: `ANTHROPIC_BASE_URL` and
  `ANTHROPIC_UNIX_SOCKET`, which point the consultation at another backend, and
  `ANTHROPIC_AUTH_TOKEN` and `ANTHROPIC_CUSTOM_HEADERS`, which are that
  backend's credential — a credential must not outlive its destination, or it
  would be presented to the default endpoint instead. `ANTHROPIC_API_KEY` is
  bound to the default endpoint and stays. Names are matched upper-cased,
  because Windows environments are case-insensitive. A gateway deployment
  configures its destination in a settings file, and settings load in full.
- **Agent-bridge MCP servers.** The operator's plugins almost certainly include
  one — codex-mcp is what calls *this* server — and a consulted Claude that can
  call Codex back closes a recursion loop. Exact `disallowedTools` server specs
  remove the shipped manual and plugin-normalized bridge identities from the
  model's schema. A `PreToolUse` hook catches manually configured aliases
  matching
  `/^mcp__(codex|claude)(?:[-_](?:code|agent|mcp))*(?:[-_]v?\d+)*__/i` in both
  permission modes. It intentionally does not parse Claude Code's ambiguous
  underscore-normalized plugin names; the exact specs own those. Every other
  MCP tool is left to the operator's normal permission rules. The trailing
  `__` matters: the whole manual server segment has to be a bridge name, so
  `mcp__claude_code_2__*` is caught while `mcp__codexdb__*` is not.

### Permission levels

| | read-only (default) | `writable: true` |
| --- | --- | --- |
| `permissionMode` | unset | `bypassPermissions` + `allowDangerouslySkipPermissions` |
| removed tools | `Write`, `Edit`, `NotebookEdit`, `Bash`, `Monitor`, `REPL`, `TaskCreate`, `TaskUpdate`, `TaskStop` + the always-blocked set | the always-blocked set |
| settings | `disableSkillShellExecution` | — |
| `canUseTool` | approves non-bridge MCP tools and out-of-tree `Read`/`Glob`/`Grep` at the gate reason; `matchedAskRule` denies first | not set (shadowed) |

Always blocked, in both modes: `Task`/`Agent` (init reports the first name, the
model sees the second), `Workflow`, `CronCreate`, `CronDelete`, `CronList`,
`ScheduleWakeup`, `RemoteTrigger`, `Brief`, `SendUserMessage`, `SendMessage`,
`SendFeedback`,
`PushNotification`, `EnterWorktree`, `ExitWorktree`, `DesignSync`, `Projects`,
`Artifact`, `AskUserQuestion`, `EnterPlanMode`, `ExitPlanMode`. `writable`
authorizes edits in the caller's repo — not delegation, not scheduled or
backgrounded execution, not moving the session to another working directory
(which would also break cwd-keyed resume), not messaging, and not publishing
what the consultation read to a hosted surface. The three interactive tools are
blocked because there is nobody to answer them: *verified*, the CLI starts
offering them as soon as a permission-prompt host is present (read-only's
`canUseTool`), and a call would stall the turn until its timeout.

`Monitor` and `REPL` are on the read-only list for the same reason as `Bash`:
Monitor's own guidance is to run `until <check>; do sleep 2; done`, and REPL
evaluates JavaScript, so blocking `Bash` alone would not make the session
read-only. The same argument reaches past the tool list: `Skill` stays
available, and a skill body's inline `!` commands are run by the CLI itself, so
read-only also sets `disableSkillShellExecution`. *Verified:* that setting has
to be passed as a JSON **string** — the SDK types accept a `Settings` object,
but 0.3.258 forwards the value through `String()`, so an object arrives as
`[object Object]` and the CLI exits with "Settings file not found". It lands in
the flag-settings layer, which merges over the operator's files key by key.

`TaskCreate`, `TaskUpdate` and `TaskStop` mutate session state, so they are
read-only exclusions; inspection tools (`ListAgents`, `TaskGet`, `TaskList`,
`TaskOutput`) stay when offered. The default 0.3.258 surface includes
`ListAgents` and `TaskOutput` but no longer includes `TaskGet` or `TaskList`.
The tier-2 drift guard pins that surface so the next SDK bump has to be looked
at.

*Verified:* `disallowedTools` removes tools from the schema entirely rather than
denying at call time; its MCP server-level specs remove every tool from a named
server in both permission modes, it propagates to subagents, and it beats
on-disk allow rules, including a project `permissions.allow`. `allowedTools` is deliberately left
unset so the read tools stay available without maintaining an allowlist against
every SDK release. `bypassPermissions` requires
`allowDangerouslySkipPermissions` alongside it, and the read-only recipe never
hangs on a permission prompt — a blocked tool comes back as "No such tool
available".

### Two gates, and why neither is the other

Exact `disallowedTools` specs remove the shipped agent-bridge servers first.
The `PreToolUse` hook **denies** aliases, in both modes. *Verified:*
`canUseTool` is never invoked under `bypassPermissions` — the SDK auto-approves
first and warns that the callback is shadowed — and that is the writable mode
this wrapper uses, so a `canUseTool` deny would have been silently inert exactly
where it mattered. Hooks run in every permission mode and their denies are
terminal.

Denying is all the hook does. A hook decision is terminal in *both* directions,
so allowing there would override the operator's own `permissions.deny` rules —
this wrapper would be granting the consulted agent more than the operator
granted themselves.

Approving is `canUseTool`'s job, in read-only mode only. Read-only sets no
`permissionMode`, so a tool with no matching rule raises a permission request
that nobody is there to answer; the callback approves non-bridge MCP tools and
the built-in read tools at the out-of-tree gate, and denies anything else
rather than letting it hang. *Verified:* the callback runs only once the CLI
actually needs a decision — `disallowedTools`, the operator's allow/deny rules
and the hook have all been applied first, and a deny rule short-circuits
without reaching it. That ordering is what keeps the operator's settings
authoritative, and it is pinned by a tier-2 test.

The read-tool approval is gated, not blanket. The CLI auto-allows file reads
inside the session `cwd`; an out-of-tree `Read`/`Glob`/`Grep` raises a request
whose `decisionReason` is "Path is outside allowed working directories"
(*verified* identical for all three on the pinned CLI), and only that reason is
approved — cross-repo visibility is the contract. A request forced by an
operator `permissions.ask` rule *alone* arrives with *no* `decisionReason`;
it therefore misses the gate and falls into the generic deny, which is the
right outcome — ask reserves the call for a human, and headless there is
none. When an ask rule coincides with a tool-own reason (a bare `Read` ask
rule on an out-of-tree read), the CLI *does* populate `matchedAskRule`, and
the callback's explicit ask branch denies before the gate can approve —
without it, exactly that read would be auto-approved against the operator's
rule. The reason string is not contractual, but the SDK is exactly pinned,
upgrades are release-gated, and the tier-2 out-of-tree tests fail closed
(reads lose access, nothing gains it) if the string ever changes.

What ask rules can and cannot guarantee, all pinned by tier-2 tests: a direct
out-of-tree read of an ask-ruled file is denied (above); an ask rule on an
**MCP tool** is *not* honored — its forced request reaches the callback
byte-identical to an unruled one, so the tool is approved like any other
operator MCP tool; and a `Grep` sweep *discloses* an ask-ruled file's
contents, because the CLI's per-file result filtering honors only `deny`
rules (*verified*: a deny-ruled file is absent from sweep results, an
ask-ruled one is present). Deny is the enforcement primitive; ask is
best-effort, and the docs say so.

## Known limitations

- Sessions are in-memory: after a restart, `claude-reply` needs an explicit `cwd`
  and falls back to read-only. Persisted SDK metadata is used only to verify the
  cwd; the wrapper's permission level and latest-turn state are not restored.
- A submission waits up to `CLAUDE_INIT_TIMEOUT_MS` (30s by default and as a
  hard maximum) for `system/init` because the native stable session ID does not
  exist before then. The setting may shorten but cannot lengthen that ceiling.
  Missing the bound immediately fails the turn, closes the child, and returns a
  tool error; callers can retry without approaching an outer MCP transport
  timeout.
