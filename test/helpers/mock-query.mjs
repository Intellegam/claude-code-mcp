/**
 * Mock of the Claude Agent SDK's `query()`, injected via
 * CLAUDE_CODE_MCP_QUERY_MODULE. It emits SDK-shaped messages with controllable
 * timing and no child process, so the unit tier drives the *real* ClaudeRunner
 * state machine (hold-open prompt, interrupt gating, result mapping).
 *
 * Behaviour is steered by directives at the start of the prompt, which keeps
 * per-call control even through the MCP boundary:
 *
 *   #init=<ms>   delay before `system/init`             (default 5)
 *   #work=<ms>   delay between init and the result      (default 5)
 *   #noinit      never emit init; error result + stderr (bad resume)
 *   #error       error result, with `errors[]` populated
 *   #error-bare  error result *without* an `errors[]` array
 *   #throw       iterator throws, no result at all
 *   #compact     emit one auto compact boundary
 *   #context-usage return an SDK context-usage control snapshot
 *   #context-usage-hang never answer that control request
 *   #stderr=<t>  write <t> to the stderr callback
 *
 * Every success result carries a `[[mock:{...}]]` trailer describing the
 * options the runner passed in, so tests can assert on wiring and resume.
 */

import crypto from "node:crypto";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function parseDirectives(text) {
  const directives = {
    initMs: 5,
    workMs: 5,
    noinit: false,
    error: false,
    errorBare: false,
    throw: false,
    compact: false,
    contextUsage: false,
    contextUsageHang: false,
    stderr: "",
  };
  const words = String(text).split(/\s+/);
  let i = 0;
  for (; i < words.length; i++) {
    const word = words[i];
    if (!word.startsWith("#")) break;
    const [key, value] = word.slice(1).split("=");
    switch (key) {
      case "init":
        directives.initMs = Number(value) || 0;
        break;
      case "work":
        directives.workMs = Number(value) || 0;
        break;
      case "noinit":
        directives.noinit = true;
        break;
      case "error":
        directives.error = true;
        break;
      case "error-bare":
        directives.errorBare = true;
        break;
      case "throw":
        directives.throw = true;
        break;
      case "compact":
        directives.compact = true;
        break;
      case "context-usage":
        directives.contextUsage = true;
        break;
      case "context-usage-hang":
        directives.contextUsageHang = true;
        break;
      case "stderr":
        directives.stderr = (value || "").replace(/_/g, " ");
        break;
      default:
        break;
    }
  }
  return { directives, prompt: words.slice(i).join(" ") };
}

/** Minimal async channel: push messages, end with completion or an error. */
class Channel {
  #items = [];
  #waiters = [];
  #ended = false;
  #error = null;

  push(value) {
    if (this.#ended) return;
    const waiter = this.#waiters.shift();
    if (waiter) waiter.resolve({ value, done: false });
    else this.#items.push(value);
  }

  end(error = null) {
    if (this.#ended) return;
    this.#ended = true;
    this.#error = error;
    while (this.#waiters.length) {
      const waiter = this.#waiters.shift();
      if (error) waiter.reject(error);
      else waiter.resolve({ value: undefined, done: true });
    }
  }

  next() {
    if (this.#items.length) {
      return Promise.resolve({ value: this.#items.shift(), done: false });
    }
    if (this.#ended) {
      return this.#error
        ? Promise.reject(this.#error)
        : Promise.resolve({ value: undefined, done: true });
    }
    return new Promise((resolve, reject) =>
      this.#waiters.push({ resolve, reject }),
    );
  }
}

export function query({ prompt, options = {} }) {
  const channel = new Channel();
  const state = {
    initialized: false,
    interrupts: 0,
    preInitInterrupts: 0,
    promptClosed: false,
    closed: false,
    contextUsage: null,
    contextUsageHang: false,
  };

  let signalInterrupt;
  const interrupted = new Promise((resolve) => {
    signalInterrupt = resolve;
  });
  let signalPromptClosed;
  const promptClosed = new Promise((resolve) => {
    signalPromptClosed = resolve;
  });

  const trailer = () =>
    `\n[[mock:${JSON.stringify({
      resume: options.resume ?? null,
      cwd: options.cwd ?? null,
      permissionMode: options.permissionMode ?? null,
      settings: options.settings ? JSON.parse(options.settings) : null,
      promptHeldOpen: !state.promptClosed,
    })}]]`;

  async function drive() {
    // Consume the hold-open prompt stream.
    const iterator = prompt[Symbol.asyncIterator]();
    const first = await iterator.next();
    const promptText = first.value?.message?.content ?? "";
    iterator.next().then(() => {
      state.promptClosed = true;
      signalPromptClosed();
    });

    const { directives, prompt: cleanPrompt } = parseDirectives(promptText);
    state.contextUsageHang = directives.contextUsageHang;
    if (directives.contextUsage) {
      state.contextUsage = {
        totalTokens: 65,
        maxTokens: 320_000,
        rawMaxTokens: 1_000_000,
        percentage: 0,
        autoCompactThreshold: 287_000,
        isAutoCompactEnabled: true,
      };
    }
    const sessionId = options.resume || `mock-${crypto.randomUUID()}`;
    if (directives.stderr) options.stderr?.(`${directives.stderr}\n`);

    await sleep(directives.initMs);
    if (state.closed) return;

    if (directives.noinit) {
      options.stderr?.(
        `No conversation found with session ID: ${options.resume ?? "unknown"}\n`,
      );
      channel.push({
        type: "result",
        subtype: "error_during_execution",
        is_error: true,
        result: "",
        errors: [],
      });
      await promptClosed;
      channel.end(new Error("Claude Code returned an error result: [no_session]"));
      return;
    }

    state.initialized = true;
    channel.push({
      type: "system",
      subtype: "init",
      session_id: sessionId,
      model: "mock-model-1",
      cwd: options.cwd,
      tools: ["Read", "Grep", "Glob"],
      mcp_servers: [],
      permissionMode: options.permissionMode ?? "default",
    });

    if (directives.throw) {
      await sleep(directives.workMs);
      channel.end(new Error("mock: stream exploded"));
      return;
    }

    const outcome = await Promise.race([
      sleep(directives.workMs).then(() => "complete"),
      interrupted.then(() => "interrupted"),
    ]);
    if (state.closed) return;

    if (outcome === "interrupted") {
      // The aborted result carries no text, so report the interrupt accounting
      // as a partial assistant message — it becomes the cancelled turn's output.
      channel.push({
        type: "assistant",
        session_id: sessionId,
        message: {
          role: "assistant",
          model: "mock-model-2",
          content: [
            {
              type: "text",
              text: `interrupt-report:${JSON.stringify({
                interrupts: state.interrupts,
                preInitInterrupts: state.preInitInterrupts,
              })}`,
            },
          ],
        },
      });
      // What a real successful interrupt looks like.
      channel.push({
        type: "result",
        subtype: "error_during_execution",
        is_error: true,
        terminal_reason: "aborted_streaming",
        result: "",
        errors: [],
      });
      await promptClosed;
      channel.end(
        new Error("Claude Code returned an error result: [ede_diagnostic] aborted"),
      );
      return;
    }

    if (directives.error || directives.errorBare) {
      const message = {
        type: "result",
        subtype: "error_during_execution",
        is_error: true,
        result: "",
      };
      // #error-bare omits `errors[]` entirely: naive readers crash on it.
      if (!directives.errorBare) message.errors = [{ message: "mock failure" }];
      channel.push(message);
      await promptClosed;
      channel.end(
        new Error("Claude Code returned an error result: [ede_diagnostic] failed"),
      );
      return;
    }

    if (directives.compact) {
      channel.push({
        type: "system",
        subtype: "compact_boundary",
        compact_metadata: {
          trigger: "auto",
          pre_tokens: 287_123,
          post_tokens: 42_000,
          duration_ms: 1_234,
        },
      });
    }

    channel.push({
      type: "assistant",
      session_id: sessionId,
      message: {
        role: "assistant",
        model: "mock-model-2",
        content: [{ type: "text", text: `Mock response to: ${cleanPrompt}` }],
        usage: {
          input_tokens: 10,
          cache_creation_input_tokens: 20,
          cache_read_input_tokens: 30,
          output_tokens: 5,
        },
      },
    });
    channel.push({
      type: "result",
      subtype: "success",
      is_error: false,
      result: `Mock response to: ${cleanPrompt}${trailer()}`,
      errors: [],
      modelUsage: {
        "mock-model-2": { contextWindow: 1_000_000 },
      },
    });
    // Mirrors the SDK: with a streaming prompt the iterator stays open for the
    // next turn until the prompt stream completes.
    await promptClosed;
    channel.end();
  }

  drive().catch((err) => channel.end(err));

  return {
    [Symbol.asyncIterator]() {
      return { next: () => channel.next() };
    },
    async interrupt() {
      if (!state.initialized) {
        // Matches the real SDK: pre-init interrupts resolve but do nothing.
        state.preInitInterrupts += 1;
        return;
      }
      state.interrupts += 1;
      signalInterrupt();
    },
    async close() {
      state.closed = true;
      channel.end();
    },
    async getContextUsage() {
      if (state.contextUsageHang) return new Promise(() => {});
      return state.contextUsage;
    },
  };
}
