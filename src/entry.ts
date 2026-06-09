/**
 * Side-effect-free entry pointer.
 *
 * Importers who want to spawn mpg as a Node subprocess can do:
 *
 *   import { entryPath } from "mind-palace-graph/entry";
 *   spawn(process.execPath, [entryPath, "TODO", "--in", "src/"]);
 *
 * That bypasses the .cmd shim on Windows (which breaks when invoked
 * from `child_process.spawn` without `shell: true`, and corrupts argv
 * with `shell: true`). The CLI also exposes the same value via
 * `mpg --print-entry` for non-Node callers.
 *
 * This file is intentionally tiny and imports nothing from the rest of
 * the package — pulling it in is cheap and has no side effects.
 */

import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

/** Resolved absolute path to the built mpg CLI entry (dist/index.js). */
export const entryPath: string = join(
  dirname(fileURLToPath(import.meta.url)),
  "index.js",
);
