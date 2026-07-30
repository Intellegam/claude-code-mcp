/**
 * Test harness: spawn the MCP server as a child process and talk JSON-RPC to it
 * over stdio, the way a real MCP client does.
 */

import { spawn, execFileSync } from "node:child_process";
import readline from "node:readline";
import path from "node:path";
import { fileURLToPath } from "node:url";

/** How long a closing server gets to exit on its own before it is killed. */
const CLOSE_GRACE_MS = 3000;

/**
 * Every descendant of `pid`, deepest last. The SDK spawns the CLI as a child of
 * the server, so killing the server alone can leave a grandchild behind.
 * `pgrep` exits 1 — i.e. throws — when a process has no children.
 */
function descendantsOf(pid) {
  let found = [];
  try {
    const children = execFileSync("pgrep", ["-P", String(pid)])
      .toString()
      .split("\n")
      .filter(Boolean)
      .map(Number);
    for (const child of children) found = [...found, child, ...descendantsOf(child)];
  } catch {
    // no children, or no pgrep on this platform
  }
  return found;
}

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
  proc.stderr.resume();

  // Every request registers its waiter synchronously with the write that
  // triggers it, so a response can never arrive before someone is listening —
  // and so an un-awaited `call()` has already been sent when it returns.
  const waiters = new Map(); // id -> {resolve, reject, timer, promise}

  readline.createInterface({ input: proc.stdout }).on("line", (line) => {
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      return;
    }
    const waiter = waiters.get(message.id);
    if (!waiter) return;
    waiters.delete(message.id);
    clearTimeout(waiter.timer);
    waiter.resolve(message);
  });

  // A response can no longer arrive once the child is gone.
  proc.on("exit", () => abandonWaiters("the server exited"));

  let nextId = 1;

  function send(message) {
    proc.stdin.write(`${JSON.stringify(message)}\n`);
  }

  function waitFor(id, timeoutMs = 15000) {
    const waiter = {};
    waiter.promise = new Promise((resolve, reject) => {
      waiter.resolve = resolve;
      waiter.reject = reject;
      waiter.timer = setTimeout(() => {
        waiters.delete(id);
        reject(new Error(`timed out waiting for response ${id}`));
      }, timeoutMs);
    });
    waiters.set(id, waiter);
    return waiter.promise;
  }

  /**
   * Fail every pending waiter and clear its timer.
   *
   * Those timers are referenced, so a test that leaves a call un-awaited — the
   * normal shape of a *failing* test — would otherwise hold the worker open for
   * the full timeout. The no-op catch keeps a waiter nobody is awaiting from
   * being reported as an unhandled rejection; a test that does await it still
   * sees the failure.
   */
  function abandonWaiters(reason) {
    for (const [id, waiter] of waiters) {
      clearTimeout(waiter.timer);
      waiter.promise.catch(() => {});
      waiter.reject(new Error(`response ${id} abandoned: ${reason}`));
    }
    waiters.clear();
  }

  // Deliberately not `async`: callers get the waiter's own promise, so the
  // no-op catch in `abandonWaiters` really does cover the promise they hold.
  function request(method, params, timeoutMs) {
    const id = nextId++;
    send({ jsonrpc: "2.0", id, method, params });
    return waitFor(id, timeoutMs);
  }

  return {
    proc,
    send,
    request,

    async init() {
      const response = await request("initialize", {});
      send({ jsonrpc: "2.0", method: "initialized", params: {} });
      return response;
    },

    call(name, args, timeoutMs) {
      return request("tools/call", { name, arguments: args }, timeoutMs);
    },

    /**
     * Send a tool call and hand back its JSON-RPC id alongside the pending
     * response — what a client needs to cancel the request it just made.
     */
    beginCall(name, args, timeoutMs) {
      const id = nextId++;
      send({
        jsonrpc: "2.0",
        id,
        method: "tools/call",
        params: { name, arguments: args },
      });
      return { id, response: waitFor(id, timeoutMs) };
    },

    /**
     * Send a request under a caller-chosen id.
     *
     * For reusing the id of a request the client has already cancelled: that
     * request is no longer in flight, so the id is free again — and a server
     * still holding it would silently drop the answer.
     */
    requestWithId(id, method, params, timeoutMs) {
      send({ jsonrpc: "2.0", id, method, params });
      return waitFor(id, timeoutMs);
    },

    /**
     * Write several tool calls in a *single* stdin chunk, so the server's line
     * handler starts them all before any of them can await. That is what makes
     * ordering races between two requests reproducible.
     */
    callInOneChunk(calls, timeoutMs) {
      const ids = calls.map(() => nextId++);
      proc.stdin.write(
        `${calls
          .map((call, i) =>
            JSON.stringify({
              jsonrpc: "2.0",
              id: ids[i],
              method: "tools/call",
              params: { name: call.name, arguments: call.args },
            }),
          )
          .join("\n")}\n`,
      );
      return ids.map((id) => waitFor(id, timeoutMs));
    },

    /**
     * Shut the server down and leave nothing behind: pending waiters are
     * failed, the server is asked to exit and killed if it will not, and any
     * surviving descendant — the SDK's CLI grandchild — is reaped. A failing
     * suite must not orphan a CLI or hang the test worker.
     */
    async close() {
      const strays = descendantsOf(proc.pid);
      abandonWaiters("the test harness closed the server");

      if (proc.exitCode === null && proc.signalCode === null) {
        const exited = new Promise((resolve) => proc.once("exit", resolve));
        try {
          proc.stdin.end();
        } catch {
          // already gone
        }
        proc.kill("SIGTERM");
        const killer = setTimeout(() => proc.kill("SIGKILL"), CLOSE_GRACE_MS);
        killer.unref?.();
        await exited;
        clearTimeout(killer);
      }

      for (const pid of strays) {
        try {
          process.kill(pid, "SIGKILL");
        } catch {
          // already gone
        }
      }
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

/**
 * The text of a failed tool call.
 *
 * A tool that fails answers with a result carrying `isError: true`, not a
 * JSON-RPC error — the model that called it has to see the message.
 */
export function toolError(response) {
  if (response.error) {
    throw new Error(
      `expected a tool result, got JSON-RPC ${response.error.code}: ${response.error.message}`,
    );
  }
  if (response.result?.isError !== true) {
    throw new Error(
      `expected a failed tool result, got: ${JSON.stringify(response.result)}`,
    );
  }
  return response.result.content.map((block) => block.text).join("\n");
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
