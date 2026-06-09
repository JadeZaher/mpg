/**
 * Mind Palace — the LLM's instantiable short-term memory.
 *
 * The metaphor: an LLM harness doing multi-step investigation needs
 * named, addressable memory slots it can write to, read from, and
 * compose. The mind palace provides exactly that.
 *
 *   --mp-stash <name> <note>     instantiate a slot: run the search,
 *                                stash the result, output as normal
 *   --mp-from <name>             read from a slot as search input
 *                                (re-runs the search fresh, scoped to
 *                                the stashed file paths)
 *   --mp-compose <a> <b> ...     read from multiple slots at once
 *   --mp-list [--tag t]          inspect: what slots exist
 *   --mp-get <name>              inspect: full contents of a slot
 *   --mp-drop <name>             destroy: free a slot
 *
 * Storage: a JSON file (default `./.mdg/mind-palace.json`, project-
 * scoped). Use `--mp-path` to point at a different file for isolated
 * sessions. The LLM can have multiple palaces (one per task) just by
 * pointing `--mp-path` at different files.
 */

import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { randomBytes } from "node:crypto";
import { dirname, resolve as resolvePath, join } from "node:path";
import type { Node, Source } from "./types.js";

export const PALACE_VERSION = 1;
export const DEFAULT_PALACE_FILENAME = "mind-palace.json";
export const DEFAULT_PALACE_DIR = ".mdg";

/** A stashed collection of nodes plus the metadata of the search that produced them. */
export interface Stash {
  name: string;
  note: string;
  tags: string[];
  created_at: string;
  updated_at: string;
  /** ISO timestamp when this stash auto-expires, or null. */
  expires_at: string | null;
  search: {
    pattern: string;
    effort: string;
    sources_count: number;
  };
  /** Source paths involved in the original search (for context). */
  sources: string[];
  /** The stashed nodes (subset of full Node: source + location + matched text snapshot). */
  nodes: StashedNode[];
  /** Source file paths (filesystem paths only, no cmd/url/stdin). */
  file_paths: string[];
  /** Relationships to other stashes. */
  relations: StashRelation[];
}

/** A directed edge between two stashes. */
export interface StashRelation {
  target: string;
  type: string;
  note: string;
  created_at: string;
}

/** A compact, stash-friendly representation of a Node. */
export interface StashedNode {
  source: string;
  /** Canonical filesystem path, or null if source is not a file. */
  file_path: string | null;
  source_type: string;
  match_line: number;
  start_line: number;
  end_line: number;
  /** Snapshot of the match line and its context, so the stash is self-contained. */
  context_before: string[];
  match_text: string;
  context_after: string[];
  tokens: number;
}

export interface Palace {
  version: number;
  stashes: Record<string, Stash>;
}

function emptyPalace(): Palace {
  return { version: PALACE_VERSION, stashes: {} };
}

/** Walk up from `start` looking for a mind-palace.json. Returns null if none found. */
export function findExistingPalace(start: string = process.cwd()): string | null {
  let dir = resolvePath(start);
  // Limit the search depth to prevent runaway walks on weird FS layouts.
  for (let i = 0; i < 16; i++) {
    const candidate = join(dir, DEFAULT_PALACE_DIR, DEFAULT_PALACE_FILENAME);
    if (existsSync(candidate)) return candidate;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

/** Resolve the default palace path: env override, then git root, then
 *  nearest existing palace walking up, then CWD/.mdg/.
 *  This ensures the mind palace is project-scoped by default — even
 *  when invoked from a deep subdirectory. */
export function defaultPalacePath(): string {
  const envPath = process.env.MDG_MIND_PALACE;
  if (envPath) return resolvePath(envPath);
  // Try the git root first (most reliable project boundary).
  const gitRoot = findGitRoot();
  if (gitRoot) {
    return join(gitRoot, DEFAULT_PALACE_DIR, DEFAULT_PALACE_FILENAME);
  }
  const existing = findExistingPalace();
  if (existing) return existing;
  return resolvePath(process.cwd(), DEFAULT_PALACE_DIR, DEFAULT_PALACE_FILENAME);
}

/** Find the root of a git repository by walking up from start.
 *  Returns null if not inside a git repo. */
function findGitRoot(start: string = process.cwd()): string | null {
  let dir = resolvePath(start);
  for (let i = 0; i < 32; i++) {
    if (existsSync(join(dir, ".git"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

/**
 * `loadPalace` is called from many places (every `mdg` invocation that
 * touches the palace). Two pathologies we must avoid:
 *
 *   1. Returning `emptyPalace()` on JSON.parse failure and letting the
 *      next `savePalace` clobber the user's real data.
 *   2. Returning a partially-deserialized object that looks valid but
 *      drops fields silently.
 *
 * So: on parse failure, we copy the corrupt file aside, emit a loud
 * stderr warning, and refuse to clobber on subsequent saves *for the
 * lifetime of this process* by marking the in-memory palace tainted.
 * The caller still gets an empty palace so reads (--mp-list etc.)
 * work, but any save will throw unless MDG_FORCE_RESET=1.
 */
const TAINTED = Symbol.for("mdg.palace.tainted");

interface MaybeTaintedPalace extends Palace {
  [TAINTED]?: boolean;
}

export function loadPalace(path: string): Palace {
  if (!existsSync(path)) return emptyPalace();
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (err) {
    process.stderr.write(
      `mdg: cannot read mind palace at ${path}: ${(err as Error).message}\n`,
    );
    const tainted = emptyPalace() as MaybeTaintedPalace;
    tainted[TAINTED] = true;
    return tainted;
  }
  // Empty file is OK — first save will populate it.
  if (raw.trim().length === 0) return emptyPalace();
  try {
    const parsed = JSON.parse(raw) as Palace;
    if (typeof parsed !== "object" || parsed === null) {
      throw new Error("top-level not an object");
    }
    if (typeof parsed.stashes !== "object" || parsed.stashes === null) {
      parsed.stashes = {};
    }
    if (typeof parsed.version !== "number") parsed.version = PALACE_VERSION;
    return parsed;
  } catch (err) {
    // Preserve the corrupt file for forensics rather than silently
    // overwriting it with the next save.
    const backupPath = `${path}.corrupt.${Date.now()}`;
    try {
      writeFileSync(backupPath, raw, "utf8");
    } catch { /* if even the backup fails, we still need to warn */ }
    process.stderr.write(
      `mdg: WARNING — mind palace at ${path} is corrupt ` +
      `(${(err as Error).message}). Saved a copy to ${backupPath}. ` +
      `Saves will refuse to overwrite this file unless ` +
      `MDG_FORCE_RESET=1 is set. Fix the file or move it aside.\n`,
    );
    const tainted = emptyPalace() as MaybeTaintedPalace;
    tainted[TAINTED] = true;
    return tainted;
  }
}

/**
 * Atomic save: write to a sibling temp file then rename into place.
 * Cross-process concurrency is bounded by a simple lock file. The lock
 * file is created with `wx` so collisions surface as EEXIST; we retry
 * with backoff up to ~2s before giving up. A stale lock (older than
 * 30s) is forcibly broken to handle crashed callers.
 */
const LOCK_STALE_MS = 30_000;
const LOCK_MAX_WAIT_MS = 2_000;

function acquireLock(path: string): { release: () => void } {
  const lockPath = `${path}.lock`;
  const start = Date.now();
  let attempt = 0;
  while (true) {
    try {
      const fd = openSync(lockPath, "wx");
      writeSync(fd, `${process.pid}\n`);
      closeSync(fd);
      return {
        release: () => { try { unlinkSync(lockPath); } catch { /* ignore */ } },
      };
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== "EEXIST") throw err;
      // Check for a stale lock and force-break it.
      try {
        const { statSync } = require("node:fs") as typeof import("node:fs");
        const st = statSync(lockPath);
        if (Date.now() - st.mtimeMs > LOCK_STALE_MS) {
          try { unlinkSync(lockPath); } catch { /* ignore */ }
          continue;
        }
      } catch { /* lock disappeared between EEXIST and stat — retry */ }
      if (Date.now() - start > LOCK_MAX_WAIT_MS) {
        throw new Error(
          `mdg: could not acquire lock on ${lockPath} after ${LOCK_MAX_WAIT_MS}ms. ` +
          `Another mdg process may be writing the palace, or a stale lock exists. ` +
          `Delete ${lockPath} manually if no other mdg is running.`,
        );
      }
      // Exponential-ish backoff with jitter.
      const sleep = Math.min(50 * (1 << Math.min(attempt, 5)), 250);
      const end = Date.now() + sleep + Math.floor(Math.random() * 20);
      while (Date.now() < end) { /* spin — short enough that setTimeout overhead would hurt */ }
      attempt++;
    }
  }
}

export function savePalace(path: string, palace: Palace): void {
  if ((palace as MaybeTaintedPalace)[TAINTED] && !process.env.MDG_FORCE_RESET) {
    throw new Error(
      `mdg: refusing to save over a tainted palace at ${path}. ` +
      `The on-disk file was unreadable or corrupt; saving now would ` +
      `destroy whatever data was there. Inspect the *.corrupt.* backup, ` +
      `then either fix the file or set MDG_FORCE_RESET=1 to overwrite.`,
    );
  }
  const dir = dirname(path);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  const lock = acquireLock(path);
  try {
    // Re-read the latest version under the lock and merge anything we
    // didn't see. Two callers racing both loadPalace → mutate → save:
    // without this re-read the second writer overwrites the first
    // writer's stashes wholesale. With it, the second writer sees the
    // first writer's stashes and merges.
    if (existsSync(path)) {
      try {
        const onDiskRaw = readFileSync(path, "utf8");
        if (onDiskRaw.trim().length > 0) {
          const onDisk = JSON.parse(onDiskRaw) as Palace;
          if (onDisk && typeof onDisk === "object" && onDisk.stashes) {
            for (const [name, stash] of Object.entries(onDisk.stashes)) {
              if (!(name in palace.stashes)) {
                palace.stashes[name] = stash;
              }
            }
          }
        }
      } catch {
        // The on-disk file went corrupt between load and save. We
        // hold the lock; let our copy win, but warn.
        process.stderr.write(
          `mdg: on-disk palace at ${path} became unparseable between ` +
          `load and save; overwriting with in-memory copy.\n`,
        );
      }
    }
    const tmpPath = `${path}.tmp.${process.pid}.${randomBytes(4).toString("hex")}`;
    writeFileSync(tmpPath, JSON.stringify(palace, null, 2) + "\n", "utf8");
    try {
      renameSync(tmpPath, path);
    } catch (err) {
      try { unlinkSync(tmpPath); } catch { /* ignore */ }
      throw err;
    }
  } finally {
    lock.release();
  }
}

/** Convert full Node objects into the compact StashedNode form. */
export function stashNodes(nodes: Node[]): StashedNode[] {
  return nodes.map((n) => ({
    source: n.source.id,
    file_path: n.source.type === "file" ? n.source.id : null,
    source_type: n.source.type,
    match_line: n.match_line,
    start_line: n.start_line,
    end_line: n.end_line,
    context_before: n.context_before,
    match_text: n.match_text,
    context_after: n.context_after,
    tokens: n.tokens,
  }));
}

/** Reverse: turn StashedNodes back into Sources (unique file paths). */
export function stashToSources(stash: Stash): Source[] {
  const seen = new Set<string>();
  const out: Source[] = [];
  for (const n of stash.nodes) {
    if (seen.has(n.source)) continue;
    seen.add(n.source);
    out.push({ id: n.source, type: "file" });
  }
  return out;
}

/**
 * Derive file-only paths from the canonical nodes (which carry source
 * type info). Falls back to the legacy string-heuristic over `sources`
 * only when no nodes are present — preserves behavior for callers that
 * pass an empty nodes list.
 */
function deriveFilePaths(nodes: Node[], sources: string[]): string[] {
  const filesFromNodes = new Set<string>();
  for (const n of nodes) {
    if (n.source.type === "file") filesFromNodes.add(n.source.id);
  }
  if (filesFromNodes.size > 0) return [...filesFromNodes];
  // Fallback: tolerate a sources-only call by skipping anything that
  // *clearly* isn't a file path (`cmd:...`, `http(s)://...`, `stdin`).
  return dedup(
    sources.filter((s) =>
      !s.startsWith("cmd:") &&
      !s.startsWith("http://") &&
      !s.startsWith("https://") &&
      s !== "stdin",
    ),
  );
}

/** Add or merge a stash into the palace. Merge dedupes by (source, match_line). */
export function addStash(
  palace: Palace,
  name: string,
  note: string,
  nodes: Node[],
  meta: Stash["search"],
  sources: string[],
  tags: string[] = [],
  options: { replace?: boolean; locations?: boolean; ttl?: string } = {},
): { stash: Stash; action: "created" | "replaced" | "merged" } {
  const now = new Date().toISOString();
  const existing = palace.stashes[name];
  const expiresAt = options.ttl ? expiryFromNow(options.ttl) : null;
  const newNodes = options.locations
    ? stashNodesLocations(nodes)
    : stashNodes(nodes);
  const newFilePaths = deriveFilePaths(nodes, sources);

  if (!existing) {
    const stash: Stash = {
      name,
      note,
      tags: [...tags],
      created_at: now,
      updated_at: now,
      expires_at: expiresAt,
      search: meta,
      sources: dedup(sources),
      nodes: newNodes,
      file_paths: newFilePaths,
      relations: [],
    };
    palace.stashes[name] = stash;
    return { stash, action: "created" };
  }

  if (options.replace) {
    existing.note = note;
    existing.tags = [...tags];
    existing.updated_at = now;
    existing.expires_at = expiresAt;
    existing.search = meta;
    existing.sources = dedup(sources);
    existing.nodes = newNodes;
    existing.file_paths = newFilePaths;
    return { stash: existing, action: "replaced" };
  }

  // Merge: dedupe by (source, match_line), keep first occurrence.
  const seen = new Set<string>();
  for (const n of existing.nodes) seen.add(`${n.source}:${n.match_line}`);
  for (const n of newNodes) {
    const key = `${n.source}:${n.match_line}`;
    if (!seen.has(key)) {
      existing.nodes.push(n);
      seen.add(key);
    }
  }
  existing.sources = dedup([...existing.sources, ...sources]);
  existing.file_paths = dedup([...existing.file_paths, ...newFilePaths]);
  if (tags.length > 0) {
    const tagSet = new Set([...existing.tags, ...tags]);
    existing.tags = [...tagSet];
  }
  if (note) existing.note = note; // overwrite note on merge
  if (expiresAt) existing.expires_at = expiresAt;
  existing.updated_at = now;
  return { stash: existing, action: "merged" };
}

export function getStash(palace: Palace, name: string): Stash | null {
  return palace.stashes[name] ?? null;
}

export function dropStash(palace: Palace, name: string): boolean {
  if (!(name in palace.stashes)) return false;
  delete palace.stashes[name];
  return true;
}

export function listStashes(palace: Palace, tagFilter?: string[]): Stash[] {
  const all = Object.values(palace.stashes);
  if (!tagFilter || tagFilter.length === 0) return all;
  return all.filter((s) => tagFilter.every((t) => s.tags.includes(t)));
}

/** Compose multiple stashes into a single set of unique Sources. */
export function composeToSources(palace: Palace, names: string[]): Source[] {
  const seen = new Set<string>();
  const out: Source[] = [];
  const missing: string[] = [];
  for (const name of names) {
    const stash = palace.stashes[name];
    if (!stash) {
      missing.push(name);
      continue;
    }
    for (const s of stashToSources(stash)) {
      if (!seen.has(s.id)) {
        seen.add(s.id);
        out.push(s);
      }
    }
  }
  if (missing.length > 0) {
    throw new Error(
      `Unknown stashes: ${missing.join(", ")}. ` +
      `Run 'mdg --mp-list' to see available stashes.`,
    );
  }
  return out;
}

/** Set difference: files in `a` but not in any of `b`. */
export function exceptToSources(palace: Palace, a: string, b: string[]): Source[] {
  const base = palace.stashes[a];
  if (!base) {
    throw new Error(
      `Unknown stash: ${a}. Run 'mdg --mp-list' to see available stashes.`,
    );
  }
  const excludeIds = new Set<string>();
  for (const name of b) {
    const stash = palace.stashes[name];
    if (!stash) {
      throw new Error(
        `Unknown stash: ${name}. Run 'mdg --mp-list' to see available stashes.`,
      );
    }
    for (const s of stashToSources(stash)) excludeIds.add(s.id);
  }
  const out: Source[] = [];
  const seen = new Set<string>();
  for (const s of stashToSources(base)) {
    if (excludeIds.has(s.id)) continue;
    if (seen.has(s.id)) continue;
    seen.add(s.id);
    out.push(s);
  }
  return out;
}

/** Set intersection: files in ALL of the given stashes. */
export function intersectToSources(palace: Palace, names: string[]): Source[] {
  if (names.length === 0) return [];
  const fileSets: Array<Set<string>> = [];
  for (const name of names) {
    const stash = palace.stashes[name];
    if (!stash) {
      throw new Error(
        `Unknown stash: ${name}. Run 'mdg --mp-list' to see available stashes.`,
      );
    }
    fileSets.push(new Set(stashToSources(stash).map((s) => s.id)));
  }
  // Start with the first set's files, keep only those present in all others.
  const [first, ...rest] = fileSets;
  const out: Source[] = [];
  for (const id of first) {
    if (rest.every((s) => s.has(id))) {
      out.push({ id, type: "file" });
    }
  }
  return out;
}

function dedup(arr: string[]): string[] {
  return [...new Set(arr)];
}

/** Lightweight stash: only (source, line, match_text), no context buffers. */
export function stashNodesLocations(nodes: Node[]): StashedNode[] {
  return nodes.map((n) => ({
    source: n.source.id,
    file_path: n.source.type === "file" ? n.source.id : null,
    source_type: n.source.type,
    match_line: n.match_line,
    start_line: n.match_line,
    end_line: n.match_line,
    context_before: [],
    match_text: n.match_text,
    context_after: [],
    tokens: 0,
  }));
}

// ─── Timestamp utilities ─────────────────────────────────────────────

/** Parse a human-readable duration into milliseconds.
 *  Accepts: "30s", "10m", "2h", "7d", "14d", or bare number (ms). */
export function parseDuration(s: string): number {
  const m = s.trim().match(/^([\d.]+)\s*(s|sec|m|min|h|hr|d|day|ms)?$/i);
  if (!m) throw new Error(`Invalid duration: ${s}. Use e.g. 30s, 10m, 2h, 7d.`);
  const n = parseFloat(m[1]);
  const unit = (m[2] || "ms").toLowerCase();
  switch (unit) {
    case "s": case "sec":   return n * 1000;
    case "m": case "min":   return n * 60 * 1000;
    case "h": case "hr":    return n * 3600 * 1000;
    case "d": case "day":   return n * 86400 * 1000;
    default:                return n; // raw ms
  }
}

/** Format an ISO timestamp as a relative time string for display. */
export function formatRelativeTime(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  if (ms < 0) return "just now";
  const s = Math.floor(ms / 1000);
  if (s < 10) return "just now";
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  return `${d}d ago`;
}

/** Compute an expiry timestamp from now + duration. */
export function expiryFromNow(duration: string): string {
  return new Date(Date.now() + parseDuration(duration)).toISOString();
}

// ─── Pruning operations ──────────────────────────────────────────────

export interface PruneResult {
  removed: number;
  names: string[];
  dry_run: boolean;
}

/** Remove stashes whose updated_at is older than `duration`. */
export function pruneOlderThan(
  palace: Palace,
  duration: string,
  dryRun = false,
): PruneResult {
  const cutoff = Date.now() - parseDuration(duration);
  const names: string[] = [];
  for (const [name, stash] of Object.entries(palace.stashes)) {
    if (new Date(stash.updated_at).getTime() < cutoff) {
      names.push(name);
    }
  }
  if (!dryRun) for (const n of names) delete palace.stashes[n];
  return { removed: names.length, names, dry_run: dryRun };
}

/** Remove stashes whose expires_at is in the past. */
export function pruneExpired(palace: Palace, dryRun = false): PruneResult {
  const now = Date.now();
  const names: string[] = [];
  for (const [name, stash] of Object.entries(palace.stashes)) {
    if (stash.expires_at && new Date(stash.expires_at).getTime() < now) {
      names.push(name);
    }
  }
  if (!dryRun) for (const n of names) delete palace.stashes[n];
  return { removed: names.length, names, dry_run: dryRun };
}

/** Keep the N most recently updated stashes, remove the rest. */
export function pruneKeep(palace: Palace, n: number, dryRun = false): PruneResult {
  const sorted = Object.values(palace.stashes).sort(
    (a, b) => b.updated_at.localeCompare(a.updated_at),
  );
  const toRemove = sorted.slice(n);
  const names = toRemove.map((s) => s.name);
  if (!dryRun) for (const n of names) delete palace.stashes[n];
  return { removed: names.length, names, dry_run: dryRun };
}

/** Remove all stashes with the given tag. */
export function pruneTag(palace: Palace, tag: string, dryRun = false): PruneResult {
  const names: string[] = [];
  for (const [name, stash] of Object.entries(palace.stashes)) {
    if (stash.tags.includes(tag)) {
      names.push(name);
    }
  }
  if (!dryRun) for (const n of names) delete palace.stashes[n];
  return { removed: names.length, names, dry_run: dryRun };
}

/** Remove all stashes. Requires explicit confirmation. */
export function pruneAll(palace: Palace, confirmed: boolean, dryRun = false): PruneResult {
  const names = Object.keys(palace.stashes);
  if (!confirmed) {
    throw new Error(
      `This would remove ${names.length} stashes. ` +
      `Pass --mp-prune-confirm to actually delete them. ` +
      `Use --mp-prune-dry-run to see what would be removed.`,
    );
  }
  if (!dryRun) palace.stashes = {};
  return { removed: names.length, names, dry_run: dryRun };
}

// ─── Relationships ──────────────────────────────────────────────────

/** Add a directed relationship from `from` stash to `to` stash. */
export function addRelation(
  palace: Palace,
  from: string,
  to: string,
  type: string,
  note: string,
): StashRelation {
  const source = palace.stashes[from];
  if (!source) throw new Error(`Unknown stash: ${from}`);
  if (!palace.stashes[to]) throw new Error(`Unknown stash: ${to}`);
  if (from === to) throw new Error(`Cannot link a stash to itself.`);
  const rel: StashRelation = {
    target: to,
    type,
    note,
    created_at: new Date().toISOString(),
  };
  // Dedup: replace any existing relation with the same target+type.
  source.relations = source.relations.filter(
    (r) => !(r.target === to && r.type === type),
  );
  source.relations.push(rel);
  source.updated_at = new Date().toISOString();
  return rel;
}

/** Remove a relationship from `from` to `to`. */
export function removeRelation(
  palace: Palace,
  from: string,
  to: string,
): boolean {
  const source = palace.stashes[from];
  if (!source) throw new Error(`Unknown stash: ${from}`);
  const before = source.relations.length;
  source.relations = source.relations.filter((r) => r.target !== to);
  if (source.relations.length < before) {
    source.updated_at = new Date().toISOString();
    return true;
  }
  return false;
}

/** Get all stashes related to `name` (both outbound and inbound edges). */
export function getRelated(
  palace: Palace,
  name: string,
): Array<{ stash: Stash; direction: "outbound" | "inbound"; relation: StashRelation }> {
  if (!palace.stashes[name]) return [];
  const out: ReturnType<typeof getRelated> = [];
  // Outbound: relationships FROM this stash.
  for (const r of palace.stashes[name].relations) {
    const target = palace.stashes[r.target];
    if (target) out.push({ stash: target, direction: "outbound", relation: r });
  }
  // Inbound: relationships TO this stash from others.
  for (const [otherName, otherStash] of Object.entries(palace.stashes)) {
    if (otherName === name) continue;
    for (const r of otherStash.relations) {
      if (r.target === name) {
        out.push({ stash: otherStash, direction: "inbound", relation: r });
      }
    }
  }
  return out;
}

/** Traverse the relationship graph from `name` up to `maxDepth` levels. */
export function traversalGraph(
  palace: Palace,
  name: string,
  maxDepth: number,
): Array<{ stash: Stash; depth: number; direction: "outbound" | "inbound"; via: string; relation: StashRelation }> {
  if (!palace.stashes[name]) return [];
  const visited = new Set<string>([name]);
  const out: ReturnType<typeof traversalGraph> = [];
  const queue: Array<{ target: string; depth: number; direction: "outbound" | "inbound"; via: string; relation: StashRelation }> = [];

  // Seed with outbound edges from the starting node.
  for (const r of palace.stashes[name].relations) {
    if (!palace.stashes[r.target]) continue;
    queue.push({
      target: r.target,
      depth: 1,
      direction: "outbound",
      via: name,
      relation: r,
    });
  }
  // Also seed inbound edges.
  for (const [otherName, otherStash] of Object.entries(palace.stashes)) {
    if (otherName === name) continue;
    for (const r of otherStash.relations) {
      if (r.target === name) {
        queue.push({
          target: otherName,
          depth: 1,
          direction: "inbound",
          via: name,
          relation: r,
        });
      }
    }
  }

  // BFS traversal.
  while (queue.length > 0) {
    const item = queue.shift()!;
    if (visited.has(item.target)) continue;
    visited.add(item.target);
    const stash = palace.stashes[item.target];
    if (!stash) continue;
    out.push({ stash, depth: item.depth, direction: item.direction, via: item.via, relation: item.relation });
    if (item.depth >= maxDepth) continue;
    // Enqueue neighbors.
    for (const r of stash.relations) {
      if (!visited.has(r.target)) {
        queue.push({
          target: r.target,
          depth: item.depth + 1,
          direction: "outbound",
          via: item.target,
          relation: r,
        });
      }
    }
  }
  return out;
}
