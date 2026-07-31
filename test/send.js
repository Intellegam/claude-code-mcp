#!/usr/bin/env node

/**
 * Send a single tool call to the MCP server and print the response.
 *
 * Usage:
 *   node test/send.js claude "What does this repo do?"
 *   node test/send.js claude --async "What does this repo do?"
 *   node test/send.js claude --writable "Fix the typo in README.md"
 *   node test/send.js claude-reply <sessionId> "Follow-up question"
 *   node test/send.js claude-result <sessionId> [--wait]
 *   node test/send.js claude-cancel <sessionId>
 */

import { spawn } from "node:child_process";
import readline from "node:readline";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SERVER_JS = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "server.js",
);
const CWD = process.cwd();

const rawArgs = process.argv.slice(2);
const tool = rawArgs[0];
const flags = new Set(rawArgs.filter((arg) => arg.startsWith("--")));
const rest = rawArgs.slice(1).filter((arg) => !arg.startsWith("--"));

if (!tool || flags.has("--help")) {
  console.log(
    [
      "Usage:",
      '  node test/send.js claude "prompt" [--async] [--writable]',
      '  node test/send.js claude-reply <sessionId> "prompt" [--async]',
      "  node test/send.js claude-result <sessionId> [--wait]",
      "  node test/send.js claude-cancel <sessionId>",
    ].join("\n"),
  );
  process.exit(0);
}

function buildArgs() {
  switch (tool) {
    case "claude": {
      const args = { prompt: rest.join(" ") || "Hello", cwd: CWD };
      if (flags.has("--async")) args.async = true;
      if (flags.has("--writable")) args.writable = true;
      return args;
    }
    case "claude-reply": {
      const args = {
        sessionId: rest[0],
        prompt: rest.slice(1).join(" ") || "Continue",
        cwd: CWD,
      };
      if (flags.has("--async")) args.async = true;
      return args;
    }
    case "claude-result": {
      const args = { sessionId: rest[0] };
      if (flags.has("--wait")) args.wait = true;
      return args;
    }
    case "claude-cancel":
      return { sessionId: rest[0] };
    default:
      console.error(`Unknown tool: ${tool}`);
      process.exit(1);
  }
}

const proc = spawn(process.execPath, [SERVER_JS], {
  cwd: CWD,
  stdio: ["pipe", "pipe", "pipe"],
});
proc.stderr.setEncoding("utf8");
proc.stderr.on("data", (chunk) => process.stderr.write(chunk));
proc.stdout.setEncoding("utf8");

let waiter = null;
readline.createInterface({ input: proc.stdout }).on("line", (line) => {
  let message;
  try {
    message = JSON.parse(line);
  } catch {
    return;
  }
  if (waiter) {
    const resolve = waiter;
    waiter = null;
    resolve(message);
  }
});

// 35 min — longer than the default 30 min turn timeout.
function wait(ms = 35 * 60 * 1000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("timeout")), ms);
    waiter = (message) => {
      clearTimeout(timer);
      resolve(message);
    };
  });
}

function send(message) {
  proc.stdin.write(`${JSON.stringify(message)}\n`);
}

function done() {
  proc.stdin.end();
  proc.kill("SIGTERM");
}

let nextId = 1;

send({ jsonrpc: "2.0", id: nextId++, method: "initialize", params: {} });
await wait();
send({ jsonrpc: "2.0", method: "initialized", params: {} });

const args = buildArgs();
console.error(`→ ${tool}(${JSON.stringify(args)})\n`);

send({
  jsonrpc: "2.0",
  id: nextId++,
  method: "tools/call",
  params: { name: tool, arguments: args },
});
const response = await wait();

if (response.error) {
  console.error(`Protocol error: ${response.error.message}`);
  done();
  process.exit(1);
}

for (const block of response.result.content) console.log(block.text);

// A failed tool call is a result carrying `isError`, not a JSON-RPC error.
if (response.result.isError) {
  done();
  process.exit(1);
}

if (args.async) {
  const submitted = JSON.parse(response.result.content[0].text);
  if (!submitted.done) {
    console.error(`\n→ Waiting for result (sessionId: ${submitted.sessionId})...\n`);
    send({
      jsonrpc: "2.0",
      id: nextId++,
      method: "tools/call",
      params: {
        name: "claude-result",
        arguments: { sessionId: submitted.sessionId, wait: true },
      },
    });
    const polled = await wait();
    if (polled.error || polled.result.isError) {
      console.error(
        `Error: ${polled.error?.message ?? polled.result.content[0].text}`,
      );
      done();
      process.exit(1);
    }
    const final = JSON.parse(polled.result.content[0].text);
    console.error(`  status: ${final.status}, elapsed: ${final.elapsed}`);
    console.log(final.output);
    if (final.sessionId) console.log(`\n[SESSION_ID: ${final.sessionId}]`);
  }
}

done();
