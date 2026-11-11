import test, { after, describe } from "node:test";
import assert from "node:assert/strict";
import { spawnServer, sleep } from "../helpers/harness.mjs";

const meta = (version = "2026-07-28", capabilities = {}) => ({
  "io.modelcontextprotocol/protocolVersion": version,
  "io.modelcontextprotocol/clientCapabilities": capabilities,
});
const params = (values = {}) => ({ ...values, _meta: meta() });

describe("MCP 2026-07-28", () => {
  const server = spawnServer();
  after(() => server.close());

  test("discovery and catalog work without initialize", async () => {
    const { result } = await server.request("server/discover", params());
    assert.equal(result.resultType, "complete");
    assert.deepEqual(result.supportedVersions, ["2026-07-28"]);
    assert.deepEqual(result.capabilities, { tools: {} });
    assert.equal(result._meta["io.modelcontextprotocol/serverInfo"].name, "claude-code-mcp");
    assert.match(result.instructions, /read-only/);
    const first = await server.request("tools/list", params());
    assert.equal(first.result.resultType, "complete");
    assert.equal(first.result.cacheScope, "public");
    assert.equal(first.result.ttlMs, 300000);
    assert.equal(first.result.tools.length, 4);
    const second = await server.request("tools/list", params());
    assert.deepEqual(first.result, second.result);
  });

  test("version and capabilities are checked per request", async () => {
    for (const [metadata, code] of [
      [{}, -32602],
      [meta("2099-01-01"), -32022],
      [meta("2026-07-28", null), -32602],
      [meta("2026-07-28", []), -32602],
    ]) {
      const response = await server.request("server/discover", { _meta: metadata });
      assert.equal(response.error.code, code);
      if (code === -32022) assert.deepEqual(response.error.data, {
        supported: ["2026-07-28"], requested: "2099-01-01",
      });
    }
    assert.equal((await server.request("ping", params())).result.resultType, "complete");
    assert.equal((await server.request("ping", {})).result.resultType, undefined);
  });

  test("handshake-free tools keep the async session contract", async () => {
    const start = await server.request("tools/call", params({
      name: "claude", arguments: { prompt: "#work=100 modern", cwd: "/tmp" },
    }));
    assert.equal(start.result.resultType, "complete");
    const { sessionId } = JSON.parse(start.result.content[0].text);
    assert.ok(sessionId);
    let snapshot;
    for (let i = 0; i < 100; i++) {
      const response = await server.request("tools/call", params({
        name: "claude-result", arguments: { sessionId },
      }));
      snapshot = JSON.parse(response.result.content[0].text);
      if (snapshot.done) break;
      await sleep(10);
    }
    assert.equal(snapshot.status, "succeeded");
    const reply = await server.request("tools/call", params({
      name: "claude-reply", arguments: { sessionId, prompt: "#work=1000 again", cwd: "/tmp" },
    }));
    assert.equal(JSON.parse(reply.result.content[0].text).sessionId, sessionId);
    const cancel = await server.request("tools/call", params({
      name: "claude-cancel", arguments: { sessionId },
    }));
    assert.equal(cancel.result.resultType, "complete");
  });

  test("overlapping legacy and modern calls retain their own response format", async () => {
    const modern = server.request("tools/call", params({
      name: "claude", arguments: { prompt: "#init=100 modern", cwd: "/tmp" },
    }));
    const legacy = await server.call("claude", { prompt: "#init=5 legacy", cwd: "/tmp" });
    assert.equal(legacy.result.resultType, undefined);
    assert.equal((await modern).result.resultType, "complete");
    const init = await server.init();
    assert.equal(init.result.protocolVersion, "2024-11-05");
    assert.equal(init.result.resultType, undefined);
    assert.equal((await server.request("ping", params())).result.resultType, "complete");
  });

  test("cancelled ids can be reused by non-tool requests in the same stdin chunk", async () => {
    for (const method of ["ping", "tools/list", "server/discover"]) {
      const messages = [];
      const collect = (chunk) => messages.push(chunk);
      const id = "reuse-" + method;
      server.proc.stdout.on("data", collect);
      try {
        server.send({ jsonrpc: "2.0", id, method: "tools/call", params: params({
          name: "claude", arguments: { prompt: "#init=1000 cancelled", cwd: "/tmp" },
        }) });
        // A ping round trip ensures the delayed call has entered liveCalls.
        await server.request("ping", params());
        server.proc.stdin.write([
          { jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId: id } },
          { jsonrpc: "2.0", id, method, params: params() },
        ].map((message) => JSON.stringify(message)).join("\n") + "\n");
        await server.request("ping", params());
        await sleep(30);
        const replies = messages.join("").trim().split("\n")
          .map((line) => JSON.parse(line)).filter((message) => message.id === id);
        assert.equal(replies.length, 1, method + " should answer exactly once");
        assert.equal(replies[0].result.resultType, "complete");
      } finally {
        server.proc.stdout.off("data", collect);
      }
    }
  });

  test("cancelled startup stays silent after modern request-id reuse", async () => {
    const messages = [];
    const collect = (chunk) => messages.push(chunk);
    server.proc.stdout.on("data", collect);
    try {
      server.send({ jsonrpc: "2.0", id: "cancelled", method: "tools/call", params: params({
        name: "claude", arguments: { prompt: "#init=1000 cancel me", cwd: "/tmp" },
      }) });
      await sleep(30);
      server.send({ jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId: "cancelled" } });
      const response = await server.requestWithId("cancelled", "tools/call", params({
        name: "claude", arguments: { prompt: "#init=5 replacement", cwd: "/tmp" },
      }));
      assert.equal(response.result.resultType, "complete");
      await sleep(1100);
      const replies = messages.join("").trim().split("\n").map((line) => JSON.parse(line));
      assert.equal(replies.filter((m) => m.id === "cancelled").length, 1);
    } finally {
      server.proc.stdout.off("data", collect);
    }
  });
});
