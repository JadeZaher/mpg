/**
 * Core types for mdg.
 *
 * A "node" is the fundamental unit of retrieval: a search match plus
 * its pre/post context window, sized in tokens (not lines).
 */

export type SourceType = "file" | "command" | "stdin" | "url";

export type Effort = "scan" | "quick" | "normal" | "deep" | "auto";
export type SortMode = "default" | "recent" | "oldest";
export type WindowCurve = "flat" | "linear" | "log";

export type Strategy = "fill" | "deep";

export type OutputFormat = "llm" | "markdown" | "json" | "text";

export type ResultStatus = "ok" | "no_matches" | "truncated" | "error";

/** Where text came from. */
export interface Source {
  /** A stable identifier (file path, command, URL, "stdin"). */
  id: string;
  /** What kind of source this is. */
  type: SourceType;
  /** Optional display label, defaults to id. */
  label?: string;
}

/** A single line match produced by ripgrep. */
export interface Match {
  source: Source;
  /** 1-indexed line number of the match. */
  line: number;
  /** The matched line's text (without trailing newline). */
  text: string;
  /** 0-indexed start byte offset of the match within `text`. */
  match_start: number;
  /** 0-indexed end byte offset of the match within `text` (exclusive). */
  match_end: number;
}

/**
 * A "node" is a search hit wrapped in a token-budgeted context window.
 * It's the smallest unit the LLM consumes.
 */
export interface Node {
  /** 1-indexed position of this node within the result set. */
  id: number;
  source: Source;
  /** 1-indexed line number of the match within the source. */
  match_line: number;
  /** 1-indexed first line of the context window (start_line <= match_line). */
  start_line: number;
  /** 1-indexed last line of the context window (end_line >= match_line). */
  end_line: number;
  /** Pre-context lines (text only, no line numbers). */
  context_before: string[];
  /** The matched line. */
  match_text: string;
  /** Post-context lines. */
  context_after: string[];
  /** Highlight ranges within match_text (offsets from start of match_text). */
  match_spans: Array<[number, number]>;
  /** Estimated token count for the entire node (before + match + after). */
  tokens: number;
}

/** Top-level result returned to the formatter. */
export interface Result {
  pattern: string;
  effort: Effort;
  strategy: Strategy;
  total_nodes: number;
  total_tokens: number;
  sources_count: number;
  truncated: boolean;
  nodes: Node[];
  /** Wall-clock duration of the search in ms. */
  duration_ms: number;
  /** The configured per-node token windows that were applied. */
  before_tokens: number;
  after_tokens: number;
  max_nodes: number;
  max_tokens?: number;
  /** True when the wide-record auto-tune shrank before/after to 0. */
  auto_tune_applied?: boolean;
  /** Shorthand status so LLMs can branch on outcome without parsing text. */
  status: ResultStatus;
  /** Token count of the actual nodes returned (after pagination).
   *  `total_tokens` is the pre-pagination total. */
  page_tokens: number;
  /** Optional pagination metadata; absent when pagination is off. */
  pagination?: import("./pagination.js").PaginationMeta;
}

/** Resolved configuration after applying effort presets and CLI overrides. */
export interface ResolvedConfig {
  pattern?: string;
  before_tokens: number;
  after_tokens: number;
  max_nodes: number;
  max_tokens?: number;
  strategy: Strategy;
  effort: Effort;
  format: OutputFormat;
  color: boolean;
  /** Raw source inputs (paths, commands, urls, stdin) to be resolved. */
  inputs: SourceInput[];
  /** Forwarded to ripgrep. */
  rg_options: RgOptions;
  /** Mind palace operations. Any of these may be set; pattern is only
   *  required for operations that perform a search. */
  mind_palace?: MindPalaceOps;
  /** Pagination. 1-indexed page number; absence means no pagination. */
  page?: number;
  page_size?: number;
  all: boolean;
  /** --ls / --tree: list all searchable files and exit. */
  ls: boolean;
  /** --mp-stash-locations: stash locations only (no context text). */
  mp_stash_locations: boolean;
  /** --no-auto-tune: disable wide-record corpus detection. */
  no_auto_tune: boolean;
  /**
   * True iff the user did not pass explicit --before/--after AND
   * --no-auto-tune was not set. The orchestrator uses this together
   * with a runtime sample of the resolved sources to decide whether
   * to drop before/after to 0 for wide-record corpora.
   */
  auto_tune_eligible: boolean;
  /** --sort recent|oldest|default. Order nodes by source file mtime. */
  sort?: SortMode;
  /** --window-curve flat|linear|log. Per-node window decay across ranks. */
  window_curve?: WindowCurve;
  /**
   * --clip <N>: sub-line clip mode. Drops line-level context; trims the
   * matched line itself to N chars on each side of the matched span.
   */
  clip_chars?: number;
  /** --fuzzy: typo-tolerant regex transform before passing to rg. */
  fuzzy?: boolean;
}

export interface MindPalaceOps {
  /** Path to the mind-palace JSON file. */
  path?: string;
  /** --mp-stash: stash the result of the current search. */
  stash?: { name: string; note: string; tags: string[]; replace: boolean };
  /** --mp-list: list stashes. */
  list?: { tags: string[] };
  /** --mp-get: print a stash. */
  get?: string;
  /** --mp-drop: remove a stash. */
  drop?: string;
  /** --mp-from: use a stashed file list as search target. */
  from?: string;
  /** --mp-compose: union of multiple stashes as search target. */
  compose?: string[];
  /** --mp-except: files in `except.base` not in any of `except.exclude`. */
  except?: { base: string; exclude: string[] };
  /** --mp-intersect: files in all of the given stashes. */
  intersect?: string[];
  /** --mp-ttl: auto-expiry duration for stashed results. */
  ttl?: string;
  /** --mp-prune-older-than: prune stashes older than this duration. */
  prune_older_than?: string;
  /** --mp-prune-keep: keep only N most recent stashes. */
  prune_keep?: number;
  /** --mp-prune-tag: prune all stashes with this tag. */
  prune_tag?: string;
  /** --mp-prune-all: prune everything (requires --mp-prune-confirm). */
  prune_all?: boolean;
  /** --mp-prune-confirm: required for destructive prune ops. */
  prune_confirm?: boolean;
  /** --mp-prune-dry-run: show what would be pruned without deleting. */
  prune_dry_run?: boolean;
  /** --mp-link: create a relationship between stashes. */
  link?: { from: string; to: string; type: string; note: string };
  /** --mp-unlink: remove a relationship. */
  unlink?: { from: string; to: string };
  /** --mp-related: list related stashes. */
  related?: string;
  /** --mp-graph: traversal graph from a stash. */
  graph?: { name: string; depth: number };
}

/** A source input as specified on the command line, pre-resolution. */
export type SourceInput =
  | { type: "path"; path: string }
  | { type: "command"; command: string }
  | { type: "stdin" }
  | { type: "url"; url: string };

export interface RgOptions {
  case_insensitive?: boolean;
  word_match?: boolean;
  fixed_strings?: boolean;
  multiline?: boolean;
  hidden?: boolean;
  no_ignore?: boolean;
  include_globs?: string[];
  exclude_globs?: string[];
  type?: string;
  glob_case_insensitive?: boolean;
}
