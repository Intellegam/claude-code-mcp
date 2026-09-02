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
  test("closing during metadata lookup does not start a query", async () => {
    let finishLookup;
    const lookup = new Promise((resolve) => {
      finishLookup = resolve;
    });
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

    runner.start("prompt");
    const closing = runner.close();
    finishLookup({ cwd: "/repo" });
    await closing;
    await new Promise((resolve) => setImmediate(resolve));

    assert.equal(queries, 0);
  });
});
