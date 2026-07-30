/**
 * Integration tier: what the spawned Claude Code can actually do to the disk.
 */

import test, { after, before, describe } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { toolResults } from "../helpers/mock-api.mjs";
import { startTier2 } from "../helpers/fixtures.mjs";

const TARGET = "written.txt";

/** Script the model into one `Write` call, then a closing sentence. */
const writeScript = (closing) => (sandbox) => [
  {
    tool: "Write",
    input: {
      file_path: path.join(sandbox.repo, TARGET),
      content: "written by the model\n",
    },
  },
  { text: closing },
];

describe("read-only mode (the default)", () => {
  let ctx;

  before(async () => {
    ctx = await startTier2({ turns: writeScript("I could not write the file.") });
  });

  after(async () => ctx?.stop());

  test("a Write attempt is refused and nothing lands on disk", async () => {
    const response = await ctx.server.call(
      "claude",
      { prompt: "Create written.txt", cwd: ctx.sandbox.repo },
      120000,
    );
    assert.equal(response.error, undefined, JSON.stringify(response.error));

    const results = toolResults(ctx.mock.mainCalls()[1] ?? {});
    assert.equal(results.length, 1, JSON.stringify(results));
    assert.match(results[0].text, /No such tool available/i);
    assert.equal(
      fs.existsSync(path.join(ctx.sandbox.repo, TARGET)),
      false,
      "no file was written",
    );
  });
});

describe("writable mode", () => {
  let ctx;

  before(async () => {
    ctx = await startTier2({ turns: writeScript("Wrote the file.") });
  });

  after(async () => ctx?.stop());

  test("a Write succeeds without any permission prompt", async () => {
    const response = await ctx.server.call(
      "claude",
      { prompt: "Create written.txt", cwd: ctx.sandbox.repo, writable: true },
      120000,
    );
    assert.equal(response.error, undefined, JSON.stringify(response.error));
    assert.match(response.result.content[0].text, /Wrote the file/);

    const results = toolResults(ctx.mock.mainCalls()[1] ?? {});
    assert.equal(results[0].isError, false, JSON.stringify(results));
    assert.equal(
      fs.readFileSync(path.join(ctx.sandbox.repo, TARGET), "utf8"),
      "written by the model\n",
    );
  });
});
