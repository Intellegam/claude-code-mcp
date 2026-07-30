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
  const request = (method, params) =>
    new Promise((resolve, reject) => {
      const id = nextId++;
      pending.set(id, resolve);
      proc.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
      setTimeout(() => reject(new Error(`${method} timed out`)), TIMEOUT_MS);
    });

  return {
    request,
    call: (name, args) => request("tools/call", { name, arguments: args }),
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
const snapshot = (response) => JSON.parse(response.result.content[0].text);
const text = (response) =>
  (response.result?.content ?? []).map((block) => block.text).join("\n");

const mcp = client();
await mcp.request("initialize", {});

let sessionId = null;

await scenario("read-only consultation answers from the repo", async () => {
  const response = await mcp.call("claude", {
    prompt:
      "In one sentence: what does lib/claude-runner.js in this repo do? Name the file you read.",
    cwd: REPO_ROOT,
  });
  assert(!response.error, response.error?.message);
  const output = text(response);
  assert(/claude-runner\.js/.test(output), "answer does not cite the file");
  const match = /\[SESSION_ID: ([^\]]+)\]/.exec(output);
  assert(match, "no session id returned");
  sessionId = match[1];
});

await scenario("a follow-up remembers the conversation", async () => {
  const response = await mcp.call("claude-reply", {
    sessionId,
    prompt: "What file did I just ask you about? Answer with the file name only.",
    cwd: REPO_ROOT,
  });
  assert(!response.error, response.error?.message);
  assert(/claude-runner/.test(text(response)), "session context was lost");
});

await scenario("read-only mode refuses to write", async () => {
  const response = await mcp.call("claude", {
    prompt:
      "Create a file called smoke-should-not-exist.txt in the current directory with the text 'nope'. If you cannot, say NO_WRITE_TOOL.",
    cwd: REPO_ROOT,
  });
  assert(!response.error, response.error?.message);
  assert(
    !fs.existsSync(path.join(REPO_ROOT, "smoke-should-not-exist.txt")),
    "a file was written in read-only mode",
  );
});

await scenario("writable mode can write inside the given cwd", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ccmcp-smoke-"));
  try {
    const response = await mcp.call("claude", {
      prompt: "Create a file named ok.txt containing exactly: hello",
      cwd: dir,
      writable: true,
    });
    assert(!response.error, response.error?.message);
    assert(fs.existsSync(path.join(dir, "ok.txt")), "no file was written");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

await scenario("async submit, then cancel", async () => {
  const submitted = snapshot(
    await mcp.call("claude", {
      prompt:
        "Read every file in this repository and write an exhaustive review of each one.",
      cwd: REPO_ROOT,
      async: true,
    }),
  );
  assert(submitted.sessionId, "no sessionId from the async submission");
  assert(!submitted.done, "turn finished before it could be cancelled");
  await new Promise((resolve) => setTimeout(resolve, 4000));
  await mcp.call("claude-cancel", { sessionId: submitted.sessionId });
  const final = snapshot(
    await mcp.call("claude-result", {
      sessionId: submitted.sessionId,
      wait: true,
    }),
  );
  assert(
    final.status === "cancelled" || final.status === "succeeded",
    `unexpected terminal status ${final.status}`,
  );
});

mcp.close();

const failed = results.filter((result) => !result.ok);
console.log(`\n${results.length - failed.length}/${results.length} scenarios passed`);
for (const failure of failed) console.log(`  FAIL ${failure.name}: ${failure.error}`);
process.exit(failed.length === 0 ? 0 : 1);
