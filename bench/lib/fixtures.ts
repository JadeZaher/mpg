/**
 * Synthetic corpus for meso benchmarks.
 *
 * A small fixed project with known patterns at known locations.
 * Each fixture file is short and hand-crafted so we have ground-truth
 * about which (file, line) tuples should match each query pattern.
 *
 * Keep this corpus tiny and deterministic: changing fixtures
 * invalidates all historical benchmark results.
 */

import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export interface Fixture {
  path: string;     // relative under corpus root
  content: string;
}

export interface GroundTruth {
  /** Pattern fed to mpg --pattern. */
  pattern: string;
  /** Effort presets to evaluate on this query. */
  efforts: Array<"quick" | "normal" | "deep">;
  /** Expected (relPath, lineNumber) tuples — the canonical answer set. */
  expected: Array<{ file: string; line: number }>;
  /** Short human label for the query. */
  label: string;
}

export const FIXTURES: Fixture[] = [
  {
    path: "src/auth/login.ts",
    content: [
      "import { User } from './types';",
      "import { db } from './db';",
      "",
      "// TODO: rate limit by IP",
      "export async function login(user: User, pw: string) {",
      "  const ok = await db.users.verifyPassword(user.id, pw);",
      "  if (!ok) return null;",
      "  return db.sessions.create({ userId: user.id });",
      "}",
    ].join("\n"),
  },
  {
    path: "src/auth/session.ts",
    content: [
      "// TODO: short-lived session tokens",
      "export function createSession(uid: string) {",
      "  return { uid, exp: Date.now() + 3600_000 };",
      "}",
      "",
      "export function rotateSession(s: { uid: string }) {",
      "  // FIXME: race when two clients rotate at once",
      "  return createSession(s.uid);",
      "}",
    ].join("\n"),
  },
  {
    path: "src/api/handlers.ts",
    content: [
      "import { login } from '../auth/login';",
      "",
      "// TODO: add request validation",
      "export async function postLogin(req: { body: any }) {",
      "  return login(req.body.user, req.body.pw);",
      "}",
    ].join("\n"),
  },
  {
    path: "src/perf/cache.ts",
    content: [
      "// FIXME: cache eviction is O(n)",
      "export class Cache<V> {",
      "  private m = new Map<string, V>();",
      "  get(k: string) { return this.m.get(k); }",
      "  set(k: string, v: V) { this.m.set(k, v); }",
      "}",
    ].join("\n"),
  },
  {
    path: "src/perf/pool.ts",
    content: [
      "// TODO: connection pool sizing heuristic",
      "export class Pool {",
      "  constructor(public size: number) {}",
      "}",
    ].join("\n"),
  },
  {
    path: "src/utils/log.ts",
    content: [
      "export const logger = {",
      "  warn: (m: string) => console.warn(m),",
      "  error: (m: string) => console.error(m),",
      "};",
    ].join("\n"),
  },
  {
    path: "docs/architecture.md",
    content: [
      "# Architecture",
      "",
      "The login flow lives in src/auth/. Sessions are short-lived.",
      "",
      "TODO: document the rate-limit story once implemented.",
    ].join("\n"),
  },
  {
    path: "README.md",
    content: [
      "# Demo project",
      "",
      "See docs/architecture.md.",
    ].join("\n"),
  },
];

export const GROUND_TRUTH: GroundTruth[] = [
  {
    label: "find all TODOs",
    pattern: "TODO",
    efforts: ["quick", "normal", "deep"],
    expected: [
      { file: "src/auth/login.ts", line: 4 },
      { file: "src/auth/session.ts", line: 1 },
      { file: "src/api/handlers.ts", line: 3 },
      { file: "src/perf/pool.ts", line: 1 },
      { file: "docs/architecture.md", line: 5 },
    ],
  },
  {
    label: "find all FIXMEs",
    pattern: "FIXME",
    efforts: ["quick", "normal", "deep"],
    expected: [
      { file: "src/auth/session.ts", line: 7 },
      { file: "src/perf/cache.ts", line: 1 },
    ],
  },
  {
    label: "auth-related files (TODO|FIXME in src/auth)",
    pattern: "TODO|FIXME",
    efforts: ["quick", "normal", "deep"],
    expected: [
      { file: "src/auth/login.ts", line: 4 },
      { file: "src/auth/session.ts", line: 1 },
      { file: "src/auth/session.ts", line: 7 },
    ],
  },
  {
    label: "where is login called",
    pattern: "login\\(",
    efforts: ["quick", "normal", "deep"],
    expected: [
      { file: "src/api/handlers.ts", line: 5 },
    ],
  },
  {
    label: "session lifecycle",
    pattern: "createSession|rotateSession",
    efforts: ["quick", "normal", "deep"],
    expected: [
      { file: "src/auth/session.ts", line: 2 },
      { file: "src/auth/session.ts", line: 6 },
      { file: "src/auth/session.ts", line: 8 },
    ],
  },
];

export function makeCorpus(): string {
  const root = mkdtempSync(join(tmpdir(), "mpg-bench-corpus-"));
  for (const f of FIXTURES) {
    const abs = join(root, f.path);
    mkdirSync(join(abs, ".."), { recursive: true });
    writeFileSync(abs, f.content);
  }
  return root;
}

export function destroyCorpus(root: string): void {
  rmSync(root, { recursive: true, force: true });
}
