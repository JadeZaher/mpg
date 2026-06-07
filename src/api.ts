/**
 * Programmatic API for mdg.
 *
 * This is the surface an LLM harness should embed against instead of
 * shelling out to the CLI. It exposes the same operations the CLI
 * does, but as async functions returning structured data.
 *
 * The CLI is a thin wrapper over this module. Conversely, this module
 * is what powers `mdg search`, `mdg stash`, etc. for in-process use.
 */

import { readFileSync, statSync } from "node:fs";
import { applyTotalBudget, applyWindowCurve, buildNode, loadSourceContent } from "./nodes.js";
import { buildFuzzyRegex, verifyFuzzy } from "./fuzzy.js";
import { runRg } from "./rg.js";
import {
  captureCommand,
  captureStdin,
  captureUrl,
  resolvePathSpecs,
} from "./sources.js";
import {
  addStash as addStashToPalace,
  composeToSources,
  defaultPalacePath,
  dropStash as dropStashFromPalace,
  getStash as getStashFromPalace,
  listStashes as listStashesFromPalace,
  loadPalace,
  savePalace,
  type Stash,
  type Palace,
} from "./mind-palace.js";
import type { Node, Source } from "./types.js";

// ─── Public types ───────────────────────────────────────────────────

export type Effort = "scan" | "quick" | "normal" | "deep" | "auto";
export type Strategy = "fill" | "deep";
export type SortMode = "default" | "recent" | "oldest";
export type WindowCurve = "flat" | "linear" | "log";

export interface SearchOptions {
  /** Regex pattern. Required for search. */
  pattern: string;
  /** Paths to search (files, dirs, globs, @file, @-). */
  in?: string[];
  /** Search the stdout of a command. */
  cmd?: string;
  /** Read content from stdin. */
  stdin?: boolean;
  /** Fetch and search a URL. */
  url?: string;
  /** Tokens of context before each match. Default: 500. */
  before?: number;
  /** Tokens of context after each match. Default: 500. */
  after?: number;
  /** Cap on the number of nodes returned. Default: 30. */
  maxNodes?: number;
  /** Total token budget across all nodes. */
  maxTokens?: number;
  /** How to use --max-tokens. Default: "fill". */
  strategy?: Strategy;
  /** Effort preset. Default: "normal". */
  effort?: Effort;
  /** rg options. */
  rg?: {
    caseInsensitive?: boolean;
    word?: boolean;
    fixedStrings?: boolean;
    multiline?: boolean;
    hidden?: boolean;
    noIgnore?: boolean;
    include?: string[];
    exclude?: string[];
    type?: string;
  };
  /** Use a stashed file list as the search target. */
  from?: string;
  /** Compose multiple stashes' file lists as the search target. */
  compose?: string[];
  /** Palace file path. Defaults to project-scoped. */
  palacePath?: string;
  /** Pagination: 1-indexed page number. */
  page?: number;
  /** Pagination: items per page (default 10). */
  pageSize?: number;
  /** Disable pagination; return everything. */
  all?: boolean;
  /**
   * Disable the wide-record auto-tune. By default, when the sources
   * being searched have a median line length over ~500 chars (typical
   * of JSONL event streams), mdg drops `before`/`after` to 0 so each
   * node is just the matched line. Set this to `true` to keep the
   * effort-preset windowing regardless of corpus shape.
   */
  noAutoTune?: boolean;
  /**
   * Order returned nodes by source file modification time.
   *   "default" (or undefined): rg's natural traversal order.
   *   "recent": newest-edited files first. Surfaces what changed
   *             recently — useful when scan is used as a memory index.
   *   "oldest": oldest files first.
   * Non-file sources (cmd / url / stdin) sort to the end in `recent`
   * and to the beginning in `oldest`.
   */
  sort?: SortMode;
  /**
   * Token-window decay curve applied across returned nodes.
   *   "flat" (or undefined): every node gets the full `before`/`after`
   *     window. The classic behavior.
   *   "linear": window decays linearly from full at rank 0 down to a
   *     small floor (~10% of full) at the last rank. Combined with
   *     `sort: "recent"`, this gives recent nodes rich context and
   *     older nodes a tight disambiguating window.
   *   "log": window decays as `full / log2(rank + 2)`. Gentler than
   *     linear — useful when you want meaningful context several
   *     ranks deep, not just on the first hit.
   * In all modes the per-node window is bounded between 0 and the
   * configured `before`/`after`.
   */
  windowCurve?: WindowCurve;
  /** Sub-line clip mode (N chars on each side of the matched span). */
  clipChars?: number;
  /** Typo-tolerant search via regex transform (skipped if pattern is regex-y). */
  fuzzy?: boolean;
}

/** Public, harness-friendly node shape. Same as internal Node. */
export interface SearchNode extends Node {}

/** Public, harness-friendly result shape. */
export interface SearchResult {
  pattern: string;
  effort: Effort;
  strategy: Strategy;
  /** Machine-readable status so LLMs can branch without parsing text. */
  status: "ok" | "no_matches" | "truncated" | "error";
  total_nodes: number;
  total_tokens: number;
  /** Token count of the actual nodes returned (after pagination). */
  page_tokens: number;
  sources_count: number;
  truncated: boolean;
  nodes: SearchNode[];
  duration_ms: number;
  before_tokens: number;
  after_tokens: number;
  max_nodes: number;
  max_tokens?: number;
  /** True when the wide-record auto-tune shrank before/after to 0. */
  auto_tune_applied?: boolean;
  /** Optional pagination metadata; absent when pagination is off. */
  pagination?: {
    page: number;
    page_size: number;
    total_items: number;
    total_pages: number;
    has_next: boolean;
    has_prev: boolean;
  };
}

export interface StashOptions {
  /** Stash name. */
  name: string;
  /** Free-form note. */
  note?: string;
  /** Tags for filtering. */
  tags?: string[];
  /** Overwrite an existing stash. Default: merge. */
  replace?: boolean;
  /** Palace file path. Defaults to project-scoped. */
  palacePath?: string;
}

export interface StashResult {
  action: "created" | "merged" | "replaced";
  stash: Stash;
  palace_path: string;
}

// ─── Search ─────────────────────────────────────────────────────────

const EFFORT_DEFAULTS: Record<Effort, { before: number; after: number; maxNodes: number }> = {
  // "scan" — index mode. Many nodes with tiny disambiguating windows
  // (~20 tokens on each side of the match). Purpose: see all hits at
  // once, then pick which file/page to dig into with quick/normal/deep.
  // This is the "index -> detail" pattern: scan first to find what's
  // relevant; targeted small queries follow up on the chosen file(s).
  // Tokens scale O(n) with hit count (~60 tok/match on average);
  // maxNodes is intentionally high so scan matches rg's recall AND
  // precision regardless of hit count. Use --max-tokens if you want
  // to cap by budget instead.
  scan:   { before: 20,   after: 20,   maxNodes: 100000 },
  quick:  { before: 200,  after: 200,  maxNodes: 10  },
  normal: { before: 500,  after: 500,  maxNodes: 30  },
  deep:   { before: 2000, after: 2000, maxNodes: 100 },
  auto:   { before: 500,  after: 500,  maxNodes: 30  },
};

/**
 * Threshold above which auto-tune treats the corpus as "wide-record"
 * (JSONL events, log lines with embedded JSON, etc) and drops
 * before/after padding. Chosen so that typical source code (lines
 * usually under 200 chars) stays in the line-based regime, while
 * single-line serialized events trip the switch.
 */
export const WIDE_RECORD_MEDIAN_THRESHOLD = 500;

/**
 * Read up to 100 non-empty lines from up to 3 sampled file paths and
 * return the median line length. Used by the wide-record auto-tune.
 * Returns 0 if nothing was sampled (no file inputs, or all reads failed).
 */
export function sampleMedianLineLength(files: string[]): number {
  if (files.length === 0) return 0;
  const lengths: number[] = [];
  for (const f of files.slice(0, 3)) {
    try {
      const stat = statSync(f);
      // Skip huge files — sampling cost would dominate.
      if (stat.size > 10 * 1024 * 1024) continue;
      const content = readFileSync(f, "utf8");
      const lines = content.split(/\r?\n/).slice(0, 100);
      for (const ln of lines) {
        if (ln.length > 0) lengths.push(ln.length);
      }
    } catch { /* skip unreadable files */ }
  }
  if (lengths.length === 0) return 0;
  lengths.sort((a, b) => a - b);
  return lengths[Math.floor(lengths.length / 2)];
}

/**
 * Run a search and return structured result.
 *
 * @example
 *   const r = await search({ pattern: "TODO", in: ["src/"], effort: "quick" });
 *   console.log(r.total_nodes, r.nodes[0].match_text);
 */
export async function search(opts: SearchOptions): Promise<SearchResult> {
  // Resolve effort defaults. Default is "quick" — cheap by design,
  // following a "scan first, dig deeper on demand" philosophy.
  // Agents bump to normal/deep when one shot returned ambiguous nodes.
  const effort = opts.effort ?? "quick";
  const preset = EFFORT_DEFAULTS[effort];
  const userSetBefore = opts.before !== undefined;
  const userSetAfter = opts.after !== undefined;
  let before = opts.before ?? preset.before;
  let after = opts.after ?? preset.after;
  const maxNodes = opts.maxNodes ?? preset.maxNodes;
  const strategy = opts.strategy ?? "fill";

  // Build source list. Path inputs go through resolvePathSpecs which
  // handles globs, dirs, @- and @file. Other sources are captured
  // inline.
  const pathInputs: string[] = [...(opts.in ?? [])];
  let palace: Palace | null = null;
  const palacePath = opts.palacePath ?? defaultPalacePath();
  if (opts.from || (opts.compose && opts.compose.length > 0)) {
    palace = loadPalace(palacePath);
    const names = opts.from ? [opts.from] : opts.compose!;
    for (const s of composeToSources(palace, names)) {
      pathInputs.unshift(s.id);
    }
  }

  const files = pathInputs.length > 0 ? await resolvePathSpecs(pathInputs) : [];

  // Wide-record auto-tune. If the user didn't pass explicit
  // before/after and the corpus has very long lines (e.g. JSONL
  // events), drop padding to 0 so we don't pull in entire neighboring
  // records around each match. This is the headline product fix for
  // the conversational-corpus benchmark.
  let autoTuneApplied = false;
  if (!opts.noAutoTune && !userSetBefore && !userSetAfter && files.length > 0) {
    const median = sampleMedianLineLength(files);
    if (median > WIDE_RECORD_MEDIAN_THRESHOLD) {
      before = 0;
      after = 0;
      autoTuneApplied = true;
    }
  }

  const resolved: Array<{ source: Source; content: string | null }> = files.map((f) => ({
    source: { id: f, type: "file" },
    content: null,
  }));
  if (opts.cmd) {
    const content = await captureCommand(opts.cmd);
    resolved.push({
      source: { id: `cmd:${opts.cmd}`, type: "command", label: `$ ${opts.cmd}` },
      content,
    });
  }
  if (opts.url) {
    const content = await captureUrl(opts.url);
    resolved.push({ source: { id: opts.url, type: "url" }, content });
  }
  if (opts.stdin) {
    const content = await captureStdin();
    resolved.push({ source: { id: "stdin", type: "stdin" }, content });
  }

  // Run rg + build nodes.
  const t0 = Date.now();
  const allNodes: Node[] = [];
  const seenLines = autoTuneApplied ? new Set<string>() : null;

  // Fuzzy: trigram-union regex driver + Levenshtein post-filter (./fuzzy.ts).
  const effectivePattern = opts.fuzzy ? buildFuzzyRegex(opts.pattern) : opts.pattern;

  for (const rs of resolved) {
    for await (const match of runRg(effectivePattern, rs.source, rs.content, {
      case_insensitive: opts.rg?.caseInsensitive,
      word_match: opts.rg?.word,
      fixed_strings: opts.rg?.fixedStrings,
      multiline: opts.rg?.multiline,
      hidden: opts.rg?.hidden,
      no_ignore: opts.rg?.noIgnore,
      include_globs: opts.rg?.include,
      exclude_globs: opts.rg?.exclude,
      type: opts.rg?.type,
    })) {
      if (allNodes.length >= maxNodes) break;
      if (opts.fuzzy) {
        if (!verifyFuzzy(match.text, match.match_start, opts.pattern, 2)) continue;
      }
      if (seenLines) {
        const key = `${rs.source.id}:${match.line}`;
        if (seenLines.has(key)) continue;
        seenLines.add(key);
      }
      const content = loadSourceContent(rs.source, rs.content);
      const node = buildNode(match, content, {
        beforeTokens: before,
        afterTokens: after,
        clipChars: opts.clipChars,
      });
      allNodes.push(node);
      if (allNodes.length >= maxNodes) break;
    }
    if (allNodes.length >= maxNodes) break;
  }

  // Optional ordering by source file mtime.
  if (opts.sort === "recent" || opts.sort === "oldest") {
    const mtimes = new Map<string, number>();
    for (const n of allNodes) {
      const id = n.source.id;
      if (mtimes.has(id)) continue;
      if (n.source.type === "file") {
        try { mtimes.set(id, statSync(id).mtimeMs); } catch { mtimes.set(id, 0); }
      } else {
        // Non-file sources have no mtime; push to one end.
        mtimes.set(id, opts.sort === "recent" ? -Infinity : Infinity);
      }
    }
    const dir = opts.sort === "recent" ? -1 : 1;
    allNodes.sort((a, b) => {
      const ma = mtimes.get(a.source.id) ?? 0;
      const mb = mtimes.get(b.source.id) ?? 0;
      if (ma !== mb) return dir * (ma - mb);
      // Stable within a file: preserve match-line order.
      return (a.match_line ?? 0) - (b.match_line ?? 0);
    });
  }

  // Apply window-decay curve before total-budget enforcement so the
  // smaller windows count against the cap accurately.
  const windowCurve = opts.windowCurve ?? "flat";
  if (windowCurve !== "flat") {
    applyWindowCurve(allNodes, windowCurve, before, after);
  }

  const { nodes: budgeted, truncated } = applyTotalBudget(allNodes, opts.maxTokens, strategy);

  // Apply pagination if requested.
  const { paginate } = await import("./pagination.js");
  const { items: paged, pagination } = paginate(budgeted, {
    page: opts.page,
    pageSize: opts.pageSize,
    all: opts.all,
  });
  paged.forEach((n, i) => { n.id = i + 1; });
  const sources = new Set(budgeted.map((n) => n.source.id));

  const totalTokens = budgeted.reduce((s, n) => s + n.tokens, 0);
  const pageTokens = paged.reduce((s, n) => s + n.tokens, 0);
  const status: SearchResult["status"] =
    budgeted.length === 0 ? "no_matches" :
    truncated ? "truncated" : "ok";

  return {
    pattern: opts.pattern,
    effort,
    strategy,
    status,
    total_nodes: budgeted.length,
    total_tokens: totalTokens,
    page_tokens: pageTokens,
    sources_count: sources.size,
    truncated,
    nodes: paged,
    duration_ms: Date.now() - t0,
    before_tokens: before,
    after_tokens: after,
    max_nodes: maxNodes,
    max_tokens: opts.maxTokens,
    auto_tune_applied: autoTuneApplied || undefined,
    pagination,
  };
}

// ─── Mind palace operations ─────────────────────────────────────────

/**
 * Stash a search result in the mind palace.
 *
 * The `result` can be a SearchResult, or just an array of Nodes.
 * Returns the action taken (created/merged/replaced) and the full stash.
 */
export async function stash(result: SearchResult | SearchNode[], opts: StashOptions): Promise<StashResult> {
  const palacePath = opts.palacePath ?? defaultPalacePath();
  const palace = loadPalace(palacePath);
  const nodes = Array.isArray(result) ? result : result.nodes;
  const sources = Array.isArray(result)
    ? [...new Set(result.map((n) => n.source.id))]
    : [...new Set(result.nodes.map((n) => n.source.id))];
  const pattern = Array.isArray(result) ? "" : result.pattern;
  const effort = Array.isArray(result) ? "normal" : result.effort;
  const { action, stash: newStash } = addStashToPalace(
    palace,
    opts.name,
    opts.note ?? "",
    nodes,
    { pattern, effort, sources_count: sources.length },
    sources,
    opts.tags ?? [],
    { replace: opts.replace ?? false },
  );
  savePalace(palacePath, palace);
  return { action, stash: newStash, palace_path: palacePath };
}

export function listStashes(palacePath?: string, tagFilter?: string[]): Stash[] {
  const path = palacePath ?? defaultPalacePath();
  const palace = loadPalace(path);
  return listStashesFromPalace(palace, tagFilter);
}

export function getStash(name: string, palacePath?: string): Stash | null {
  const path = palacePath ?? defaultPalacePath();
  const palace = loadPalace(path);
  return getStashFromPalace(palace, name);
}

export function dropStash(name: string, palacePath?: string): boolean {
  const path = palacePath ?? defaultPalacePath();
  const palace = loadPalace(path);
  const ok = dropStashFromPalace(palace, name);
  if (ok) savePalace(path, palace);
  return ok;
}

/** Resolve a stash (or composition of stashes) to its source paths. */
export function stashToSources(
  names: string | string[],
  palacePath?: string,
): string[] {
  const path = palacePath ?? defaultPalacePath();
  const palace = loadPalace(path);
  const arr = Array.isArray(names) ? names : [names];
  return composeToSources(palace, arr).map((s) => s.id);
}

// ─── Tool calling schemas (Claude, Gemini, OpenAI) ──────────────────

// Claude and Gemini work better with SEPARATE tools per operation
// because each tool_use result is atomic. Five tools = five decisions.

const SEARCH_PARAMS = {
  type: "object" as const,
  properties: {
    pattern: { type: "string", description: "Regex pattern to search for (ripgrep syntax)." },
    in: { type: "array", items: { type: "string" },
      description: "Paths to search: files, directories (recurses), globs, @file, @-." },
    cmd: { type: "string", description: "Search the stdout of a shell command." },
    url: { type: "string", description: "Fetch and search a URL." },
    before: { type: "number", description: "Tokens of context before each match. Default 500." },
    after: { type: "number", description: "Tokens of context after each match. Default 500." },
    max_nodes: { type: "number", description: "Cap on number of nodes. Default 30." },
    max_tokens: { type: "number", description: "Total token budget across all nodes." },
    effort: { type: "string", enum: ["quick", "normal", "deep", "auto"],
      description: "Preset. quick=200t/10n, normal=500t/30n, deep=2000t/100n." },
    strategy: { type: "string", enum: ["fill", "deep"],
      description: "How to use max_tokens. fill prefers more nodes, deep prefers deeper per node." },
    from: { type: "string", description: "Scope search to files from a stashed mind-palace slot." },
    compose: { type: "array", items: { type: "string" },
      description: "Scope search to the union of multiple stashed slots' file lists." },
    page: { type: "number", description: "1-indexed page number. Set to 1 to enable pagination." },
    page_size: { type: "number", description: "Nodes per page. Default 10." },
  },
  required: ["pattern"],
};

const STASH_PARAMS = {
  type: "object" as const,
  properties: {
    name: { type: "string", description: "Name for this memory slot. Use kebab-case." },
    note: { type: "string", description: "Free-form note describing what this stash contains." },
    tags: { type: "array", items: { type: "string" },
      description: "Tags for filtering: e.g. ['auth', 'p0', 'security']." },
    pattern: { type: "string", description: "The regex pattern used in the search (for provenance)." },
    in: { type: "array", items: { type: "string" }, description: "Paths searched (for provenance)." },
    effort: { type: "string", enum: ["quick", "normal", "deep", "auto"] },
    replace: { type: "boolean", description: "Overwrite an existing slot. Default: merge (dedup by file:line)." },
    palace_path: { type: "string", description: "Override mind-palace file location." },
  },
  required: ["name", "note"],
};

/** Claude-compatible tool definitions. Drop into Claude's API. */
export const claudeTools = [
  {
    type: "function" as const,
    function: {
      name: "mdg_search",
      description:
        "Search code, markdown, command output, and URLs for a regex " +
        "pattern. Returns token-budgeted context nodes with file:line " +
        "attribution. Each node is sized in tokens (not lines). Supports " +
        "effort presets (quick/normal/deep), pagination, and scoped " +
        "re-search from mind-palace stashes via the 'from'/'compose' fields.",
      parameters: SEARCH_PARAMS,
    },
  },
  {
    type: "function" as const,
    function: {
      name: "mdg_stash",
      description:
        "Save the result of a search into a named mind-palace slot " +
        "(the LLM's instantiable short-term memory). Stashed slots can " +
        "be used as search targets via mdg_search(from:name) or " +
        "mdg_search(compose:[a,b]). Merges by default (dedup by file:line); " +
        "pass replace:true to overwrite.",
      parameters: STASH_PARAMS,
    },
  },
  {
    type: "function" as const,
    function: {
      name: "mdg_list_stashes",
      description:
        "List all named memory slots in the mind palace. Optionally " +
        "filter by tag. Use this to see what you've stashed before deciding " +
        "to compose or re-search. Supports pagination.",
      parameters: {
        type: "object",
        properties: {
          tag_filter: { type: "array", items: { type: "string" },
            description: "Only show stashes with all of these tags." },
          page: { type: "number", description: "1-indexed page number." },
          page_size: { type: "number", description: "Stashes per page. Default 20." },
          palace_path: { type: "string", description: "Override mind-palace file." },
        },
        required: [] as string[],
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "mdg_get_stash",
      description:
        "Show the full contents of a single mind-palace slot: its note, tags, " +
        "search provenance, all stashed nodes with context, and the list of " +
        "source file paths (which can be passed to mdg_search as the 'from' field). " +
        "Supports pagination for large stashes.",
      parameters: {
        type: "object",
        properties: {
          name: { type: "string", description: "Name of the stash to retrieve." },
          page: { type: "number", description: "1-indexed page number." },
          page_size: { type: "number", description: "Nodes per page. Default 10." },
          palace_path: { type: "string", description: "Override mind-palace file." },
        },
        required: ["name"],
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "mdg_drop_stash",
      description:
        "Remove a slot from the mind palace. Use this to free memory when " +
        "a line of investigation is complete. Dropped stashes are gone " +
        "permanently (the JSON file is rewritten).",
      parameters: {
        type: "object",
        properties: {
          name: { type: "string", description: "Name of the stash to drop." },
          palace_path: { type: "string", description: "Override mind-palace file." },
        },
        required: ["name"],
      },
    },
  },
] as const;

/** Gemini-compatible tool definitions (function_declarations array). */
export const geminiTools = claudeTools.map((t) => ({
  name: t.function.name,
  description: t.function.description,
  parameters: t.function.parameters,
}));

/** Legacy: single-tool definition for OpenAI-compatible APIs. */
export const toolDefinition = {
  name: "mdg",
  description:
    "Search code, markdown, command output, and URLs. " +
    "Use mdg_list_stashes first to see available memory slots, " +
    "then mdg_search to find content, and mdg_stash to save results.",
  parameters: {
    type: "object" as const,
    properties: {
      action: {
        type: "string",
        enum: ["search", "stash", "list", "get", "drop"],
        description: "Which operation to perform.",
      },
      pattern: { type: "string", description: "Regex pattern (search)." },
      in: { type: "array", items: { type: "string" }, description: "Paths to search." },
      name: { type: "string", description: "Stash name (stash/get/drop)." },
      note: { type: "string", description: "Stash note (stash)." },
      tags: { type: "array", items: { type: "string" }, description: "Tags (stash/filter)." },
      before: { type: "number" },
      after: { type: "number" },
      max_nodes: { type: "number" },
      max_tokens: { type: "number" },
      effort: { type: "string", enum: ["quick", "normal", "deep", "auto"] },
      from: { type: "string", description: "Stash name as search target." },
      compose: { type: "array", items: { type: "string" }, description: "Stash names as union target." },
      page: { type: "number", description: "1-indexed page number." },
      page_size: { type: "number", description: "Items per page." },
    },
    required: ["action"],
  },
} as const;
