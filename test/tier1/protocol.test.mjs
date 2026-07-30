import test, { after, describe } from "node:test";
import assert from "node:assert/strict";
import { spawnServer } from "../helpers/harness.mjs";

describe("MCP protocol", () => {
  const server = spawnServer();
  after(() => server.close());

  test("initialize returns server info and instructions", async () => {
    const response = await server.init();
    assert.equal(response.result.protocolVersion, "2024-11-05");
    assert.equal(response.result.serverInfo.name, "claude-code-mcp");
    assert.equal(response.result.serverInfo.version, "0.1.0");
    assert.match(response.result.instructions, /second opinion/i);
    assert.match(response.result.instructions, /read-only/i);
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
    assert.ok(claude.inputSchema.properties.async);
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

  test("malformed tool args produce an error, not a hang", async () => {
    const missingPrompt = await server.call("claude", { cwd: "/tmp" });
    assert.equal(missingPrompt.error.code, -32603);
    assert.match(missingPrompt.error.message, /non-empty prompt/);

    const missingSession = await server.call("claude-reply", { prompt: "hi" });
    assert.match(missingSession.error.message, /requires a sessionId/);

    const badPromptType = await server.call("claude", { prompt: 42 });
    assert.match(badPromptType.error.message, /non-empty prompt/);
  });
});
