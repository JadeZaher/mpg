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
  search: {
    pattern: string;
    effort: string;
    sources_count: number;
  };
  /** Source paths involved in the original search (for context). */
  sources: string[];
  /** The stashed nodes (subset of full Node: source + location + matched text snapshot). */
  nodes: StashedNode[];
}

/** A compact, stash-friendly representation of a Node. */
export interface StashedNode {
  source: string;
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
  options: { replace?: boolean; locations?: boolean } = {},
): { stash: Stash; action: "created" | "replaced" | "merged" } {
  const now = new Date().toISOString();
  const existing = palace.stashes[name];
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
      search: meta,
      sources: dedup(sources),
      nodes: newNodes,
    };
    palace.stashes[name] = stash;
    return { stash, action: "created" };
  }

  if (options.replace) {
    existing.note = note;
    existing.tags = [...tags];
    existing.updated_at = now;
    existing.search = meta;
    existing.sources = dedup(sources);
    existing.nodes = newNodes;
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
  if (tags.length > 0) {
    const tagSet = new Set([...existing.tags, ...tags]);
    existing.tags = [...tagSet];
  }
  if (note) existing.note = note; // overwrite note on merge
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
