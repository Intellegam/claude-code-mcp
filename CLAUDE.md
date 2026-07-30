# Claude Code MCP Server

MCP server that lets an external agent (typically OpenAI Codex) consult Claude
Code as a second-opinion agent. The mirror image of the `codex-mcp` repo.

You MUST read the following files for more information:

- @README.md
- @DESIGN.md

## Overview

- **Language**: Node.js, ESM (`"type": "module"`), Node >= 18
- **Protocol**: MCP JSON-RPC over stdio → Claude Agent SDK → Claude Code CLI
- **Dependency**: `@anthropic-ai/claude-agent-sdk`, pinned **exactly** (no
  caret). The runner depends on observed SDK behaviour, not documented API — a
  minor bump can break interrupts. Re-run tier 2 before changing the pin.

## Layout

```
server.js            MCP protocol layer, tool schemas, dispatch, shutdown
lib/engine.js        turns, sessions, guards, watchdogs (ported from codex-mcp)
lib/claude-runner.js SDK adapter — one runner per turn
lib/isolation.js     env denylist, tool disallow lists, bridge-deny hook
test/tier1/          fast tests, SDK query() mocked; engine.test.mjs drives the
                     engine in-process through the createRunner seam
test/tier2/          integration: real CLI against a mock Anthropic API
test/helpers/        harness, mock query, mock API, sandbox + startTier2
```

## Things that will bite you

- **The prompt stream must stay open until the turn settles.** If the prompt
  AsyncIterable completes early, the SDK closes the child's stdin and
  `interrupt()` becomes a silent no-op — turns then cannot be cancelled.
- **Interrupts before `system/init` do nothing.** They are buffered in
  `ClaudeRunner` and sent once, on init.
- **After an error result the message iterator throws.** That throw is expected
  and is suppressed when a result was already observed.
- **`result` messages may have no `errors[]`.** Never index it unguarded.
- **Resume is keyed by session id *and* cwd.** A different cwd is a hard failure,
  not a new session. The engine adopts whatever id `system/init` reports, even
  when it differs from the one being resumed.
- **The single authorization gate is the `PreToolUse` hook in
  `lib/isolation.js`**, not `canUseTool`. Extend it there rather than bolting
  exceptions onto `disallowedTools`; the reasoning is in that file.
- **A consultation runs as the operator's own Claude Code.** `settingSources` is
  unset on purpose: user + project + local config all load. The only always-deny
  is an agent-bridge MCP server (recursion guard).
- **The tool surface is wider than it looks.** `Monitor` and `REPL` execute
  code, delegation is called `Agent` to the model but `Task` in `system/init`,
  and there is a family of scheduling/messaging tools. See the disallow lists in
  `lib/isolation.js`, and the tier-2 drift guard that pins the surface, before
  assuming read-only means read-only.

## Commands

```bash
npm test                  # tier 1 (fast, no child process)
npm run test:integration  # tier 2 (real CLI, mock API) — must pass before release
npm run check             # node --check over the sources
node test/send.js claude "prompt"
```

## Releasing

1. Bump `version` in `package.json` and `VERSION` in `server.js` (keep in sync).
2. `git tag v{version}`.
3. Update the consumer's pin (e.g. a `#v{version}` ref in a plugin's config).
