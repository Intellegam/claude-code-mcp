/**
 * In-process mock of the Anthropic Messages API.
 *
 * The integration tier runs the *real* Claude Code CLI (bundled with the SDK)
 * against this instead of the real API: it makes the tests hermetic, fast and
 * deterministic, and it works on machines where the spawned CLI cannot complete
 * an OAuth login.
 *
 * `startMock({ turns })` scripts the assistant side turn by turn:
 *   { text: "..." }                       — a plain text answer
 *   { text: "...", slow: 30 }             — streamed line by line, 30ms apart
 *   { tool: "Write", input: {...} }       — a tool call
 *
 * Every request is recorded, including the `system` prompt, the `messages`
 * (which carry tool results from the previous step, and the project CLAUDE.md
 * the CLI loads natively) and the tool names offered to the model — that is how
 * isolation is asserted. `mainCalls()` returns the scripted turns.
 */

import http from "node:http";
import crypto from "node:crypto";

export function startMock({ turns = [], port = 0 } = {}) {
  const calls = [];
  let index = 0;

  const sse = (res, event, data) =>
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);

  const respond = (res, turn) => {
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
    });
    sse(res, "message_start", {
      type: "message_start",
      message: {
        id: `msg_${crypto.randomUUID()}`,
        type: "message",
        role: "assistant",
        model: "mock-model",
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: 10, output_tokens: 0 },
      },
    });

    if (turn.tool) {
      sse(res, "content_block_start", {
        type: "content_block_start",
        index: 0,
        content_block: {
          type: "tool_use",
          id: `toolu_${crypto.randomUUID().replace(/-/g, "").slice(0, 20)}`,
          name: turn.tool,
          input: {},
        },
      });
      sse(res, "content_block_delta", {
        type: "content_block_delta",
        index: 0,
        delta: {
          type: "input_json_delta",
          partial_json: JSON.stringify(turn.input ?? {}),
        },
      });
      sse(res, "content_block_stop", { type: "content_block_stop", index: 0 });
      sse(res, "message_delta", {
        type: "message_delta",
        delta: { stop_reason: "tool_use", stop_sequence: null },
        usage: { output_tokens: 20 },
      });
      sse(res, "message_stop", { type: "message_stop" });
      res.end();
      return;
    }

    const text = turn.text ?? "MOCK-DONE";
    sse(res, "content_block_start", {
      type: "content_block_start",
      index: 0,
      content_block: { type: "text", text: "" },
    });
    const chunks = turn.slow ? text.split(/(?<=\n)/) : [text];
    let i = 0;
    let closed = false;
    res.on("close", () => {
      closed = true;
    });
    const pump = () => {
      if (closed) return;
      if (i >= chunks.length) {
        sse(res, "content_block_stop", { type: "content_block_stop", index: 0 });
        sse(res, "message_delta", {
          type: "message_delta",
          delta: { stop_reason: "end_turn", stop_sequence: null },
          usage: { output_tokens: 20 },
        });
        sse(res, "message_stop", { type: "message_stop" });
        res.end();
        return;
      }
      sse(res, "content_block_delta", {
        type: "content_block_delta",
        index: 0,
        delta: { type: "text_delta", text: chunks[i++] },
      });
      if (turn.slow) setTimeout(pump, Number(turn.slow));
      else pump();
    };
    pump();
  };

  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
    });
    req.on("end", () => {
      if (!req.url.includes("/v1/messages")) {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end('{"ok":true}');
        return;
      }
      let payload = null;
      try {
        payload = JSON.parse(body);
      } catch {
        // fall through with a null payload
      }
      // Claude Code makes small side-calls (conversation titles, etc). Only the
      // calls carrying the full system prompt + tools are scripted turns.
      const isMainTurn = Array.isArray(payload?.tools) && payload.tools.length > 0;
      calls.push({
        at: Date.now(),
        isMainTurn,
        system: payload?.system,
        messages: payload?.messages,
        tools: (payload?.tools || []).map((tool) => tool.name),
      });
      if (!isMainTurn) {
        respond(res, { text: "side" });
        return;
      }
      const turn = turns[index] ?? { text: "MOCK-DONE" };
      index += 1;
      respond(res, turn);
    });
  });

  return new Promise((resolve) => {
    server.listen(port, "127.0.0.1", () => {
      const url = `http://127.0.0.1:${server.address().port}`;
      resolve({
        url,
        mainCalls: () => calls.filter((call) => call.isMainTurn),
        stop: () =>
          new Promise((done) => {
            server.closeAllConnections?.();
            server.close(done);
          }),
      });
    });
  });
}

/** Flatten a `system` field (string or content blocks) to plain text. */
export function systemText(system) {
  if (!system) return "";
  if (typeof system === "string") return system;
  return system
    .map((block) => (typeof block === "string" ? block : (block.text ?? "")))
    .join("\n");
}

/** All tool_result payloads visible in a recorded call's messages. */
export function toolResults(call) {
  const results = [];
  for (const message of call.messages || []) {
    const content = Array.isArray(message.content) ? message.content : [];
    for (const block of content) {
      if (block.type !== "tool_result") continue;
      const text =
        typeof block.content === "string"
          ? block.content
          : JSON.stringify(block.content);
      results.push({ isError: block.is_error === true, text });
    }
  }
  return results;
}
