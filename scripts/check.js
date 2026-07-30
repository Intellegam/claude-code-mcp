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
const SKIP_DIRS = new Set(["node_modules", ".git", ".tmp"]);

function collect(dir) {
  const files = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith(".") && entry.name !== ".") continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      files.push(...collect(full));
    } else if (/\.(js|mjs)$/.test(entry.name)) {
      files.push(full);
    }
  }
  return files;
}

const files = collect(ROOT).sort();
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
