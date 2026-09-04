import test, { after, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { sleep, spawnServer, toolError } from "../helpers/harness.mjs";

const PACKAGE_VERSION = JSON.parse(
  readFileSync(new URL("../../package.json", import.meta.url)),
).version;

describe("MCP protocol", () => {
  const server = spawnServer();
  after(() => server.close());

  test("initialize returns server info and instructions", async () => {
    const response = await server.init();
    assert.equal(response.result.protocolVersion, "2024-11-05");
    assert.equal(response.result.serverInfo.name, "claude-code-mcp");
    // Against package.json, so server.js's VERSION drifting is what fails.
    assert.equal(response.result.serverInfo.version, PACKAGE_VERSION);
    assert.match(response.result.instructions, /second opinion/i);
    assert.match(response.result.instructions, /read-only/i);
    assert.match(response.result.instructions, /task or topic boundaries/i);
    assert.match(response.result.instructions, /cacheLikelyCold/);
  });

  test("the initialization safety bound cannot exceed 30 seconds", async () => {
    const oversized = spawnServer({
      env: { CLAUDE_INIT_TIMEOUT_MS: "300000" },
    });
    try {
      const response = await oversized.init();
      assert.match(response.result.instructions, /at most 30000ms/);
    } finally {
      await oversized.close();
    }
  });

  test("tools/list returns the four claude tools", async () => {
    const response = await server.request("tools/list", {});
    const names = response.result.tools.map((tool) => tool.name);
    assert.deepEqual(names, [
      "claude",
      "claude-reply",
      "claude-result",
      "claude-cancel",
    ]);
    const claude = response.result.tools[0];
    assert.deepEqual(claude.inputSchema.required, ["prompt"]);
    assert.ok(claude.inputSchema.properties.writable);
    assert.equal(claude.inputSchema.properties.async, undefined);
    const result = response.result.tools.find(
      (tool) => tool.name === "claude-result",
    );
    assert.equal(result.inputSchema.properties.wait, undefined);
  });

  test("ping answers with an empty result", async () => {
    const response = await server.request("ping", {});
    assert.deepEqual(response.result, {});
  });

  test("unknown method returns -32601", async () => {
    const response = await server.request("unknown/method", {});
    assert.equal(response.error.code, -32601);
  });

  test("unknown tool returns -32602", async () => {
    const response = await server.call("nonexistent", {});
    assert.equal(response.error.code, -32602);
  });

  test("junk input does not crash the server", async () => {
    server.send({
      jsonrpc: "2.0",
      id: 9001,
      method: "tools/call",
      params: { name: "claude" }, // no arguments object at all
    });
    server.proc.stdin.write("not json at all\n");
    const response = await server.request("tools/list", {});
    assert.equal(response.result.tools.length, 4, "server still alive");
  });

  test("a tool that fails answers with a result, not a JSON-RPC error", async () => {
    // The consuming model only sees the result content, so a failure that is
    // reported as a protocol error is a failure it cannot read.
    const missingPrompt = await server.call("claude", { cwd: "/tmp" });
    assert.match(toolError(missingPrompt), /non-empty prompt/);

    const missingSession = await server.call("claude-reply", { prompt: "hi" });
    assert.match(toolError(missingSession), /requires a sessionId/);

    const badPromptType = await server.call("claude", { prompt: 42 });
    assert.match(toolError(badPromptType), /non-empty prompt/);
  });
});

describe("JSON-RPC envelopes", () => {
  const server = spawnServer();
  after(() => server.close());

  /**
   * Start recording what the server writes. Recording has to begin *before* the
   * input is fed: the answer to a bad envelope can be out before a large write
   * has even finished draining.
   *
   * `take()` waits `ms` when nothing is expected, or until `min` messages have
   * arrived.
   */
  function record() {
    const chunks = [];
    const collect = (chunk) => chunks.push(chunk);
    server.proc.stdout.on("data", collect);
    const parsed = () =>
      chunks
        .join("")
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line));

    return async ({ ms = 250, min = 0 } = {}) => {
      const deadline = Date.now() + ms;
      do {
        await sleep(25);
      } while (Date.now() < deadline && (min === 0 || parsed().length < min));
      server.proc.stdout.off("data", collect);
      return parsed();
    };
  }

  /** Write to the server's stdin and wait for the pipe to take all of it. */
  const feed = (text) =>
    new Promise((resolve) => server.proc.stdin.write(text, resolve));

  test("malformed JSON is a parse error with a null id", async () => {
    await server.init();
    const take = record();
    await feed("{not json\n");
    const [response] = await take({ min: 1 });
    assert.equal(response.error.code, -32700);
    assert.equal(response.id, null);
  });

  test("a structurally invalid envelope is -32600", async () => {
    const take = record();
    await feed(`${JSON.stringify({ id: 7, method: "ping" })}\n`);
    await feed(`${JSON.stringify([{ jsonrpc: "2.0" }])}\n`);
    const [noVersion, batch] = await take({ min: 2 });
    assert.equal(noVersion.error.code, -32600);
    assert.equal(noVersion.id, 7, "answered on the id it claimed");
    assert.equal(batch.error.code, -32600);
    assert.match(batch.error.message, /[Bb]atch/);
    assert.equal(batch.id, null);
  });

  test("a request with an explicit null id is answered on id null", async () => {
    const take = record();
    await feed(`${JSON.stringify({ jsonrpc: "2.0", id: null, method: "ping" })}\n`);
    const [response] = await take({ min: 1 });
    assert.deepEqual(response.result, {});
    assert.equal(response.id, null, "null id is echoed, not dropped");
  });

  test("a request method sent without an id gets no response", async () => {
    const take = record();
    server.send({ jsonrpc: "2.0", method: "tools/list", params: {} });
    server.send({ jsonrpc: "2.0", method: "initialize", params: {} });
    assert.deepEqual(await take(), []);
  });

  test("a notification method sent with an id is -32600", async () => {
    const take = record();
    server.send({ jsonrpc: "2.0", id: 8, method: "notifications/initialized" });
    const [response] = await take({ min: 1 });
    assert.equal(response.error.code, -32600);
    assert.equal(response.id, 8);
  });

  test("an oversized line is rejected even when its newline arrives with it", async () => {
    // Grown to just under the limit without a newline — the buffered-length
    // guard never trips — then completed by one small chunk carrying both the
    // overflow and the terminator. The line is a syntactically valid ping, so
    // reaching the parser would *answer* it.
    const MAX = 10 * 1024 * 1024;
    const head = '{"jsonrpc":"2.0","id":4242,"method":"ping","params":{"pad":"';
    const take = record();
    await feed(head + "x".repeat(MAX - 500 - head.length));
    await feed(`${"x".repeat(1500)}"}}\n`);
    const responses = await take({ ms: 5000, min: 1 });
    assert.equal(responses[0].error.code, -32700);
    assert.match(responses[0].error.message, /exceeds/);
    assert.equal(responses[0].id, null);
    assert.ok(
      responses.every((r) => r.id !== 4242),
      "the oversized ping must never be answered",
    );
    const alive = await server.request("tools/list", {});
    assert.equal(alive.result.tools.length, 4, "server still alive");
  });

  test("an over-long line is rejected without being buffered", async () => {
    const take = record();
    await feed(`{"padding":"${"x".repeat(11 * 1024 * 1024)}`);
    const [response] = await take({ ms: 5000, min: 1 });
    assert.equal(response.error.code, -32700);
    assert.match(response.error.message, /exceeds/);

    // The tail of the discarded line must not be parsed as a message.
    const takeTail = record();
    await feed('"}\n');
    assert.deepEqual(await takeTail(), []);
    const alive = await server.request("tools/list", {});
    assert.equal(alive.result.tools.length, 4, "server still alive");
  });
});
