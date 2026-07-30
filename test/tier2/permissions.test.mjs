/**
 * Integration tier: what the spawned Claude Code can actually do to the disk.
 *
 * Both modes share one sandbox and one CLI-backed server: the model is scripted
 * into the same `Write` call twice, and only the permission level differs.
 */

import test, { after, before, describe } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { toolResults } from "../helpers/mock-api.mjs";
import { startTier2 } from "../helpers/fixtures.mjs";

const TARGET = "written.txt";
const CONTENT = "written by the model\n";

/** One `Write` call plus a closing sentence, per turn. */
const writeScript = (sandbox) =>
  ["I could not write the file.", "Wrote the file."].flatMap((closing) => [
    {
      tool: "Write",
      input: { file_path: path.join(sandbox.repo, TARGET), content: CONTENT },
    },
    { text: closing },
  ]);

describe("permission levels", () => {
  let ctx;
  let target;

  before(async () => {
    ctx = await startTier2({ turns: writeScript });
    target = path.join(ctx.sandbox.repo, TARGET);
  });

  after(async () => ctx?.stop());

  test("read-only (the default) refuses the Write and nothing lands on disk", async () => {
    const response = await ctx.server.call(
      "claude",
      { prompt: "Create written.txt", cwd: ctx.sandbox.repo },
      120000,
    );
    assert.equal(response.error, undefined, JSON.stringify(response.error));

    const results = toolResults(ctx.mock.mainCalls()[1]);
    assert.equal(results.length, 1, JSON.stringify(results));
    assert.match(results[0].text, /No such tool available/i);
    assert.equal(fs.existsSync(target), false, "no file was written");
  });

  test("writable mode writes without any permission prompt", async () => {
    const before = ctx.mock.mainCalls().length;
    const response = await ctx.server.call(
      "claude",
      { prompt: "Create written.txt", cwd: ctx.sandbox.repo, writable: true },
      120000,
    );
    assert.equal(response.error, undefined, JSON.stringify(response.error));
    assert.match(response.result.content[0].text, /Wrote the file/);

    const results = toolResults(ctx.mock.mainCalls()[before + 1]);
    assert.equal(results[0].isError, false, JSON.stringify(results));
    assert.equal(fs.readFileSync(target, "utf8"), CONTENT);
  });
});
