#!/usr/bin/env node

/**
 * Claude Code MCP Wrapper
 *
 * MCP server that lets an external agent (typically OpenAI Codex) consult
 * Claude Code as a second-opinion agent. It is the mirror image of codex-mcp,
 * which points the other way.
 *
 * Each turn spawns an isolated Claude Code via the Claude Agent SDK; sessions
 * are tracked in memory and continued through the SDK's `resume`. Submissions
 * return the stable Claude sessionId after initialization; the turn then runs
 * asynchronously and is polled with `claude-result` or stopped with
 * `claude-cancel`.
 */

import {
  createEngine,
  DEFAULT_CANCEL_WATCHDOG_MS,
  DEFAULT_TIMEOUT_MS,
} from "./lib/engine.js";
import { createRunnerFactory, loadSdk } from "./lib/claude-runner.js";
import { resolveAutoCompactWindow } from "./lib/isolation.js";

const VERSION = "0.2.1";
const TIMEOUT_MS =
  parseInt(process.env.CLAUDE_TIMEOUT_MS, 10) || DEFAULT_TIMEOUT_MS;
const CANCEL_WATCHDOG_MS =
  parseInt(process.env.CLAUDE_CANCEL_WATCHDOG_MS, 10) ||
  DEFAULT_CANCEL_WATCHDOG_MS;
const MAX_INIT_TIMEOUT_MS = 30_000;
const INIT_TIMEOUT_MS = positiveInteger(
  process.env.CLAUDE_INIT_TIMEOUT_MS,
  MAX_INIT_TIMEOUT_MS,
  MAX_INIT_TIMEOUT_MS,
);
const AUTO_COMPACT_WINDOW = resolveAutoCompactWindow();
/** Upper bound on a clean shutdown before the process is torn down anyway. */
const SHUTDOWN_GRACE_MS = 2_000;
/**
 * Longest accepted request line. A client that never sends a newline must not
 * be able to grow the read buffer without bound; JSON-RPC over stdio is one
 * message per line, and no legitimate one comes close.
 */
const MAX_LINE_CHARS = 10 * 1024 * 1024;

function positiveInteger(value, fallback, maximum) {
  if (typeof value !== "string" || !/^\d+$/.test(value)) return fallback;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0
    ? Math.min(parsed, maximum)
    : fallback;
}

const sdk = await loadSdk();
const engine = createEngine({
  createRunner: createRunnerFactory({
    query: sdk.query,
    getSessionInfo: sdk.getSessionInfo,
  }),
  timeoutMs: TIMEOUT_MS,
  cancelWatchdogMs: CANCEL_WATCHDOG_MS,
  autoCompactWindow: AUTO_COMPACT_WINDOW,
});

const INSTRUCTIONS = [
  "Claude Code is an external AI agent for second opinions, plan validation, and code review.",
  "Form your own analysis first, then consult it — and treat disagreement as signal, not noise.",
  "`claude` defaults to read-only — no writes, no shell, no subagents through Claude Code's built-in tools; it runs as the operator's own Claude Code, so non-bridge MCP servers stay available and those may have side effects.",
  "`writable: true` allows file writes and commands and must be explicitly scoped in the prompt.",
  "`claude` and `claude-reply` return the stable sessionId after initialization; poll with `claude-result` and stop with `claude-cancel`.",
  `Initialization waits at most ${INIT_TIMEOUT_MS}ms; answers continue asynchronously after that handshake.`,
  "Session IDs work across `claude-reply`, `claude-result`, and `claude-cancel`.",
  "Start a fresh `claude` session at task or topic boundaries; use `claude-reply` only for tightly related follow-ups that benefit from exact conversational continuity.",
  "Result snapshots report context and observed compaction state. If a completed session has more than 150000 context tokens and `cacheLikelyCold: true`, prefer a fresh session with a short handoff unless the next turn needs the prior evidence in detail.",
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
      },
      required: ["sessionId", "prompt"],
    },
  },
  {
    name: "claude-result",
    description:
      "Get the latest turn status, result, context usage, compaction state, and process-local cache-cold heuristic for a Claude session.",
    inputSchema: {
      type: "object",
      properties: {
        sessionId: { type: "string", description: "Session ID" },
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
 * not answer a cancelled request), and `turn` is the submission to stop while
 * the server waits for its initialization handshake.
 *
 * Stopping it is correct for exactly as long as the entry exists, which is
 * until the response is sent: a cancel landing in that window leaves the client
 * without the sessionId, so a turn left running could never be reached again.
 * Afterwards the entry is gone (the `finally` in `handleToolCall`), a late
 * cancel is a no-op, and `claude-cancel` is the way to stop an initialized
 * turn.
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
  cancelTurn(call.turn);
}

function cancelTurn(turn) {
  if (!turn) return;
  try {
    // A fresh session cancelled before init has no public handle. Settle and
    // close it immediately instead of letting init create an unreachable
    // session while the response is suppressed. Replies already have a public
    // sessionId, so their cancellation remains observable through result.
    if (
      turn.toolName === "claude" &&
      !turn.sawInit &&
      engine.failBeforeInitialization(
        turn,
        "Claude startup was cancelled before initialization",
        "cancel",
      )
    ) {
      return;
    }
    // By reference, not by session: a turn that has not reached `system/init`
    // has no sessionId to look up yet.
    engine.cancelTurn(turn);
  } catch {
    // The turn is already gone; nothing to stop.
  }
}

async function handleToolCall(id, params) {
  const name = params?.name;
  const args = params?.arguments ?? {};
  const call = { cancelled: false, turn: null };
  liveCalls.set(id, call);

  try {
    if (name === "claude" || name === "claude-reply") {
      // Attached before the wait for `system/init`, and stopped here on
      // purpose: a cancel can only land while the response is still owed, which
      // is exactly when the client has no sessionId yet. A turn left running
      // then could never be reached again.
      const turn =
        name === "claude" ? engine.beginStart(args) : engine.beginReply(args);
      call.turn = turn;
      if (call.cancelled) cancelTurn(turn);
      // The submission answers with the sessionId, which only exists once the
      // turn is up (or has settled). Bound that handshake independently of the
      // answer's much longer turn timeout so a stuck CLI startup cannot reach
      // the MCP client's outer transport timeout.
      if (!(await waitForInitialization(turn))) {
        engine.failBeforeInitialization(
          turn,
          `Claude did not initialize within ${INIT_TIMEOUT_MS}ms. The startup was stopped; retry ${name}.`,
        );
      }
      if (!turn.sawInit || !turn.sessionId) {
        sendToolFailure(
          id,
          turn.error?.message || "Claude failed to initialize with a sessionId",
          call,
        );
        return;
      }
      sendJson(id, engine.snapshotForSubmission(turn), call);
      return;
    }

    if (name === "claude-result") {
      sendJson(id, engine.result({ sessionId: args.sessionId }), call);
      return;
    }
    if (name === "claude-cancel") {
      sendJson(id, engine.cancel(args), call);
      return;
    }

    sendError(id, -32602, `Unknown tool: ${name}`, call);
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

async function waitForInitialization(turn) {
  let timer;
  try {
    return await Promise.race([
      turn.readyPromise.then(() => true),
      new Promise((resolve) => {
        timer = setTimeout(() => resolve(false), INIT_TIMEOUT_MS);
        timer.unref?.();
      }),
    ]);
  } finally {
    clearTimeout(timer);
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
 * Close live turns and let any initialization requests settle before the
 * process exits. Bounded, because a child that refuses to die must not hold the
 * server open.
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
