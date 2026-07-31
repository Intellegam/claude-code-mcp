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
import {
  ASKED_MARKER,
  DENIED_MARKER,
  OUTSIDE_MARKER,
  startTier2,
} from "../helpers/fixtures.mjs";

const TARGET = "written.txt";
const CONTENT = "written by the model\n";

/**
 * One `Write` call plus a closing sentence, per turn, then one `Read` per
 * fixture file — inside the repo, then the three out-of-tree ones.
 */
const script = (sandbox) => [
  ...["I could not write the file.", "Wrote the file."].flatMap((closing) => [
    {
      tool: "Write",
      input: { file_path: path.join(sandbox.repo, TARGET), content: CONTENT },
    },
    { text: closing },
  ]),
  ...["sample.txt", "outside.txt", "asked.txt", "denied.txt"].flatMap(
    (name) => [
      {
        tool: "Read",
        input: {
          file_path:
            name === "sample.txt"
              ? path.join(sandbox.repo, name)
              : path.join(sandbox.realRoot, name),
        },
      },
      { text: `Done with ${name}.` },
    ],
  ),
  { tool: "Glob", input: { pattern: "*.txt", path: sandbox.realRoot } },
  { text: "Globbed outside." },
  {
    tool: "Grep",
    input: { pattern: "OUTSIDE", path: sandbox.realRoot, output_mode: "content" },
  },
  { text: "Grepped outside." },
];

describe("permission levels", () => {
  let ctx;
  let target;

  before(async () => {
    ctx = await startTier2({ turns: script });
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

  test("read-only mode still reads without stalling on a permission prompt", async () => {
    // Read-only installs a `canUseTool` callback that denies anything not
    // pre-approved. The read tools must not be reaching it in the first place.
    const before = ctx.mock.mainCalls().length;
    const response = await ctx.server.call(
      "claude",
      { prompt: "Read sample.txt", cwd: ctx.sandbox.repo },
      120000,
    );
    assert.equal(response.error, undefined, JSON.stringify(response.error));

    const results = toolResults(ctx.mock.mainCalls()[before + 1]);
    assert.equal(results[0].isError, false, JSON.stringify(results));
    assert.match(results[0].text, /the sample file contents/);
  });

  /** Run one scripted read-only turn and return its single tool result. */
  const readTurn = async (prompt) => {
    const before = ctx.mock.mainCalls().length;
    const response = await ctx.server.call(
      "claude",
      { prompt, cwd: ctx.sandbox.repo },
      120000,
    );
    assert.equal(response.error, undefined, JSON.stringify(response.error));
    return toolResults(ctx.mock.mainCalls()[before + 1])[0];
  };

  test("read-only mode reads outside the working directory", async () => {
    // The reported regression: cwd is the repo, the file sits above it. The
    // out-of-tree Read raises a permission request; the callback approves it.
    const result = await readTurn("Read the outside file");
    assert.equal(result.isError, false, JSON.stringify(result));
    assert.match(result.text, new RegExp(OUTSIDE_MARKER));
  });

  test("an operator ask rule denies instead of auto-approving", async () => {
    // asked.txt carries a `permissions.ask` rule. The pinned CLI surfaces the
    // forced request with no `decisionReason` (and no `matchedAskRule`), so it
    // must miss the out-of-tree gate match and land in the generic deny — the
    // reservation for a human survives, even if the cause is unnameable.
    const result = await readTurn("Read the asked file");
    assert.equal(result.isError, true, JSON.stringify(result));
    assert.match(result.text, /not pre-approved/);
    assert.doesNotMatch(result.text, new RegExp(ASKED_MARKER));
  });

  test("an operator deny rule still beats the read approval", async () => {
    // denied.txt carries a `permissions.deny` rule, which short-circuits
    // before the callback can approve anything.
    const result = await readTurn("Read the denied file");
    assert.equal(result.isError, true, JSON.stringify(result));
    assert.doesNotMatch(result.text, new RegExp(DENIED_MARKER));
  });

  test("Glob works outside the working directory", async () => {
    const result = await readTurn("List text files in the sandbox root");
    assert.equal(result.isError, false, JSON.stringify(result));
    assert.match(result.text, /outside\.txt/);
  });

  test("Grep works outside the working directory", async () => {
    const result = await readTurn("Search the sandbox root");
    assert.equal(result.isError, false, JSON.stringify(result));
    assert.match(result.text, new RegExp(OUTSIDE_MARKER));
  });
});
