import test, { describe } from "node:test";
import assert from "node:assert/strict";
import {
  ClaudeRunner,
  createRunnerFactory,
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
