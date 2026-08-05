#!/usr/bin/env node

/**
 * Claude Code MCP Wrapper
 *
 * MCP server that lets an external agent (typically OpenAI Codex) consult
 * Claude Code as a second-opinion agent. It is the mirror image of codex-mcp,
 * which points the other way.
 *
 * Each turn spawns an isolated Claude Code via the Claude Agent SDK; sessions
 * are tracked in memory and continued through the SDK's `resume`. Tool calls
 * are synchronous by default; `async: true` returns a sessionId immediately and
 * the turn is polled with `claude-result` and stopped with `claude-cancel`.
 */

import {
  createEngine,
  DEFAULT_CANCEL_WATCHDOG_MS,
  DEFAULT_TIMEOUT_MS,
} from "./lib/engine.js";
import { createRunnerFactory, loadQuery } from "./lib/claude-runner.js";

const VERSION = "0.1.2";
const TIMEOUT_MS =
  parseInt(process.env.CLAUDE_TIMEOUT_MS, 10) || DEFAULT_TIMEOUT_MS;
const CANCEL_WATCHDOG_MS =
  parseInt(process.env.CLAUDE_CANCEL_WATCHDOG_MS, 10) ||
  DEFAULT_CANCEL_WATCHDOG_MS;
/** Upper bound on a clean shutdown before the process is torn down anyway. */
const SHUTDOWN_GRACE_MS = 2_000;
/**
 * Longest accepted request line. A client that never sends a newline must not
 * be able to grow the read buffer without bound; JSON-RPC over stdio is one
 * message per line, and no legitimate one comes close.
 */
const MAX_LINE_CHARS = 10 * 1024 * 1024;

const engine = createEngine({
  createRunner: createRunnerFactory({ query: await loadQuery() }),
  timeoutMs: TIMEOUT_MS,
  cancelWatchdogMs: CANCEL_WATCHDOG_MS,
});

const INSTRUCTIONS = [
  "Claude Code is an external AI agent for second opinions, plan validation, and code review.",
  "Form your own analysis first, then consult it — and treat disagreement as signal, not noise.",
  "`claude` defaults to read-only — no writes, no shell, no subagents through Claude Code's built-in tools; it runs as the operator's own Claude Code, so their MCP servers stay available and those may have side effects.",
  "`writable: true` allows file writes and commands and must be explicitly scoped in the prompt.",
  "`async: true` on `claude` and `claude-reply` returns a sessionId immediately instead of blocking; poll with `claude-result` (use `wait: true` to block until done) and stop with `claude-cancel`.",
  "Session IDs work across `claude-reply`, `claude-result`, and `claude-cancel`.",
  "Pass `cwd` (repo root) so Claude reads the right project — the CLI loads that repo's own configuration and memory from there.",
].join(" ");

const TOOLS = [
  {
    name: "claude",
    description: "Start a new Claude Code session.",
    inputSchema: {
      type: "object",
      properties: {
        prompt: { type: "string", description: "The prompt for Claude" },
        cwd: { type: "string", description: "Working directory" },
        writable: {
          type: "boolean",
          description:
            "Allow file writes and commands. Default false; in the prompt, be explicit about what Claude should and should not do.",
        },
        async: { type: "boolean", description: "Run asynchronously." },
      },
      required: ["prompt"],
    },
  },
  {
    name: "claude-reply",
    description: "Continue an existing Claude Code session.",
    inputSchema: {
      type: "object",
      properties: {
        sessionId: { type: "string", description: "Claude session ID" },
        prompt: { type: "string", description: "Follow-up prompt" },
        cwd: {
          type: "string",
          description:
            "Working directory. Required when resuming across MCP restarts — must match the cwd used when the session was created.",
        },
        async: { type: "boolean", description: "Run asynchronously." },
      },
      required: ["sessionId", "prompt"],
    },
  },
  {
    name: "claude-result",
    description: "Get the latest turn status or result for a Claude session.",
    inputSchema: {
      type: "object",
      properties: {
        sessionId: { type: "string", description: "Session ID" },
        wait: {
          type: "boolean",
          description:
            "Block until the latest turn completes. Default false (returns current state immediately).",
        },
      },
      required: ["sessionId"],
    },
  },
  {
    name: "claude-cancel",
    description:
      "Cancel the active turn on a Claude session. Safe to call regardless of turn state.",
    inputSchema: {
      type: "object",
      properties: {
        sessionId: { type: "string", description: "Session ID" },
      },
      required: ["sessionId"],
    },
  },
];

// ---------------------------------------------------------------------------
// MCP Protocol — JSON-RPC over stdio
// ---------------------------------------------------------------------------

/** In-flight request handlers, so shutdown can let them answer first. */
const inFlight = new Set();

/**
 * Live `tools/call` requests, by JSON-RPC id, so `notifications/cancelled` can
 * reach them: `cancelled` suppresses the response (per MCP the server should
 * not answer a cancelled request), and `turn` — attached for every submission,
 * synchronous or async — is the turn to stop.
 *
 * Stopping it is correct for exactly as long as the entry exists, which is
 * until the response is sent: a cancel landing in that window leaves the client
 * without the sessionId, so a turn left running could never be reached again.
 * Afterwards the entry is gone (the `finally` in `handleToolCall`), a late
 * cancel is a no-op, and `claude-cancel` is the only way to stop an async turn.
 *
 * `cancelSignal` is the other half: a handler waiting on a turn it may not stop
 * (`claude-result wait: true`) has to be released some other way, or it holds
 * the request until that turn finishes.
 */
const liveCalls = new Map();

// --- stdin: one JSON-RPC message per line, bounded ------------------------

let shuttingDown = false;
let stdinBuffer = "";
/** Set while the remainder of an over-long line is being thrown away. */
let discardingLine = false;

process.stdin.setEncoding("utf8");
process.stdin.on("data", onStdinData);
process.stdin.on("end", shutdown);

function onStdinData(chunk) {
  if (shuttingDown) return;

  let data = chunk;
  if (discardingLine) {
    // Drop the rest of an over-long line without ever holding on to it.
    const end = data.indexOf("\n");
    if (end === -1) return;
    discardingLine = false;
    data = data.slice(end + 1);
  }
  stdinBuffer += data;

  let newline;
  while ((newline = stdinBuffer.indexOf("\n")) !== -1) {
    const line = stdinBuffer.slice(0, newline);
    stdinBuffer = stdinBuffer.slice(newline + 1);
    // The buffered-length check below never sees a line whose terminating
    // newline arrived in the same chunk that crossed the limit — the line has
    // to be measured here too, or it reaches the parser.
    if (line.length > MAX_LINE_CHARS) {
      sendError(
        null,
        -32700,
        `Request line exceeds ${MAX_LINE_CHARS} characters`,
      );
      continue;
    }
    acceptLine(line);
    if (shuttingDown) return;
  }

  if (stdinBuffer.length > MAX_LINE_CHARS) {
    stdinBuffer = "";
    discardingLine = true;
    sendError(null, -32700, `Request line exceeds ${MAX_LINE_CHARS} characters`);
  }
}

function acceptLine(rawLine) {
  const line = rawLine.replace(/\r$/, "").trim();
  if (!line) return;
  // Swallow first, track second: an unhandled rejection from this derived
  // promise would take the process down, and shutdown awaits these.
  const pending = handleLine(line).catch(() => {});
  inFlight.add(pending);
  pending.finally(() => inFlight.delete(pending));
}

/**
 * Classify the envelope before dispatching on the method.
 *
 * A request carries an id and gets exactly one response; a notification carries
 * none and gets nothing back, whatever its method. Dispatching on the method
 * first answered id-less requests with id-less garbage.
 */
async function handleLine(line) {
  let message;
  try {
    message = JSON.parse(line);
  } catch {
    sendError(null, -32700, "Parse error");
    return;
  }

  if (Array.isArray(message)) {
    sendError(null, -32600, "Batch requests are not supported");
    return;
  }
  if (message === null || typeof message !== "object") {
    sendError(null, -32600, "Invalid Request");
    return;
  }

  // Classification is by id *presence* (own property), per JSON-RPC: a request
  // may carry id null, and null must be echoed back — not treated as absent.
  const hasId = Object.hasOwn(message, "id");
  const id = message.id;
  const method = typeof message.method === "string" ? message.method : null;
  if (message.jsonrpc !== "2.0" || !method) {
    sendError(hasId ? id : null, -32600, "Invalid Request");
    return;
  }

  if (method.startsWith("notifications/") || method === "initialized") {
    if (hasId) {
      sendError(id, -32600, `${method} is a notification and must have no id`);
      return;
    }
    handleNotification(method, message.params);
    return;
  }
  // A request method sent without an id is a notification: there is nothing to
  // answer, and starting a turn nobody can collect would only leak one.
  if (!hasId) return;

  try {
    switch (method) {
      case "initialize":
        sendResponse(id, {
          protocolVersion: "2024-11-05",
          capabilities: { tools: {} },
          serverInfo: { name: "claude-code-mcp", version: VERSION },
          instructions: INSTRUCTIONS,
        });
        break;

      case "ping":
        sendResponse(id, {});
        break;

      case "tools/list":
        sendResponse(id, { tools: TOOLS });
        break;

      case "tools/call":
        await handleToolCall(id, message.params);
        break;

      default:
        sendError(id, -32601, "Method not found");
    }
  } catch (e) {
    // Not a tool failure (those answer with an isError result) — a fault in the
    // protocol layer itself.
    console.error("Error processing message:", e);
    sendError(id, -32603, e.message);
  }
}

function handleNotification(method, params) {
  if (method !== "notifications/cancelled") return; // including initialized
  const call = liveCalls.get(params?.requestId);
  if (!call) return;
  call.cancelled = true;
  call.signalCancel();
  cancelTurn(call.turn);
}

function cancelTurn(turn) {
  if (!turn) return;
  try {
    // By reference, not by session: a turn that has not reached `system/init`
    // has no sessionId to look up yet.
    engine.cancelTurn(turn);
  } catch {
    // The turn is already gone; nothing to stop.
  }
}

/** What `cancelSignal` resolves to, so it is distinguishable from a result. */
const CANCELLED = Symbol("cancelled");

async function handleToolCall(id, params) {
  const name = params?.name;
  const args = params?.arguments ?? {};
  const call = { cancelled: false, turn: null };
  // Resolved by `notifications/cancelled`, so a handler parked on a turn it is
  // no longer allowed to answer can stop waiting.
  call.cancelSignal = new Promise((resolve) => {
    call.signalCancel = () => resolve(CANCELLED);
  });
  liveCalls.set(id, call);

  try {
    // --- Async submissions ---
    if ((name === "claude" || name === "claude-reply") && args.async) {
      // Attached before the wait for `system/init`, and stopped here on
      // purpose: a cancel can only land while the response is still owed, which
      // is exactly when the client has no sessionId yet. A turn left running
      // then could never be reached again.
      const turn =
        name === "claude" ? engine.beginStart(args) : engine.beginReply(args);
      call.turn = turn;
      if (call.cancelled) cancelTurn(turn);
      // The submission answers with the sessionId, which only exists once the
      // turn is up (or has settled).
      await turn.readyPromise;
      sendJson(id, engine.snapshotForSubmission(turn), call);
      return;
    }

    // --- Session tools ---
    if (name === "claude-result") {
      // `wait: true` parks until the turn settles — up to the full turn
      // timeout. A cancelled request may no longer be answered, so staying
      // parked is pure retention: give up as soon as the cancel lands. The turn
      // itself keeps running; an async turn is stopped through `claude-cancel`
      // alone. `Promise.race` subscribes to the result either way, so a
      // rejection arriving after the cancel won is still handled.
      const outcome = await Promise.race([
        engine.result(args),
        call.cancelSignal,
      ]);
      if (outcome === CANCELLED) return;
      sendJson(id, outcome, call);
      return;
    }
    if (name === "claude-cancel") {
      sendJson(id, engine.cancel(args), call);
      return;
    }

    // --- Sync tool calls ---
    // Not awaited: the turn record has to be reachable from the first tick, so
    // a `notifications/cancelled` arriving before `system/init` can stop it.
    let turn;
    if (name === "claude") {
      turn = engine.beginStart(args);
    } else if (name === "claude-reply") {
      turn = engine.beginReply(args);
    } else {
      sendError(id, -32602, `Unknown tool: ${name}`, call);
      return;
    }
    call.turn = turn;
    // Re-check: a cancellation that landed before the turn was attached found
    // nothing to stop.
    if (call.cancelled) cancelTurn(turn);

    const result = await engine.awaitTurn(turn);
    const content = [{ type: "text", text: result.output }];
    if (result.sessionId) {
      content.push({
        type: "text",
        text: `\n[SESSION_ID: ${result.sessionId}]${
          result.model ? `\n[MODEL: ${result.model}]` : ""
        }`,
      });
    }
    sendResponse(id, { content }, call);
  } catch (e) {
    // A tool that failed is a *result*, not a JSON-RPC error: the model that
    // called it has to see why. Protocol errors are reserved for envelopes the
    // server could not act on at all.
    sendToolFailure(id, e.message, call);
  } finally {
    // By identity, not by id: a client that cancelled this request may have
    // reused the id while this handler was still settling, and the entry then
    // belongs to the successor.
    if (liveCalls.get(id) === call) liveCalls.delete(id);
  }
}

// ---------------------------------------------------------------------------
// MCP JSON-RPC helpers
// ---------------------------------------------------------------------------

/**
 * Cancellation is judged against the call that *owns* the request, passed by
 * the tool-call handler: looking the id up in `liveCalls` instead would consult
 * a successor request when the client cancelled this one and reused its id —
 * letting the old turn's result go out under the new request. Senders outside
 * `handleToolCall` have no call and fall back to the map, where the entry (if
 * any) is necessarily their own.
 */
function sendResponse(id, result, call = liveCalls.get(id)) {
  if (call?.cancelled) return; // cancelled requests get no reply
  console.log(JSON.stringify({ jsonrpc: "2.0", id, result }));
}

function sendJson(id, payload, call) {
  sendResponse(
    id,
    { content: [{ type: "text", text: JSON.stringify(payload, null, 2) }] },
    call,
  );
}

function sendToolFailure(id, message, call) {
  sendResponse(
    id,
    { content: [{ type: "text", text: message }], isError: true },
    call,
  );
}

function sendError(id, code, message, call = liveCalls.get(id)) {
  if (call?.cancelled) return;
  console.log(
    JSON.stringify({ jsonrpc: "2.0", id: id ?? null, error: { code, message } }),
  );
}

// ---------------------------------------------------------------------------
// Clean shutdown
// ---------------------------------------------------------------------------

/**
 * Close the live turns, then let the requests they were blocking answer before
 * the process goes away — a client waiting on a sync `claude` call gets a
 * failed tool result instead of a silently dropped connection. Bounded, because
 * a child that refuses to die must not hold the server open.
 */
async function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  // Stop reading *before* the in-flight set is snapshotted below: a request
  // that started after that point would be waiting on an engine that has
  // already been shut down.
  process.stdin.off("data", onStdinData);
  process.stdin.pause();
  stdinBuffer = "";

  const grace = new Promise((resolve) => {
    setTimeout(resolve, SHUTDOWN_GRACE_MS).unref?.();
  });
  const drain = (async () => {
    // Not sequential: closing a runner settles its turn (and so answers the
    // request that was blocked on it) well before `close()` has finished
    // reaping the child.
    await Promise.allSettled([engine.shutdown(), ...inFlight]);
    // stdout is a pipe: make sure the last responses are actually flushed.
    await new Promise((resolve) => process.stdout.write("", resolve));
  })();

  await Promise.race([drain, grace]);
  process.exit(0);
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
process.stdin.on("end", shutdown);
