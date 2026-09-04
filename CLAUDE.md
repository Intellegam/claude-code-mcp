# Claude Code MCP Server

MCP server that lets an external agent (typically OpenAI Codex) consult Claude
Code as a second-opinion agent. The mirror image of the `codex-mcp` repo.

You MUST read the following files for more information:

- @README.md
- @DESIGN.md

## Overview

- **Language**: Node.js, ESM (`"type": "module"`), Node >= 20.11 (`--test-timeout`
  in the tier-2 script)
- **Protocol**: MCP JSON-RPC over stdio → Claude Agent SDK → Claude Code CLI
- **Dependency**: `@anthropic-ai/claude-agent-sdk`, pinned **exactly** (no
  caret). The runner depends on observed SDK behaviour, not documented API — a
  minor bump can break interrupts. Re-run tier 2 before changing the pin.

## Layout

```
server.js            MCP protocol layer: envelope classification, tool schemas,
                     dispatch, request cancellation, shutdown
lib/engine.js        turns, sessions, guards, watchdogs (ported from codex-mcp)
lib/claude-runner.js SDK adapter — one runner per turn
lib/isolation.js     env denylist, tool disallow lists, bridge-deny hook
test/tier1/          fast tests, SDK query() mocked; engine.test.mjs drives the
                     engine in-process through the createRunner seam
test/tier2/          integration: real CLI against a mock Anthropic API
test/smoke.js        tier 3: real model, opt-in via CLAUDE_CODE_MCP_SMOKE=1
test/helpers/        harness, mock query, mock API, sandbox + startTier2
```

Test seams (read from the *server's* env, never from tool arguments):
`CLAUDE_CODE_MCP_QUERY_MODULE` swaps in a scripted `query()` (tier 1);
`CLAUDE_CODE_MCP_TEST_BASE_URL` points the child at the mock API by re-adding
`ANTHROPIC_BASE_URL`, always with a dummy key (tier 2).

## Things that will bite you

- **The prompt stream must stay open until the turn settles.** If the prompt
  AsyncIterable completes early, the SDK closes the child's stdin and
  `interrupt()` becomes a silent no-op — turns then cannot be cancelled.
- **Interrupts before `system/init` do nothing.** They are buffered in
  `ClaudeRunner` and sent once, on init.
- **After an error result the message iterator throws.** That throw is expected
  and is suppressed when a result was already observed.
- **`result` messages may have no `errors[]`.** Never index it unguarded.
- **Context usage is a pre-settle control read.** `onResult` synchronously
  settles the engine turn, so the bounded `getContextUsage` request must finish
  before `onResult`; error/interrupt results skip it.
- **The configured auto-compact window is not the effective policy.** Trust the
  CLI-reported effective window, threshold and enabled state; model clamping
  and operator disable controls can change them.
- **Resume is keyed by session id *and* cwd.** A different cwd or a different id
  from `system/init` is a hard failure, not a new session.
- **Submission waits only for `system/init`.** That handshake provides the one
  stable native session ID used by reply, result, and cancel. It is bounded by
  `CLAUDE_INIT_TIMEOUT_MS` (30s by default and as a hard maximum; it may only be
  lowered). Never wait for the answer inside an MCP request.
- **Authorization is two gates, and they are not interchangeable.** Exact
  `disallowedTools` specs hide the shipped bridge servers; the `PreToolUse`
  hook in `lib/isolation.js` only *denies* aliases (agent-bridge servers,
  both modes) — a hook decision is terminal, so allowing there would override
  the operator's own `permissions.deny` rules. Approving is `canUseTool`'s job,
  read-only only, because it runs after rule evaluation. Never move an allow
  into the hook.
- **A consultation runs as the operator's own Claude Code.** `settingSources` is
  unset on purpose: user + project + local config all load, and their permission
  rules stay authoritative. The only always-deny is an agent-bridge MCP server
  (native deny-list plus alias fallback hook).
- **The tool surface is wider than it looks.** `Monitor` and `REPL` execute
  code, `Skill` runs inline `!` commands unless `disableSkillShellExecution` is
  set, delegation is called `Agent` to the model but `Task` in `system/init`,
  and there are families of scheduling, messaging, publishing and interactive
  tools. See the disallow lists in `lib/isolation.js`, and the tier-2 drift
  guard that pins the surface, before assuming read-only means read-only.
- **SDK options are not always what the types say.** `settings` is typed
  `string | Settings`, but an object is stringified with `String()` into
  `--settings`; pass JSON. Setting `canUseTool` also changes the tool surface
  the CLI offers (it adds the interactive tools).
- **A failed tool call is a result with `isError`, not a JSON-RPC error.** The
  consuming model only reads result content. `-32602` is for an unknown tool,
  `-32603` for a fault in the protocol layer itself.

## Commands

### Run

- `npm start` - start the server on stdio (an MCP client normally does this)
- `node test/send.js claude "prompt"` - submit and poll one turn by hand
  (`--writable`; also `claude-reply <sessionId> "prompt"`)

### Required Checks

- Lint: `npm run check` (`node --check` over `server.js` and `lib/*.js`)
- Test: `npm test` (tier 1 — fast, SDK `query()` mocked, no child process)
- Integration test: `npm run test:integration` (tier 2 — real CLI against the
  mock Anthropic API; must pass before release)

### Situational Checks

- `lib/claude-runner.js` or `lib/isolation.js` changed, or the
  `@anthropic-ai/claude-agent-sdk` pin bumped →
  `CLAUDE_CODE_MCP_SMOKE=1 npm run test:smoke` (tier 3, real model, costs tokens)

### Review Inputs

- Architecture, SDK mechanics, trust model: `DESIGN.md`

## Releasing

1. Bump the version in sync: `package.json` (+ lockfile via
   `npm install --package-lock-only`), `VERSION` in `server.js`, and the
   `#v{version}` tag pin in `README.md`'s install snippet. The protocol test
   asserts server.js against package.json, so drift fails the suite.
2. Merge the server release PR.
3. Tag the resulting `main` commit, push the tag, and verify it is available on
   the remote: `git tag v{version}` then `git push origin v{version}`.
4. Update the `~/.codex/config.toml` entry if it pins a tag. The documented
   snippet does, so consumers must refresh it after each release.
5. In agent-plugins: bump the `claude-code` plugin's `.mcp.json` tag pin and
   `.codex-plugin/plugin.json` version, then merge that dependent change only
   after the server tag is available, or consumers receive an unresolved pin.
