import fs from "node:fs";
import path from "node:path";

/** Resolve an existing cwd to its physical path, preserving old error handling. */
export function canonicalizeCwd(cwd) {
  const resolved = path.resolve(cwd);
  try {
    return fs.realpathSync.native(resolved);
  } catch {
    return resolved;
  }
}
