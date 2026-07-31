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
import { toolResults, toolUses } from "../helpers/mock-api.mjs";
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
 * fixture file — inside the repo, then the three out-of-tree ones — then a
 * `Glob` and a `Grep` over the sandbox root.
 */
const script = (sandbox) => [
  ...["I could not write the file.", "Wrote the file."].flatMap((closing) => [
    {
      tool: "Write",
      input: { file_path: path.join(sandbox.repo, TARGET), content: CONTENT },
    },
    { text: closing },
  ]),
  ...[
    path.join(sandbox.repo, "sample.txt"),
    path.join(sandbox.root, "outside.txt"),
    path.join(sandbox.root, "asked.txt"),
    path.join(sandbox.root, "denied.txt"),
  ].flatMap((file_path) => [
    { tool: "Read", input: { file_path } },
    { text: `Done with ${path.basename(file_path)}.` },
  ]),
  { tool: "Glob", input: { pattern: "*.txt", path: sandbox.root } },
  { text: "Globbed outside." },
  {
    tool: "Grep",
    input: {
      pattern: "FILE-CONTENTS",
      path: sandbox.root,
      output_mode: "content",
    },
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

  /**
   * Run one scripted turn and return its single tool result — after checking
   * that the scripted tool call the CLI executed targets `expectedPath`. The
   * script is consumed positionally, so this guard is what turns "some turn
   * was denied" into "the turn this test is about was denied".
   */
  const readTurn = async (prompt, expectedPath) => {
    const before = ctx.mock.mainCalls().length;
    const response = await ctx.server.call(
      "claude",
      { prompt, cwd: ctx.sandbox.repo },
      120000,
    );
    assert.equal(response.error, undefined, JSON.stringify(response.error));

    const followUp = ctx.mock.mainCalls()[before + 1];
    const use = toolUses(followUp).at(-1);
    const target = use.input.file_path ?? use.input.path;
    assert.equal(target, expectedPath, "the turn observed is the turn scripted");
    return toolResults(followUp)[0];
  };

  test("read-only mode still reads without stalling on a permission prompt", async () => {
    // Read-only installs a `canUseTool` callback that denies anything not
    // pre-approved. In-tree reads must not be reaching it in the first place.
    const result = await readTurn(
      "Read sample.txt",
      path.join(ctx.sandbox.repo, "sample.txt"),
    );
    assert.equal(result.isError, false, JSON.stringify(result));
    assert.match(result.text, /the sample file contents/);
  });

  test("read-only mode reads outside the working directory", async () => {
    // The reported regression: cwd is the repo, the file sits above it. The
    // out-of-tree Read raises a permission request; the callback approves it.
    const result = await readTurn(
      "Read the outside file",
      path.join(ctx.sandbox.root, "outside.txt"),
    );
    assert.equal(result.isError, false, JSON.stringify(result));
    assert.match(result.text, new RegExp(OUTSIDE_MARKER));
  });

  test("an operator ask rule denies a direct read instead of auto-approving", async () => {
    // asked.txt carries a `permissions.ask` rule. The pinned CLI surfaces the
    // forced request with no `decisionReason` (and no `matchedAskRule`), so it
    // must miss the out-of-tree gate match and land in the generic deny — the
    // reservation for a human survives, even if the cause is unnameable.
    const result = await readTurn(
      "Read the asked file",
      path.join(ctx.sandbox.root, "asked.txt"),
    );
    assert.equal(result.isError, true, JSON.stringify(result));
    assert.match(result.text, /not pre-approved/);
    assert.doesNotMatch(result.text, new RegExp(ASKED_MARKER));
  });

  test("an operator deny rule still beats the read approval", async () => {
    // denied.txt carries a `permissions.deny` rule, which short-circuits
    // before the callback can approve anything.
    const result = await readTurn(
      "Read the denied file",
      path.join(ctx.sandbox.root, "denied.txt"),
    );
    assert.equal(result.isError, true, JSON.stringify(result));
    assert.doesNotMatch(result.text, new RegExp(DENIED_MARKER));
  });

  test("Glob works outside the working directory", async () => {
    const result = await readTurn(
      "List text files in the sandbox root",
      ctx.sandbox.root,
    );
    assert.equal(result.isError, false, JSON.stringify(result));
    assert.match(result.text, /outside\.txt/);
  });

  test("a Grep sweep honors deny rules but not ask rules", async () => {
    // The sweep pattern matches all three out-of-tree fixture files.
    // *Verified:* the CLI filters `permissions.deny`-ruled files out of Grep
    // content results, so the deny guarantee holds for sweeps too. An
    // `permissions.ask`-ruled file IS disclosed — ask gates the direct Read
    // call, not sweep contents. Documented as a known limitation; if this
    // assertion ever flips, the CLI started filtering ask files and the docs
    // can promote the guarantee.
    const result = await readTurn("Search the sandbox root", ctx.sandbox.root);
    assert.equal(result.isError, false, JSON.stringify(result));
    assert.match(result.text, new RegExp(OUTSIDE_MARKER));
    assert.doesNotMatch(result.text, new RegExp(DENIED_MARKER));
    assert.match(result.text, new RegExp(ASKED_MARKER));
  });
});

describe("a bare-name ask rule", () => {
  let ctx;

  before(async () => {
    ctx = await startTier2({
      askRules: ["Read"],
      turns: (sandbox) => [
        {
          tool: "Read",
          input: { file_path: path.join(sandbox.repo, "sample.txt") },
        },
        { text: "Tried the in-tree read." },
        {
          tool: "Read",
          input: { file_path: path.join(sandbox.root, "outside.txt") },
        },
        { text: "Tried the out-of-tree read." },
      ],
    });
  });

  after(async () => ctx?.stop());

  test("denies an in-tree read (unmarked request, generic deny)", async () => {
    // The rule forces a prompt for every Read, even in-tree. *Verified:* with
    // no tool-own decisionReason in play, the request arrives without
    // `matchedAskRule` and lands in the generic deny.
    const response = await ctx.server.call(
      "claude",
      { prompt: "Read sample.txt", cwd: ctx.sandbox.repo },
      120000,
    );
    assert.equal(response.error, undefined, JSON.stringify(response.error));

    const results = toolResults(ctx.mock.mainCalls()[1]);
    assert.equal(results[0].isError, true, JSON.stringify(results));
    assert.match(results[0].text, /not pre-approved/);
    assert.doesNotMatch(results[0].text, /the sample file contents/);
  });

  test("denies an out-of-tree read despite the gate reason", async () => {
    // The load-bearing case for the matchedAskRule branch: the request
    // carries the out-of-tree gate reason (which the callback would approve)
    // AND the ask rule. *Verified:* the CLI populates `matchedAskRule`
    // exactly when an ask rule coincides with a tool-own decisionReason, and
    // the branch must outrank the gate approval — without it, this read
    // would be auto-approved against the operator's rule.
    const before = ctx.mock.mainCalls().length;
    const response = await ctx.server.call(
      "claude",
      { prompt: "Read the outside file", cwd: ctx.sandbox.repo },
      120000,
    );
    assert.equal(response.error, undefined, JSON.stringify(response.error));

    const results = toolResults(ctx.mock.mainCalls()[before + 1]);
    assert.equal(results[0].isError, true, JSON.stringify(results));
    assert.match(results[0].text, /human decision/);
    assert.doesNotMatch(results[0].text, new RegExp(OUTSIDE_MARKER));
  });
});
