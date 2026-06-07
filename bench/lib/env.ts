/**
 * Tiny dotenv loader for the bench runners.
 *
 * - Reads .env from repo root (lazy; first call).
 * - Skips lines that are empty or start with #.
 * - Supports `KEY=value` and `KEY="value with spaces"` (single or double quoted).
 * - Does NOT overwrite vars already set in process.env (real env wins).
 * - Aliases the user's preferred ANTHROPICAPIKEY -> ANTHROPIC_API_KEY so the
 *   SDK (which expects the underscored canonical name) picks it up.
 *
 * Intentionally no devDep — we don't need `dotenv` for ~30 lines.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { repoRoot } from "./runner.js";

let loaded = false;

const ALIASES: Record<string, string> = {
  ANTHROPICAPIKEY: "ANTHROPIC_API_KEY",
};

function unquote(value: string): string {
  const v = value.trim();
  if ((v.startsWith("\"") && v.endsWith("\"")) || (v.startsWith("'") && v.endsWith("'"))) {
    return v.slice(1, -1);
  }
  return v;
}

export function loadEnvFile(path?: string): void {
  if (loaded) return;
  loaded = true;
  const envPath = path ?? join(repoRoot(), ".env");
  if (!existsSync(envPath)) return;
  const text = readFileSync(envPath, "utf8");
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq < 0) continue;
    const key = line.slice(0, eq).trim();
    const val = unquote(line.slice(eq + 1));
    if (!key) continue;
    if (process.env[key] === undefined) process.env[key] = val;
    // Apply known aliases so SDKs find the value under their canonical name.
    const aliased = ALIASES[key];
    if (aliased && process.env[aliased] === undefined) process.env[aliased] = val;
  }
}
