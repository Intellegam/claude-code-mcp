import test, { after, describe } from "node:test";
import assert from "node:assert/strict";
import {
  REPO_ROOT,
  mockTrailer,
  sessionIdFrom,
  spawnServer,
} from "../helpers/harness.mjs";

describe("sync tool calls", () => {
  const server = spawnServer();
  after(() => server.close());

  test("claude returns output and a session id trailer", async (t) => {
    await server.init();
    const response = await server.call("claude", { prompt: "hello" });
    assert.equal(response.error, undefined);
    const texts = response.result.content.map((c) => c.text);
    assert.match(texts[0], /Mock response to: hello/);
    assert.match(texts[1], /\[SESSION_ID: mock-/);
  });

  test("the prompt stream is held open until the turn settles", async () => {
    const response = await server.call("claude", { prompt: "hold" });
    const trailer = mockTrailer(response.result.content[0].text);
    assert.equal(trailer.promptHeldOpen, true);
  });

  test("claude-reply resumes the same session", async () => {
    const first = await server.call("claude", { prompt: "first" });
    const sessionId = sessionIdFrom(first);

    const reply = await server.call("claude-reply", {
      sessionId,
      prompt: "follow-up",
    });
    assert.equal(reply.error, undefined);
    assert.match(reply.result.content[0].text, /Mock response to: follow-up/);
    assert.equal(sessionIdFrom(reply), sessionId);
    assert.equal(mockTrailer(reply.result.content[0].text).resume, sessionId);
  });

  test("a reply inherits the session's writable mode", async () => {
    const first = await server.call("claude", { prompt: "start", writable: true });
    const sessionId = sessionIdFrom(first);
    const reply = await server.call("claude-reply", { sessionId, prompt: "more" });
    const trailer = mockTrailer(reply.result.content[0].text);
    assert.equal(trailer.permissionMode, "bypassPermissions");
  });

  test("a reply cannot grant itself write access", async () => {
    const first = await server.call("claude", { prompt: "start" });
    const sessionId = sessionIdFrom(first);
    // `writable` is undeclared on claude-reply; an unknown argument must not
    // upgrade a read-only session.
    const reply = await server.call("claude-reply", {
      sessionId,
      prompt: "more",
      writable: true,
    });
    assert.equal(mockTrailer(reply.result.content[0].text).permissionMode, null);
  });

  test("resuming an unknown session explains the cwd requirement", async () => {
    const response = await server.call("claude-reply", {
      sessionId: "does-not-exist",
      prompt: "#noinit hello",
      cwd: REPO_ROOT,
    });
    assert.ok(response.error, "expected an error");
    assert.match(response.error.message, /No conversation found with session ID/);
    assert.match(response.error.message, /same cwd the session was created in/);
    assert.match(response.error.message, new RegExp(REPO_ROOT));
  });

  test("an error result fails the call with the SDK's error text", async () => {
    const response = await server.call("claude", { prompt: "#error boom" });
    assert.ok(response.error);
    assert.match(response.error.message, /mock failure/);
  });

  test("an error result without errors[] is handled, not crashed on", async () => {
    const response = await server.call("claude", { prompt: "#error-bare boom" });
    assert.ok(response.error);
    assert.match(response.error.message, /error_during_execution/);
    // Server survives.
    const after = await server.call("claude", { prompt: "still alive" });
    assert.match(after.result.content[0].text, /Mock response to: still alive/);
  });

  test("an iterator throw fails the turn, with the child's stderr", async () => {
    const response = await server.call("claude", {
      prompt: "#throw #stderr=disk_on_fire nope",
    });
    assert.ok(response.error);
    assert.match(response.error.message, /mock: stream exploded/);
    assert.match(response.error.message, /stderr: disk on fire/);
  });
});
