/**
 * Shared benchmark runner: invokes the built `mpg` CLI, parses JSON
 * output, and returns a typed result. All bench scripts shell out
 * rather than embedding the API so we measure the same thing users
 * measure when they run mpg from an agent.
 */

import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, "..", "..");
const CLI = join(REPO_ROOT, "dist", "index.js");

export interface RunOpts {
  args: string[];
  cwd?: string;
  env?: Record<string, string>;
  /** Capture wall-clock ms for the call. */
  measureMs?: boolean;
}

export interface RunResult<T = unknown> {
  code: number;
  stdout: string;
  stderr: string;
  ms: number;
  json: T | null;
}

export function runMpg<T = unknown>(opts: RunOpts): RunResult<T> {
  const t0 = Date.now();
  const r = spawnSync("node", [CLI, ...opts.args], {
    encoding: "utf8",
    cwd: opts.cwd ?? REPO_ROOT,
    env: { ...process.env, ...(opts.env ?? {}) },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const ms = Date.now() - t0;
  const stdout = r.stdout ?? "";
  let json: T | null = null;
  try {
    json = JSON.parse(stdout) as T;
  } catch {
    // not JSON — caller didn't ask for --format json, that's fine
  }
  return { code: r.status ?? -1, stdout, stderr: r.stderr ?? "", ms, json };
}

/** Convenience: search with --format json and parse. */
export interface SearchJson {
  pattern: string;
  effort: string;
  status: string;
  total_nodes: number;
  total_tokens: number;
  nodes: Array<{
    id: number;
    source: { id: string; type: string };
    match_line: number;
    start_line: number;
    end_line: number;
  }>;
}

export function search(args: string[], opts?: Omit<RunOpts, "args">): RunResult<SearchJson> {
  return runMpg<SearchJson>({ ...opts, args: [...args, "--format", "json", "--no-color"] });
}

export function writeResult(tier: string, payload: unknown): string {
  const dir = join(REPO_ROOT, "bench", "results");
  mkdirSync(dir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const path = join(dir, `${tier}-${stamp}.json`);
  writeFileSync(path, JSON.stringify(payload, null, 2));
  return path;
}

let passed = 0;
let failed = 0;

export function assert(cond: boolean, label: string): void {
  if (cond) {
    passed++;
    process.stdout.write(`  ✓ ${label}\n`);
  } else {
    failed++;
    process.stdout.write(`  ✗ ${label}\n`);
  }
}

export function reportAndExit(): never {
  process.stdout.write(`\n================\n${passed} passed, ${failed} failed\n`);
  process.exit(failed === 0 ? 0 : 1);
}

export function repoRoot(): string {
  return REPO_ROOT;
}
