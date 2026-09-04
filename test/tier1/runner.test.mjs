import test, { describe } from "node:test";
import assert from "node:assert/strict";
import {
  ClaudeRunner,
  createRunnerFactory,
  normalizeAssistantUsage,
  normalizeCompactBoundary,
  normalizeContextUsage,
  normalizeResult,
} from "../../lib/claude-runner.js";

describe("result normalization", () => {
  test("an error result without errors[] does not throw", () => {
    const result = normalizeResult({
      type: "result",
      subtype: "error_during_execution",
      is_error: true,
    });
    assert.equal(result.isError, true);
    assert.deepEqual(result.errors, []);
    assert.equal(result.text, "");
  });

  test("error objects and strings both become messages", () => {
    const result = normalizeResult({
      type: "result",
      subtype: "error_during_execution",
      is_error: true,
      errors: ["plain string", { message: "object error" }, { code: 7 }],
    });
    assert.deepEqual(result.errors, ["plain string", "object error"]);
  });

  test("uses the serving model's context window, not a helper model's", () => {
    const result = normalizeResult(
      {
        type: "result",
        subtype: "success",
        modelUsage: {
          serving: { contextWindow: 200_000 },
          helper: { contextWindow: 1_000_000 },
        },
      },
      "serving",
    );
    assert.equal(result.modelContextWindow, 200_000);
  });
});

describe("context telemetry normalization", () => {
  test("context includes direct, cache-write, cache-read, and output tokens", () => {
    assert.deepEqual(
      normalizeAssistantUsage({
        message: {
          usage: {
            input_tokens: 7,
            cache_creation_input_tokens: 11,
            cache_read_input_tokens: 13,
            output_tokens: 17,
          },
        },
      }),
      {
        contextTokens: 48,
      },
    );
  });

  test("zero-token synthetic assistant rows do not erase context", () => {
    assert.equal(
      normalizeAssistantUsage({
        message: {
          usage: {
            input_tokens: 0,
            cache_creation_input_tokens: 0,
            cache_read_input_tokens: 0,
          },
        },
      }),
      null,
    );
  });

  test("compact boundaries retain trigger and token counts", () => {
    assert.deepEqual(
      normalizeCompactBoundary({
        compact_metadata: {
          trigger: "auto",
          pre_tokens: 287_123,
          post_tokens: 42_000,
          duration_ms: 1_234,
        },
      }),
      {
        trigger: "auto",
        preTokens: 287_123,
        postTokens: 42_000,
        durationMs: 1_234,
      },
    );
  });

  test("SDK context usage retains the effective threshold", () => {
    assert.deepEqual(
      normalizeContextUsage({
        totalTokens: 271_000,
        maxTokens: 300_000,
        rawMaxTokens: 1_000_000,
        percentage: 90.3,
        autoCompactThreshold: 287_000,
        isAutoCompactEnabled: true,
      }),
      {
        contextTokens: 271_000,
        contextWindow: 300_000,
        modelContextWindow: 1_000_000,
        contextPercent: 90.3,
        autoCompactThreshold: 287_000,
        isAutoCompactEnabled: true,
      },
    );
  });
});

describe("context control ordering", () => {
  function scriptedQuery(messages, getContextUsage) {
    return () => ({
      async *[Symbol.asyncIterator]() {
        yield* messages;
      },
      async getContextUsage() {
        return getContextUsage?.();
      },
      async close() {},
    });
  }

  test("reads successful context state before publishing the result", async () => {
    const order = [];
    const runner = new ClaudeRunner({
      query: scriptedQuery(
        [
          { type: "system", subtype: "init", session_id: "s", model: "m" },
          { type: "result", subtype: "success", is_error: false, result: "ok" },
        ],
        async () => {
          order.push("control");
          return { totalTokens: 10, maxTokens: 100_000 };
        },
      ),
      options: {},
    });

    await new Promise((resolve) => {
      runner.start("prompt", {
        onContextUsage: () => order.push("context"),
        onResult: () => order.push("result"),
        onDone: resolve,
      });
    });
    assert.deepEqual(order, ["control", "context", "result"]);
  });

  test("does not delay error results for optional telemetry", async () => {
    let controlReads = 0;
    const runner = new ClaudeRunner({
      query: scriptedQuery(
        [
          { type: "system", subtype: "init", session_id: "s", model: "m" },
          {
            type: "result",
            subtype: "error_during_execution",
            is_error: true,
            result: "",
          },
        ],
        async () => {
          controlReads += 1;
          return null;
        },
      ),
      options: {},
    });

    await new Promise((resolve) => runner.start("prompt", { onDone: resolve }));
    assert.equal(controlReads, 0);
  });
});

describe("stderr capture", () => {
  test("only the last 8KB of the child's stderr is kept", async () => {
    let writeStderr;
    const runner = new ClaudeRunner({
      query: ({ options }) => {
        writeStderr = options.stderr;
        return {
          [Symbol.asyncIterator]: () => ({
            next: () => new Promise(() => {}), // never yields
          }),
          async close() {},
        };
      },
      options: {},
    });

    runner.start("prompt");
    writeStderr("A".repeat(4000));
    writeStderr("B".repeat(9000));

    const stderr = runner.getStderr();
    assert.equal(stderr.length, 8 * 1024);
    assert.equal(stderr.at(-1), "B", "the tail is what is kept");
    await runner.close();
  });
});

describe("persisted cwd validation", () => {
  test("closing releases a hung metadata lookup without starting a query", async () => {
    const lookup = new Promise(() => {});
    let queries = 0;
    const createRunner = createRunnerFactory({
      getSessionInfo: () => lookup,
      query: () => {
        queries += 1;
        throw new Error("query must not start after close");
      },
    });
    const runner = createRunner({
      cwd: "/repo",
      resume: "session-id",
      verifyResumeCwd: true,
    });

    let finishConsumer;
    const consumerDone = new Promise((resolve) => {
      finishConsumer = resolve;
    });
    runner.start("prompt", { onDone: finishConsumer });
    await runner.close();
    await consumerDone;

    assert.equal(queries, 0);
  });
});
