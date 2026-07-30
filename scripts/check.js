#!/usr/bin/env node
/**
 * Minimal syntax check over the repo's own sources — the stand-in for a linter.
 * `node --check` on every tracked .js/.mjs file outside node_modules.
 */

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const files = fs
  .readdirSync(ROOT, { recursive: true, withFileTypes: true })
  .filter(
    (entry) =>
      entry.isFile() &&
      /\.(js|mjs)$/.test(entry.name) &&
      !path
        .relative(ROOT, entry.parentPath ?? entry.path)
        .split(path.sep)
        .some((segment) => segment === "node_modules" || segment.startsWith(".")),
  )
  .map((entry) => path.join(entry.parentPath ?? entry.path, entry.name))
  .sort();
let failed = 0;

for (const file of files) {
  try {
    execFileSync(process.execPath, ["--check", file], { stdio: "pipe" });
  } catch (err) {
    failed += 1;
    process.stderr.write(
      `FAIL ${path.relative(ROOT, file)}\n${err.stderr?.toString() ?? err.message}\n`,
    );
  }
}

console.log(
  `checked ${files.length} file(s), ${failed} failure(s)`,
);
process.exit(failed === 0 ? 0 : 1);
