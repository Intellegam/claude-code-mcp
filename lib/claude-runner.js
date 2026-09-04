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
import { canonicalizeCwd } from "./cwd.js";
import { buildQueryOptions } from "./isolation.js";

/** Keep the tail of the child's stderr for error messages. */
const MAX_STDERR_BYTES = 8 * 1024;

/**
 * Resolve the SDK module that provides `query` and session metadata.
 *
 * `CLAUDE_CODE_MCP_QUERY_MODULE` swaps in a module exporting a compatible
 * `query()`. The unit tier uses it to drive the real runner state machine with
 * scripted SDK messages and no child process.
 */
export async function loadSdk(env = process.env) {
  const override = env.CLAUDE_CODE_MCP_QUERY_MODULE;
  const specifier = override
    ? pathToFileURL(override).href
    : "@anthropic-ai/claude-agent-sdk";
  const mod = await import(specifier);
  if (typeof mod.query !== "function") {
    throw new Error(`Module ${specifier} does not export a query() function`);
  }
  return mod;
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
export function normalizeResult(message, servingModel = null) {
  const rawErrors = Array.isArray(message?.errors) ? message.errors : [];
  const errors = rawErrors
    .map((err) => (typeof err === "string" ? err : err?.message))
    .filter(Boolean);

  const subtype = message?.subtype ?? null;
  return {
    subtype,
    isError: message?.is_error === true || (subtype != null && subtype !== "success"),
    terminalReason: message?.terminal_reason ?? null,
    text: typeof message?.result === "string" ? message.result : "",
    errors,
    modelContextWindow: resolveContextWindow(
      message?.modelUsage,
      servingModel,
    ),
  };
}

function nonNegativeNumber(value) {
  return Number.isFinite(value) && value >= 0 ? Number(value) : 0;
}

/** Current input context for one real assistant request. */
export function normalizeAssistantUsage(message) {
  const usage = message?.message?.usage;
  if (!usage || typeof usage !== "object") return null;
  const inputTokens = nonNegativeNumber(usage.input_tokens);
  const cacheCreationInputTokens = nonNegativeNumber(
    usage.cache_creation_input_tokens,
  );
  const cacheReadInputTokens = nonNegativeNumber(usage.cache_read_input_tokens);
  const inputContextTokens =
    inputTokens + cacheCreationInputTokens + cacheReadInputTokens;
  // Synthetic/status assistant rows have zero usage and must not erase the
  // latest real request's context.
  if (inputContextTokens === 0) return null;
  const outputTokens = nonNegativeNumber(usage.output_tokens);
  return {
    contextTokens: inputContextTokens + outputTokens,
  };
}

/** Normalize the public compact-boundary fields and drop malformed events. */
export function normalizeCompactBoundary(message) {
  const metadata = message?.compact_metadata;
  if (!metadata || !Number.isFinite(metadata.pre_tokens)) return null;
  return {
    trigger: metadata.trigger === "manual" ? "manual" : "auto",
    preTokens: Number(metadata.pre_tokens),
    postTokens: Number.isFinite(metadata.post_tokens)
      ? Number(metadata.post_tokens)
      : null,
    durationMs: Number.isFinite(metadata.duration_ms)
      ? Number(metadata.duration_ms)
      : null,
  };
}

/** Authoritative context state returned by the SDK control protocol. */
export function normalizeContextUsage(usage) {
  if (!usage || !Number.isFinite(usage.totalTokens)) return null;
  return {
    contextTokens: Number(usage.totalTokens),
    contextWindow: Number.isFinite(usage.maxTokens)
      ? Number(usage.maxTokens)
      : null,
    modelContextWindow: Number.isFinite(usage.rawMaxTokens)
      ? Number(usage.rawMaxTokens)
      : null,
    contextPercent: Number.isFinite(usage.percentage)
      ? Number(usage.percentage)
      : null,
    autoCompactThreshold: Number.isFinite(usage.autoCompactThreshold)
      ? Number(usage.autoCompactThreshold)
      : null,
    isAutoCompactEnabled:
      typeof usage.isAutoCompactEnabled === "boolean"
        ? usage.isAutoCompactEnabled
        : null,
  };
}

function resolveContextWindow(modelUsage, servingModel) {
  if (!modelUsage || typeof modelUsage !== "object") return null;
  const entries = Object.entries(modelUsage);
  const exact = servingModel
    ? entries.find(([model]) => model === servingModel)?.[1]?.contextWindow
    : null;
  if (Number.isFinite(exact) && exact > 0) return Number(exact);
  if (entries.length !== 1) return null;
  const only = entries[0]?.[1]?.contextWindow;
  return Number.isFinite(only) && only > 0 ? Number(only) : null;
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

  getStderr() {
    return this.#stderr;
  }

  /**
   * Start the turn. Returns immediately; progress is reported through `events`:
   *   onInit(sessionId)      — `system/init` seen (once per turn)
   *   onModel(model)         — the serving model, as `system/init` resolved it
   *                            and as each assistant message reports it
   *   onText(text)           — an assistant message's text
   *   onUsage(usage)         — current input context for an assistant request
   *   onCompact(boundary)    — normalized `system/compact_boundary` metadata
   *   onContextUsage(usage)  — authoritative SDK context/threshold snapshot
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
    let servingModel = null;
    try {
      for await (const message of this.#q) {
        if (message?.type === "system" && message.subtype === "init") {
          if (!this.#initialized) {
            this.#initialized = true;
            if (message.model) {
              servingModel = message.model;
              events.onModel?.(message.model);
            }
            events.onInit?.(message.session_id ?? null);
            if (this.#cancelPending) this.#sendInterrupt();
          }
          continue;
        }
        if (message?.type === "assistant") {
          const model = message.message?.model;
          if (model) {
            servingModel = model;
            events.onModel?.(model);
          }
          const text = extractAssistantText(message);
          if (text) events.onText?.(text);
          const usage = normalizeAssistantUsage(message);
          if (usage) events.onUsage?.(usage);
          continue;
        }
        if (
          message?.type === "system" &&
          message.subtype === "compact_boundary"
        ) {
          const boundary = normalizeCompactBoundary(message);
          if (boundary) events.onCompact?.(boundary);
          continue;
        }
        if (message?.type === "result") {
          this.#sawResult = true;
          const result = normalizeResult(message, servingModel);
          // Error and interrupted turns must settle immediately. A successful
          // turn can afford one bounded control read while stdin is still open.
          if (!result.isError && !this.#closed && !this.#interruptSent) {
            const contextUsage = await this.#readContextUsage();
            if (contextUsage) events.onContextUsage?.(contextUsage);
          }
          // Settle first, release the prompt stream second: releasing closes
          // the child's stdin and can make the iterator throw.
          events.onResult?.(result);
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

  async #readContextUsage() {
    if (typeof this.#q?.getContextUsage !== "function") return null;
    let timer;
    try {
      const raw = await Promise.race([
        this.#q.getContextUsage({ detail: "summary" }),
        new Promise((resolve) => {
          timer = setTimeout(() => resolve(null), 1_000);
          timer.unref?.();
        }),
      ]);
      return normalizeContextUsage(raw);
    } catch {
      return null;
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
}

/**
 * Runner factory used by the engine. A post-restart resume asks the SDK for
 * persisted metadata before starting so its original cwd remains enforceable
 * even though CLI 2.1.258 can locate sessions globally.
 */
export function createRunnerFactory({ query, getSessionInfo }) {
  return function createRunner({
    cwd,
    writable = false,
    resume = null,
    verifyResumeCwd = false,
  } = {}) {
    const scopedQuery =
      resume && verifyResumeCwd && typeof getSessionInfo === "function"
        ? function validateResumeCwd(args) {
            let closed = false;
            let activeQuery = null;
            let signalClosed;
            const closedQuery = new Promise((resolve) => {
              signalClosed = () => resolve(null);
            });
            const pendingQuery = (async () => {
              const persisted = await getSessionInfo(resume);
              if (!persisted?.cwd) {
                throw new Error(
                  `Cannot resume Claude session ${resume}: its original cwd could not be verified from persisted session metadata`,
                );
              }
              const expected = canonicalizeCwd(persisted.cwd);
              const actual = canonicalizeCwd(cwd);
              if (actual !== expected) {
                throw new Error(
                  `Claude session ${resume} must be resumed from the same cwd the session was created in (expected: ${expected}, got: ${actual})`,
                );
              }
              if (closed) return null;
              activeQuery = query(args);
              return activeQuery;
            })();

            return {
              async *[Symbol.asyncIterator]() {
                const active = await Promise.race([pendingQuery, closedQuery]);
                if (active) yield* active;
              },
              async interrupt() {
                const active = await Promise.race([pendingQuery, closedQuery]);
                await active?.interrupt?.();
              },
              async close() {
                closed = true;
                signalClosed();
                await activeQuery?.close?.();
              },
              async getContextUsage(options) {
                const active = await Promise.race([pendingQuery, closedQuery]);
                return active?.getContextUsage?.(options);
              },
            };
          }
        : query;
    return new ClaudeRunner({
      query: scopedQuery,
      options: buildQueryOptions({ cwd, writable, resume }),
    });
  };
}
