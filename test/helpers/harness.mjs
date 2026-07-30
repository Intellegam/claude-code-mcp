/**
 * Test harness: spawn the MCP server as a child process and talk JSON-RPC to it
 * over stdio, the way a real MCP client does.
 */

import { spawn } from "node:child_process";
import readline from "node:readline";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = path.resolve(TEST_DIR, "..", "..");
export const SERVER_JS = path.join(REPO_ROOT, "server.js");
export const MOCK_QUERY = path.join(TEST_DIR, "mock-query.mjs");

export function spawnServer({ env = {}, cwd = REPO_ROOT, useMockQuery = true } = {}) {
  const proc = spawn(process.execPath, [SERVER_JS], {
    cwd,
    env: {
      ...process.env,
      ...(useMockQuery ? { CLAUDE_CODE_MCP_QUERY_MODULE: MOCK_QUERY } : {}),
      CLAUDE_TIMEOUT_MS: "8000",
      CLAUDE_CANCEL_WATCHDOG_MS: "1000",
      ...env,
    },
    stdio: ["pipe", "pipe", "pipe"],
  });
  proc.stdout.setEncoding("utf8");
  proc.stderr.setEncoding("utf8");

  let stderr = "";
  proc.stderr.on("data", (chunk) => {
    stderr += chunk;
  });

  const byId = new Map(); // id -> response
  const waiters = new Map(); // id -> {resolve, reject, timer}

  readline.createInterface({ input: proc.stdout }).on("line", (line) => {
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      return;
    }
    if (message.id === undefined) return;
    const waiter = waiters.get(message.id);
    if (waiter) {
      waiters.delete(message.id);
      clearTimeout(waiter.timer);
      waiter.resolve(message);
    } else {
      byId.set(message.id, message);
    }
  });

  let nextId = 1;

  function send(message) {
    proc.stdin.write(`${JSON.stringify(message)}\n`);
  }

  function waitFor(id, timeoutMs = 15000) {
    if (byId.has(id)) {
      const message = byId.get(id);
      byId.delete(id);
      return Promise.resolve(message);
    }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        waiters.delete(id);
        reject(new Error(`timed out waiting for response ${id}`));
      }, timeoutMs);
      waiters.set(id, { resolve, reject, timer });
    });
  }

  async function request(method, params, timeoutMs) {
    const id = nextId++;
    send({ jsonrpc: "2.0", id, method, params });
    return waitFor(id, timeoutMs);
  }

  return {
    proc,
    send,
    request,
    getStderr: () => stderr,

    async init() {
      const response = await request("initialize", {});
      send({ jsonrpc: "2.0", method: "initialized", params: {} });
      return response;
    },

    /** Fire a tool call without awaiting it; returns the pending promise. */
    callAsyncPending(name, args, timeoutMs) {
      const id = nextId++;
      send({
        jsonrpc: "2.0",
        id,
        method: "tools/call",
        params: { name, arguments: args },
      });
      return waitFor(id, timeoutMs);
    },

    async call(name, args, timeoutMs) {
      return request("tools/call", { name, arguments: args }, timeoutMs);
    },

    close() {
      try {
        proc.stdin.end();
      } catch {
        // already gone
      }
      proc.kill("SIGKILL");
    },
  };
}

/** Parse a snapshot payload out of a tools/call response. */
export function snapshot(response) {
  if (response.error) {
    throw new Error(`expected snapshot, got error: ${response.error.message}`);
  }
  return JSON.parse(response.result.content[0].text);
}

/** Parse the `[[mock:{...}]]` trailer the mock query appends to its output. */
export function mockTrailer(text) {
  const match = /\[\[mock:(\{.*\})\]\]/s.exec(text ?? "");
  if (!match) throw new Error(`no mock trailer in output: ${text}`);
  return JSON.parse(match[1]);
}

export function sessionIdFrom(response) {
  const text = response.result.content.map((c) => c.text).join("\n");
  const match = /\[SESSION_ID: ([^\]]+)\]/.exec(text);
  if (!match) throw new Error(`no session id in response: ${text}`);
  return match[1];
}

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Poll `claude-result` until the session reaches a status (or is done). */
export async function pollUntil(server, sessionId, predicate, attempts = 100) {
  for (let i = 0; i < attempts; i++) {
    const snap = snapshot(await server.call("claude-result", { sessionId }));
    if (predicate(snap)) return snap;
    await sleep(25);
  }
  throw new Error(`session ${sessionId} never matched predicate`);
}
