#!/usr/bin/env node

/**
 * Tier 3 — smoke tests against the REAL model. Release-gated and opt-in:
 *
 *   CLAUDE_CODE_MCP_SMOKE=1 npm run test:smoke
 *
 * These cost tokens and depend on the host's Claude Code authentication, so
 * they are never part of `npm test` or `npm run test:integration`.
 */

import { spawn } from "node:child_process";
import readline from "node:readline";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

if (process.env.CLAUDE_CODE_MCP_SMOKE !== "1") {
  console.log(
    "Skipping smoke tests. Set CLAUDE_CODE_MCP_SMOKE=1 to run them against the real model.",
  );
  process.exit(0);
}

const REPO_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const TIMEOUT_MS = 5 * 60 * 1000;
const SESSION_TIMEOUT_MS = 10 * 60 * 1000;

function client() {
  const proc = spawn(process.execPath, [path.join(REPO_ROOT, "server.js")], {
    cwd: REPO_ROOT,
    stdio: ["pipe", "pipe", "pipe"],
  });
  proc.stdout.setEncoding("utf8");
  proc.stderr.setEncoding("utf8");
  proc.stderr.on("data", (chunk) => process.stderr.write(`[server] ${chunk}`));

  const pending = new Map();
  readline.createInterface({ input: proc.stdout }).on("line", (line) => {
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      return;
    }
    const resolve = pending.get(message.id);
    if (resolve) {
      pending.delete(message.id);
      resolve(message);
    }
  });

  let nextId = 1;
  const request = (method, params, timeoutMs = TIMEOUT_MS) =>
    new Promise((resolve, reject) => {
      const id = nextId++;
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`${method} timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      pending.set(id, (message) => {
        clearTimeout(timer);
        resolve(message);
      });
      proc.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    });

  return {
    request,
    call: (name, args, timeoutMs) =>
      request("tools/call", { name, arguments: args }, timeoutMs),
    close: () => {
      proc.stdin.end();
      proc.kill("SIGTERM");
    },
  };
}

const results = [];
async function scenario(name, fn) {
  process.stdout.write(`→ ${name}\n`);
  const started = Date.now();
  try {
    await fn();
    results.push({ name, ok: true, ms: Date.now() - started });
    process.stdout.write(`  PASS (${Math.round((Date.now() - started) / 1000)}s)\n`);
  } catch (err) {
    results.push({ name, ok: false, ms: Date.now() - started, error: err.message });
    process.stdout.write(`  FAIL ${err.message}\n`);
  }
}

const assert = (condition, message) => {
  if (!condition) throw new Error(message);
};
function assertResolvedModel(model) {
  assert(
    typeof model === "string" && model.length > 0 && model !== "opus",
    `no resolved model reported: ${model}`,
  );
  process.stdout.write(`  resolved model: ${model}\n`);
}

const snapshot = (response) => JSON.parse(response.result.content[0].text);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function runSession(name, args, timeoutMs = SESSION_TIMEOUT_MS) {
  const deadline = Date.now() + timeoutMs;
  let current = snapshot(
    await mcp.call(
      name,
      args,
      Math.min(TIMEOUT_MS, Math.max(1, deadline - Date.now())),
    ),
  );
  while (!current.done && Date.now() < deadline) {
    await sleep(Math.min(1000, Math.max(0, deadline - Date.now())));
    current = snapshot(
      await mcp.call(
        "claude-result",
        { sessionId: current.sessionId },
        Math.min(TIMEOUT_MS, Math.max(1, deadline - Date.now())),
      ),
    );
  }
  if (!current.done) {
    throw new Error(
      `session ${current.sessionId} did not finish within ${timeoutMs}ms`,
    );
  }
  if (current.status !== "succeeded") {
    throw new Error(
      `session ${current.sessionId} ended as ${current.status}: ${current.error ?? "no error reported"}`,
    );
  }
  return current;
}

/**
 * A throwaway repo to run a scenario in, so nothing lands in this one and the
 * scenario controls the configuration Claude Code loads.
 */
function sandbox() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ccmcp-smoke-"));
  fs.mkdirSync(path.join(dir, ".claude"));
  return dir;
}

/**
 * Source for an MCP server whose single tool records that it ran. A denial has
 * to be provable, not inferred from what the model says about it.
 */
function tattlingMcpServer(toolName, sentinel) {
  return `import fs from 'node:fs';
import readline from 'node:readline';
const send = (o) => process.stdout.write(JSON.stringify(o) + '\\n');
readline.createInterface({ input: process.stdin }).on('line', (line) => {
  let m; try { m = JSON.parse(line); } catch { return; }
  if (m.method === 'initialize')
    send({ jsonrpc: '2.0', id: m.id, result: { protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'smoke', version: '0.0.1' } } });
  else if (m.method === 'tools/list')
    send({ jsonrpc: '2.0', id: m.id, result: { tools: [{ name: ${JSON.stringify(toolName)}, description: 'Ask the other agent for a second opinion.', inputSchema: { type: 'object', properties: { prompt: { type: 'string' } } } }] } });
  else if (m.method === 'tools/call') {
    fs.writeFileSync(${JSON.stringify(sentinel)}, 'ran');
    send({ jsonrpc: '2.0', id: m.id, result: { content: [{ type: 'text', text: 'THE-BRIDGE-ANSWERED' }] } });
  } else if (m.id !== undefined) send({ jsonrpc: '2.0', id: m.id, result: {} });
});
`;
}

const mcp = client();
await mcp.request("initialize", {});

let sessionId = null;

await scenario("Opus consultation answers from the repo and reports its resolved model", async () => {
  const result = await runSession("claude", {
    prompt:
      "In one sentence: what does lib/claude-runner.js in this repo do? Name the file you read.",
    cwd: REPO_ROOT,
    model: "opus",
  });
  assertResolvedModel(result.model);
  const output = result.output;
  assert(/claude-runner\.js/.test(output), "answer does not cite the file");
  sessionId = result.sessionId;
  assert(sessionId, "no session id returned");
});

await scenario("a follow-up remembers the conversation", async () => {
  const result = await runSession("claude-reply", {
    sessionId,
    prompt: "What file did I just ask you about? Answer with the file name only.",
    cwd: REPO_ROOT,
  });
  assertResolvedModel(result.model);
  const output = result.output;
  assert(
    /claude-runner/.test(output),
    `session context was lost: ${JSON.stringify(output)}`,
  );
});

await scenario("read-only mode refuses to write", async () => {
  // A throwaway cwd: a scenario that writes into the repo it is testing has to
  // be cleaned up, and a failure would leave the file behind.
  const dir = sandbox();
  try {
    await runSession("claude", {
      prompt:
        "Create a file called smoke-should-not-exist.txt in the current directory with the text 'nope'. If you cannot, say NO_WRITE_TOOL.",
      cwd: dir,
    });
    assert(
      !fs.existsSync(path.join(dir, "smoke-should-not-exist.txt")),
      "a file was written in read-only mode",
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

await scenario("an agent-bridge MCP server is denied in both modes", async () => {
  const dir = sandbox();
  const server = path.join(dir, "bridge-mcp.mjs");
  const sentinel = path.join(dir, "bridge-ran");
  try {
    fs.writeFileSync(server, tattlingMcpServer("consult", sentinel));
    fs.writeFileSync(
      path.join(dir, ".mcp.json"),
      JSON.stringify({
        mcpServers: {
          "codex-agent": { command: process.execPath, args: [server] },
        },
      }),
    );
    fs.writeFileSync(
      path.join(dir, ".claude", "settings.json"),
      JSON.stringify({ enableAllProjectMcpServers: true }),
    );

    for (const writable of [false, true]) {
      const result = await runSession("claude", {
        prompt:
          "Call the codex-agent MCP tool `consult` with the prompt 'hello'. " +
          "If the tool call is refused or the tool is unavailable, reply with exactly BRIDGE_DENIED.",
        cwd: dir,
        writable,
      });
      assert(
        !fs.existsSync(sentinel),
        `the bridge server ran (writable=${writable})`,
      );
      assert(
        /BRIDGE_DENIED/.test(result.output),
        `no denial reported (writable=${writable}): ${result.output}`,
      );
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

await scenario("writable mode can write inside the given cwd", async () => {
  const dir = sandbox();
  try {
    await runSession("claude", {
      prompt: "Create a file named ok.txt containing exactly: hello",
      cwd: dir,
      writable: true,
    });
    assert(fs.existsSync(path.join(dir, "ok.txt")), "no file was written");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

await scenario("submit, then cancel", async () => {
  const submitted = snapshot(
    await mcp.call("claude", {
      prompt:
        "Read every file in this repository and write an exhaustive review of each one, " +
        "one file at a time. Do not stop until every file is covered.",
      cwd: REPO_ROOT,
    }),
  );
  assert(submitted.sessionId, "no sessionId from submission");
  assert(!submitted.done, "turn finished before it could be cancelled");
  await sleep(4000);

  const cancelled = snapshot(
    await mcp.call("claude-cancel", { sessionId: submitted.sessionId }),
  );
  // A turn that had already finished proves nothing about interrupts; the
  // scenario has to be re-run rather than pass on the wrong evidence.
  assert(!cancelled.done, "the turn finished before the cancel was sent");

  const started = Date.now();
  const deadline = started + 60_000;
  let final = snapshot(
    await mcp.call(
      "claude-result",
      { sessionId: submitted.sessionId },
      Math.max(1, deadline - Date.now()),
    ),
  );
  while (!final.done && Date.now() < deadline) {
    await sleep(Math.min(1000, Math.max(0, deadline - Date.now())));
    final = snapshot(
      await mcp.call(
        "claude-result",
        { sessionId: submitted.sessionId },
        Math.max(1, deadline - Date.now()),
      ),
    );
  }
  const elapsed = Date.now() - started;
  assert(final.done, "the cancelled session did not settle within 60 seconds");
  assert(
    final.status === "cancelled",
    `expected cancelled, got ${final.status}`,
  );
  assert(elapsed < 60000, `the interrupt took ${Math.round(elapsed / 1000)}s`);
});

mcp.close();

const failed = results.filter((result) => !result.ok);
console.log(`\n${results.length - failed.length}/${results.length} scenarios passed`);
for (const failure of failed) console.log(`  FAIL ${failure.name}: ${failure.error}`);
process.exit(failed.length === 0 ? 0 : 1);
