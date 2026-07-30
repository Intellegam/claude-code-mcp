/**
 * SDK adapter: one `ClaudeRunner` per turn.
 *
 * Unlike the sibling codex-mcp server there is no persistent daemon — the SDK
 * spawns a Claude Code CLI child per `query()`, and continuity across turns
 * comes from `resume: <sessionId>` (Claude persists transcripts on disk, keyed
 * by session id *and* cwd).
 *
 * The two non-obvious mechanics, both established empirically:
 *
 * 1. HOLD-OPEN PROMPT. The prompt is an AsyncIterable that yields exactly one
 *    user message and then blocks. If the iterable completes, the SDK closes
 *    the child's stdin immediately and `interrupt()` silently becomes a no-op —
 *    a turn can then never be cancelled. The iterable is only released once the
 *    turn has settled.
 *
 * 2. INTERRUPT GATING. Before `system/init` an `interrupt()` resolves but does
 *    nothing. Cancels arriving in that window (~350ms, and longer for a
 *    `claude-reply` whose session id is known up front) are buffered and sent
 *    exactly once when init is observed.
 *
 * The runner reports raw-ish events; mapping to terminal states is the engine's
 * job (see lib/engine.js).
 */

import { pathToFileURL } from "node:url";
import { buildQueryOptions } from "./isolation.js";

/** Keep the tail of the child's stderr for error messages. */
const MAX_STDERR_BYTES = 8 * 1024;

/**
 * Resolve the SDK `query` implementation.
 *
 * `CLAUDE_CODE_MCP_QUERY_MODULE` swaps in a module exporting a compatible
 * `query()`. The unit tier uses it to drive the real runner state machine with
 * scripted SDK messages and no child process.
 */
export async function loadQuery(env = process.env) {
  const override = env.CLAUDE_CODE_MCP_QUERY_MODULE;
  const specifier = override
    ? pathToFileURL(override).href
    : "@anthropic-ai/claude-agent-sdk";
  const mod = await import(specifier);
  if (typeof mod.query !== "function") {
    throw new Error(`Module ${specifier} does not export a query() function`);
  }
  return mod.query;
}

function extractAssistantText(message) {
  const content = message?.message?.content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((block) => block?.type === "text" && typeof block.text === "string")
    .map((block) => block.text)
    .join("");
}

/**
 * Normalize a `result` message.
 *
 * Defensive on `errors`: the SDK emits error results without an `errors[]`
 * array, and code that assumes the array is present crashes on them.
 */
export function normalizeResult(message) {
  const rawErrors = Array.isArray(message?.errors) ? message.errors : [];
  const errors = rawErrors
    .map((err) => {
      if (typeof err === "string") return err;
      if (err && typeof err.message === "string") return err.message;
      try {
        return JSON.stringify(err);
      } catch {
        return String(err);
      }
    })
    .filter(Boolean);

  const subtype = message?.subtype ?? null;
  return {
    subtype,
    isError: message?.is_error === true || (subtype != null && subtype !== "success"),
    terminalReason: message?.terminal_reason ?? null,
    text: typeof message?.result === "string" ? message.result : "",
    errors,
  };
}

export class ClaudeRunner {
  #query;
  #options;
  #q = null;
  #releasePrompt = null;
  #initialized = false;
  #cancelPending = false;
  #interruptSent = false;
  #sawResult = false;
  #closed = false;
  #stderr = "";

  constructor({ query, options }) {
    this.#query = query;
    this.#options = options;
  }

  get initialized() {
    return this.#initialized;
  }

  get interruptSent() {
    return this.#interruptSent;
  }

  getStderr() {
    return this.#stderr;
  }

  /**
   * Start the turn. Returns immediately; progress is reported through `events`:
   *   onInit(sessionId)      — `system/init` seen (once per turn)
   *   onText(text)           — an assistant message's text
   *   onResult(result)       — normalized `result` message (settle here)
   *   onDone(error, stderr)  — the message stream ended; `error` is set only for
   *                            an unexpected throw with no result observed
   */
  start(promptText, events = {}) {
    let release;
    const gate = new Promise((resolve) => {
      release = resolve;
    });
    this.#releasePrompt = release;

    const promptStream = (async function* holdOpenPrompt() {
      yield {
        type: "user",
        session_id: "",
        parent_tool_use_id: null,
        message: { role: "user", content: promptText },
      };
      // Never complete before the turn settles — see the header comment.
      await gate;
    })();

    this.#q = this.#query({
      prompt: promptStream,
      options: {
        ...this.#options,
        stderr: (chunk) => this.#captureStderr(chunk),
      },
    });

    void this.#consume(events);
  }

  /** Request cancellation. Buffered until init if the turn is not up yet. */
  interrupt() {
    if (this.#interruptSent || this.#closed) return;
    if (!this.#initialized) {
      this.#cancelPending = true;
      return;
    }
    this.#sendInterrupt();
  }

  /** Idempotent teardown. Also the force path for the cancel watchdog. */
  async close() {
    if (this.#closed) return;
    this.#closed = true;
    this.#releasePrompt?.();
    try {
      await this.#q?.close?.();
    } catch {
      // The child may already be gone; nothing useful to do.
    }
  }

  #sendInterrupt() {
    if (this.#interruptSent) return;
    this.#interruptSent = true;
    this.#cancelPending = false;
    try {
      Promise.resolve(this.#q?.interrupt?.()).catch(() => {});
    } catch {
      // interrupt() is best-effort; the watchdog is the backstop.
    }
  }

  #captureStderr(chunk) {
    this.#stderr += String(chunk);
    if (this.#stderr.length > MAX_STDERR_BYTES) {
      this.#stderr = this.#stderr.slice(-MAX_STDERR_BYTES);
    }
  }

  async #consume(events) {
    let doneError = null;
    try {
      for await (const message of this.#q) {
        if (message?.type === "system" && message.subtype === "init") {
          if (!this.#initialized) {
            this.#initialized = true;
            events.onInit?.(message.session_id ?? null);
            if (this.#cancelPending) this.#sendInterrupt();
          }
          continue;
        }
        if (message?.type === "assistant") {
          const text = extractAssistantText(message);
          if (text) events.onText?.(text);
          continue;
        }
        if (message?.type === "result") {
          this.#sawResult = true;
          // Settle first, release the prompt stream second: releasing closes
          // the child's stdin and can make the iterator throw.
          events.onResult?.(normalizeResult(message));
          this.#releasePrompt?.();
        }
      }
    } catch (err) {
      // After an error-result the SDK's iterator throws
      // ("Claude Code returned an error result: ..."). That throw is expected
      // and carries no information the result did not — suppress it. Any throw
      // *without* a preceding result is a genuine failure.
      if (!this.#sawResult) doneError = err;
    } finally {
      this.#releasePrompt?.();
      await this.close();
      events.onDone?.(doneError, this.getStderr());
    }
  }
}

/**
 * Runner factory used by the engine. `createRunner({cwd, writable, resume})`
 * returns a started-on-demand `ClaudeRunner`.
 */
export function createRunnerFactory({ query, buildOptions = buildQueryOptions }) {
  return function createRunner({ cwd, writable = false, resume = null } = {}) {
    return new ClaudeRunner({
      query,
      options: buildOptions({ cwd, writable, resume }),
    });
  };
}
