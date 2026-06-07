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

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
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

export function loadPalace(path: string): Palace {
  if (!existsSync(path)) return emptyPalace();
  try {
    const raw = readFileSync(path, "utf8");
    const parsed = JSON.parse(raw) as Palace;
    // Defensive: if a corrupted file is loaded, fall back to empty rather
    // than crash and lose the user's data via an overwrite.
    if (typeof parsed !== "object" || parsed === null) return emptyPalace();
    if (typeof parsed.stashes !== "object" || parsed.stashes === null) {
      parsed.stashes = {};
    }
    if (typeof parsed.version !== "number") parsed.version = PALACE_VERSION;
    return parsed;
  } catch {
    return emptyPalace();
  }
}

export function savePalace(path: string, palace: Palace): void {
  const dir = dirname(path);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  writeFileSync(path, JSON.stringify(palace, null, 2) + "\n", "utf8");
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
      file_paths: dedup(sources.filter((s) => s.startsWith("/") || s.includes(":") || s.includes("\\"))),
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
    existing.file_paths = dedup(sources.filter((s) => s.startsWith("/") || s.includes(":") || s.includes("\\")));
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
  existing.file_paths = dedup([
    ...existing.file_paths,
    ...sources.filter((s) => s.startsWith("/") || s.includes(":") || s.includes("\\")),
  ]);
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
