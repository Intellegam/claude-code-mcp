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

import readline from "node:readline";
import {
  createEngine,
  DEFAULT_CANCEL_WATCHDOG_MS,
  DEFAULT_TIMEOUT_MS,
} from "./lib/engine.js";
import { createRunnerFactory, loadQuery } from "./lib/claude-runner.js";

const VERSION = "0.1.0";
const TIMEOUT_MS =
  parseInt(process.env.CLAUDE_TIMEOUT_MS, 10) || DEFAULT_TIMEOUT_MS;
const CANCEL_WATCHDOG_MS =
  parseInt(process.env.CLAUDE_CANCEL_WATCHDOG_MS, 10) ||
  DEFAULT_CANCEL_WATCHDOG_MS;
/** Upper bound on a clean shutdown before the process is torn down anyway. */
const SHUTDOWN_GRACE_MS = 2_000;

const engine = createEngine({
  createRunner: createRunnerFactory({ query: await loadQuery() }),
  timeoutMs: TIMEOUT_MS,
  cancelWatchdogMs: CANCEL_WATCHDOG_MS,
});

const INSTRUCTIONS = [
  "Claude Code is an external AI agent for second opinions, plan validation, and code review.",
  "Form your own analysis first, then consult it — and treat disagreement as signal, not noise.",
  "`claude` defaults to read-only (no writes, no shell, no subagents); `writable: true` allows file writes and commands and must be explicitly scoped in the prompt.",
  "`async: true` on `claude` and `claude-reply` returns a sessionId immediately instead of blocking; poll with `claude-result` (use `wait: true` to block until done) and stop with `claude-cancel`.",
  "Session IDs work across `claude-reply`, `claude-result`, and `claude-cancel`.",
  "Pass `cwd` (repo root) so Claude reads the right project — the repo's CLAUDE.md is injected automatically.",
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

const mcpRl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
  terminal: false,
});

/** In-flight request handlers, so shutdown can let them answer first. */
const inFlight = new Set();

mcpRl.on("line", (line) => {
  const pending = handleLine(line);
  inFlight.add(pending);
  pending.finally(() => inFlight.delete(pending));
});

async function handleLine(line) {
  let message;
  try {
    message = JSON.parse(line);
  } catch {
    return; // Not JSON — nothing to answer.
  }

  try {
    switch (message.method) {
      case "initialize":
        sendResponse(message.id, {
          protocolVersion: "2024-11-05",
          capabilities: { tools: {} },
          serverInfo: { name: "claude-code-mcp", version: VERSION },
          instructions: INSTRUCTIONS,
        });
        break;

      case "initialized":
      case "notifications/initialized":
        break;

      case "tools/list":
        sendResponse(message.id, { tools: TOOLS });
        break;

      case "tools/call":
        await handleToolCall(message);
        break;

      default:
        if (message.id !== undefined) {
          sendError(message.id, -32601, "Method not found");
        }
      // Unknown notifications (no id) are ignored.
    }
  } catch (e) {
    console.error("Error processing message:", e);
    if (message?.id !== undefined) sendError(message.id, -32603, e.message);
  }
}

async function handleToolCall(message) {
  const name = message.params?.name;
  const args = message.params?.arguments ?? {};

  try {
    // --- Async submissions ---
    if ((name === "claude" || name === "claude-reply") && args.async) {
      const turn =
        name === "claude"
          ? await engine.submitStart(args)
          : await engine.submitReply(args);
      sendJson(message.id, engine.snapshotForSubmission(turn));
      return;
    }

    // --- Session tools ---
    if (name === "claude-result") {
      sendJson(message.id, await engine.result(args));
      return;
    }
    if (name === "claude-cancel") {
      sendJson(message.id, engine.cancel(args));
      return;
    }

    // --- Sync tool calls ---
    let result;
    if (name === "claude") {
      result = await engine.runStart(args);
    } else if (name === "claude-reply") {
      result = await engine.runReply(args);
    } else {
      sendError(message.id, -32602, `Unknown tool: ${name}`);
      return;
    }

    const content = [{ type: "text", text: result.output }];
    if (result.sessionId) {
      content.push({
        type: "text",
        text: `\n[SESSION_ID: ${result.sessionId}]`,
      });
    }
    sendResponse(message.id, { content });
  } catch (e) {
    sendError(message.id, -32603, e.message);
  }
}

// ---------------------------------------------------------------------------
// MCP JSON-RPC helpers
// ---------------------------------------------------------------------------

function sendResponse(id, result) {
  console.log(JSON.stringify({ jsonrpc: "2.0", id, result }));
}

function sendJson(id, payload) {
  sendResponse(id, {
    content: [{ type: "text", text: JSON.stringify(payload, null, 2) }],
  });
}

function sendError(id, code, message) {
  console.log(
    JSON.stringify({ jsonrpc: "2.0", id, error: { code, message } }),
  );
}

// ---------------------------------------------------------------------------
// Clean shutdown
// ---------------------------------------------------------------------------

let shuttingDown = false;

/**
 * Close the live turns, then let the requests they were blocking answer before
 * the process goes away — a client waiting on a sync `claude` call gets a
 * JSON-RPC error instead of a silently dropped connection. Bounded, because a
 * child that refuses to die must not hold the server open.
 */
async function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;

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
