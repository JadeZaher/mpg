/**
 * CLI argument parser and configuration resolution.
 *
 * We hand-roll the parser to avoid a dependency. The grammar is:
 *
 *   mdg [pattern] [options]
 *
 * Pattern is the first positional argument. Options are flags below.
 * The parser applies effort presets, then CLI overrides, then
 * validates the final config.
 */

import type {
  Effort,
  OutputFormat,
  ResolvedConfig,
  RgOptions,
  SourceInput,
  Strategy,
} from "./types.js";

export interface RawArgs {
  pattern?: string;
  inPaths: string[];
  cmd?: string;
  stdin: boolean;
  url?: string;
  before?: number;
  after?: number;
  maxNodes?: number;
  maxTokens?: number;
  strategy?: Strategy;
  effort?: Effort;
  format?: OutputFormat;
  color?: boolean;
  hidden: boolean;
  noIgnore: boolean;
  ignoreCase: boolean;
  word: boolean;
  fixedStrings: boolean;
  multiline: boolean;
  includeGlobs: string[];
  excludeGlobs: string[];
  type?: string;
  // Mind palace operations.
  mpStashName?: string;
  mpStashNote?: string;
  mpStashTags: string[];
  mpStashReplace: boolean;
  mpList: boolean;
  mpListTags: string[];
  mpGet?: string;
  mpDrop?: string;
  mpFrom?: string;
  mpCompose: string[];
  mpExcept?: string;
  mpExceptNames: string[];
  mpIntersect: string[];
  mpPath?: string;
  // Pruning.
  mpPruneOlderThan?: string;
  mpPruneKeep?: number;
  mpPruneTag?: string;
  mpPruneAll: boolean;
  mpPruneConfirm: boolean;
  mpPruneDryRun: boolean;
  // TTL.
  mpTtl?: string;
  // Relationships.
  mpLinkFrom?: string;
  mpLinkTo?: string;
  mpLinkType?: string;
  mpLinkNote?: string;
  mpUnlinkFrom?: string;
  mpUnlinkTo?: string;
  mpRelated?: string;
  mpGraph?: string;
  mpGraphDepth: number;
  // Pagination + discovery.
  page?: number;
  pageSize?: number;
  all: boolean;
  ls: boolean;
  mpStashLocations: boolean;
  // Wide-record auto-tune opt-out.
  noAutoTune: boolean;
  help: boolean;
  version: boolean;
}

export const EFFORT_PRESETS: Record<Effort, { before: number; after: number; maxNodes: number }> = {
  scan:   { before: 20,   after: 20,   maxNodes: 200 },
  quick:  { before: 200,  after: 200,  maxNodes: 10  },
  normal: { before: 500,  after: 500,  maxNodes: 30  },
  deep:   { before: 2000, after: 2000, maxNodes: 100 },
  auto:   { before: 500,  after: 500,  maxNodes: 30  },
};

export const HELP = `mdg — node-centric context retrieval for LLM harnesses

USAGE
  mdg <pattern> [options]

  Pattern is a regular expression (ripgrep syntax). Use -F/--fixed-strings
  for literal matching.

SOURCES (at least one is required unless reading stdin)
  -i, --in <path> [<path>...]   Path(s), file(s), or glob(s) to search.
                                Repeatable. Greedy: consumes non-flag args.
                                Accepts: a file, a directory (recurses),
                                a glob, @file (read paths from a file),
                                @- (read paths from stdin), or a
                                comma-separated list.
                                Paths can also be passed as trailing
                                positionals: mdg "TODO" src/ test/
      --cmd <command>       Search the stdout of a shell command
      --stdin               Read content from stdin (auto-detected when piped)
  -u, --url <url>           Search the body of an HTTP(S) URL

NODE SIZING
  -b, --before <tokens>     Tokens of context before each match   [default: 500]
  -a, --after <tokens>      Tokens of context after each match    [default: 500]
  -n, --max-nodes <n>       Maximum number of nodes to return     [default: 30]
      --max-tokens <n>      Total token budget across all nodes
      --strategy <mode>     How to use --max-tokens: fill|deep    [default: fill]
  -e, --effort <level>      Preset: scan|quick|normal|deep|auto   [default: quick]
                            scan=20t/200n (index mode: many hits with tiny
                              disambiguating windows; pick a file/page,
                              then bump to quick/normal/deep on that file)
                            quick=200t/10n, normal=500t/30n, deep=2000t/100n
                            Default is quick: small windows, small node cap.
                            "Scan first, dig deeper" is the recommended pattern
                            for agents — start with scan or quick; bump to
                            normal or deep only when the small result was
                            ambiguous. Use multiple targeted parallel calls
                            instead of one huge deep call.

OUTPUT
  -f, --format <fmt>        llm|markdown|json|text               [default: llm]
      --color / --no-color  Force or disable ANSI color           [default: auto]

SEARCH OPTIONS (forwarded to ripgrep)
  -I, --ignore-case         Case-insensitive match
  -w, --word                Match whole words only
  -F, --fixed-strings       Treat pattern as literal
  -U, --multiline           Allow multi-line patterns
      --hidden              Search hidden files and directories
      --no-ignore           Don't respect .gitignore
      --include <glob>      Include files matching glob (repeatable)
      --exclude <glob>      Exclude files matching glob (repeatable)
      --type <lang>         ripgrep file type filter (e.g. ts, rust, py)

OTHER
  -h, --help                Show this help
  -v, --version             Show version

PAGINATION (for finer-grained traversal of large result sets)
      --page <n>            Show only the Nth page of results (1-indexed).
                            When set, paginates nodes (in search and
                            --mp-get) or stashes (in --mp-list).
      --page-size <n>       Items per page (default 10 for nodes,
                            20 for stashes).
      --all                 Disable pagination; return everything.

MIND PALACE (the LLM's instantiable short-term memory)
  A mind palace is a JSON file (default ./.mdg/mind-palace.json) that
  holds named "stashes" of search results. The LLM harness can stash
  results, recall them, and compose them across multiple invocations.

      --mp-stash <name> <note>   Stash the current search's results
                                 under <name> with <note>. Adds to an
                                 existing stash by default (dedup by
                                 file:line); pass --mp-replace to
                                 overwrite.
      --mp-stash-tag <tag>       Tag the stash (repeatable).
      --mp-replace               Replace an existing stash outright.
      --mp-list [--mp-list-tag t]  List all stashes (optionally filtered
                                 by tag).
      --mp-get <name>            Print the full contents of a stash.
      --mp-drop <name>           Remove a stash from the palace.
      --mp-from <name>           Use a stashed file list as the search
                                 target. The search re-runs fresh.
      --mp-compose <a> <b> ...   Union of multiple stashes' file lists
                                 as the search target.
      --mp-path <file>           Path to the mind-palace.json file
                                 (default: ./.mdg/mind-palace.json,
                                 or the closest one walking up from
                                 CWD). Use this for isolated sessions.

PRUNING & TTL (keep the palace from growing unbounded)
      --mp-ttl <duration>        Auto-expiry for this stash (e.g. 2h,
                                 7d, 30m). The stash is marked with
                                 expires_at; expired stashes can be
                                 cleaned with --mp-prune-expired.
      --mp-prune-older-than <d>  Remove stashes older than duration.
      --mp-prune-keep <n>        Keep only the n most recent stashes.
      --mp-prune-tag <tag>       Remove all stashes with a given tag.
      --mp-prune-expired         Remove all expired stashes (those
                                 whose --mp-ttl has elapsed).
      --mp-prune-all             Remove all stashes.
      --mp-prune-dry-run         Show what would be removed.
      --mp-prune-confirm         Required for --mp-prune-all.

RELATIONSHIPS (make the "graph" in markdowngraphcli real)
      --mp-link <from> <to> <type> [note]
                                Create a directed edge between stashes.
                                Types: depends-on, related-to, see-also,
                                parent-of, child-of, supersedes, or
                                any custom string.
      --mp-unlink <from> <to>    Remove a relationship.
      --mp-related <name>        Show all stashes connected to <name>
                                (both inbound and outbound edges).
      --mp-graph <name> [depth]  Traversal graph from <name> up to
                                [depth] levels (default 3).

EXAMPLES
  # Find TODOs in src/, with 500 tokens of context, up to 20 nodes
  mdg "TODO" --in src/ --max-nodes 20

  # Paginate: 5 nodes per page, start at page 1
  mdg "TODO" --in src/ --max-nodes 100 --page 1 --page-size 5

  # Browse a large stash 5 nodes at a time
  mdg --mp-get auth-issues --page 2 --page-size 5

  # Browse a long list of stashes
  mdg --mp-list --page 1 --page-size 20

  # Stash this search's results into the mind palace
  mdg "TODO" --in src/ --mp-stash auth-todos "Auth TODOs to review"

  # Use a stashed file list as the search target
  mdg "rate" --mp-from auth-todos

  # Search across multiple stashes' file lists
  mdg "error" --mp-compose auth-todos perf-hotspots

  # List all stashes
  mdg --mp-list

  # Inspect a stash
  mdg --mp-get auth-todos

  # Free a slot
  mdg --mp-drop auth-todos

  # Multiple paths in one flag (greedy)
  mdg "TODO" --in src/ test/ docs/

  # Trailing positional paths (rg-style)
  mdg "TODO" src/ test/

  # Read path list from a file
  mdg "TODO" --in @filelist.txt

  # Read path list from stdin
  echo -e "src/\ntest/" | mdg "TODO" --in @-

  # Comma-separated
  mdg "TODO" --in src/,test/,docs/

  # Quick recon: narrow context, 5 nodes
  mdg "auth" --in . --effort quick --max-nodes 5

  # Deep dive: wide context, capped at 16k tokens
  mdg "session" --in src/auth/ --effort deep --max-tokens 16000

  # Search the output of a command
  mdg "error" --cmd "git log --oneline -100"

  # Pipe content in
  cat README.md | mdg "install"

  # JSON for programmatic harness integration
  mdg "TODO" --in src/ --format json

  # Markdown for pasting into a doc or chat
  mdg "TODO" --in src/ --format markdown
`;

export function parseArgs(argv: string[]): RawArgs {
  const args: RawArgs = {
    inPaths: [],
    stdin: false,
    hidden: false,
    noIgnore: false,
    ignoreCase: false,
    word: false,
    fixedStrings: false,
    multiline: false,
    includeGlobs: [],
    excludeGlobs: [],
    mpStashTags: [],
    mpStashReplace: false,
    mpList: false,
    mpListTags: [],
    mpCompose: [],
    mpExceptNames: [],
    mpIntersect: [],
    mpPruneAll: false,
    mpPruneConfirm: false,
    mpPruneDryRun: false,
    mpGraphDepth: 3,
    all: false,
    ls: false,
    mpStashLocations: false,
    noAutoTune: false,
    help: false,
    version: false,
  };

  let i = 0;
  while (i < argv.length) {
    const a = argv[i];

    // Long options with --no- prefix (boolean negation).
    if (a === "--no-color") { args.color = false; i++; continue; }
    if (a === "--color")    { args.color = true;  i++; continue; }

    if (a === "-h" || a === "--help")    { args.help = true; i++; continue; }
    if (a === "-v" || a === "--version") { args.version = true; i++; continue; }

    if (a === "-i" || a === "--in") {
      // Greedy: consume every subsequent non-flag arg as a path.
      // This lets users write `--in src/ test/ docs/` and get three paths.
      // To pass a path starting with `-`, prefix it with `./` or use
      // `--in=./-weird-name`. We also support comma-separated and the
      // special `@file` / `@-` syntax (see resolveInputList).
      i++;
      while (i < argv.length && !argv[i].startsWith("-")) {
        for (const p of argv[i].split(",").filter(Boolean)) {
          args.inPaths.push(p);
        }
        i++;
      }
      continue;
    }
    if (a === "--cmd") {
      args.cmd = requireValue(a, argv, ++i); i++; continue;
    }
    if (a === "--stdin") { args.stdin = true; i++; continue; }
    if (a === "-u" || a === "--url") {
      args.url = requireValue(a, argv, ++i); i++; continue;
    }
    if (a === "-b" || a === "--before") {
      args.before = parseInt(requireValue(a, argv, ++i), 10); i++; continue;
    }
    if (a === "-a" || a === "--after") {
      args.after = parseInt(requireValue(a, argv, ++i), 10); i++; continue;
    }
    if (a === "-n" || a === "--max-nodes") {
      args.maxNodes = parseInt(requireValue(a, argv, ++i), 10); i++; continue;
    }
    if (a === "--max-tokens") {
      args.maxTokens = parseInt(requireValue(a, argv, ++i), 10); i++; continue;
    }
    if (a === "--strategy") {
      const v = requireValue(a, argv, ++i);
      if (v !== "fill" && v !== "deep") throw new Error(`--strategy must be fill or deep, got: ${v}`);
      args.strategy = v; i++; continue;
    }
    if (a === "-e" || a === "--effort") {
      const v = requireValue(a, argv, ++i);
      if (!["scan", "quick", "normal", "deep", "auto"].includes(v)) {
        throw new Error(`--effort must be scan|quick|normal|deep|auto, got: ${v}`);
      }
      args.effort = v as Effort; i++; continue;
    }
    if (a === "-f" || a === "--format") {
      const v = requireValue(a, argv, ++i);
      if (!["llm", "markdown", "json", "text"].includes(v)) {
        throw new Error(`--format must be llm|markdown|json|text, got: ${v}`);
      }
      args.format = v as OutputFormat; i++; continue;
    }
    if (a === "-I" || a === "--ignore-case") { args.ignoreCase = true; i++; continue; }
    if (a === "-w" || a === "--word")        { args.word = true; i++; continue; }
    if (a === "-F" || a === "--fixed-strings") { args.fixedStrings = true; i++; continue; }
    if (a === "-U" || a === "--multiline")   { args.multiline = true; i++; continue; }
    if (a === "--hidden")  { args.hidden = true; i++; continue; }
    if (a === "--no-ignore") { args.noIgnore = true; i++; continue; }
    if (a === "--include") {
      args.includeGlobs.push(requireValue(a, argv, ++i)); i++; continue;
    }
    if (a === "--exclude") {
      args.excludeGlobs.push(requireValue(a, argv, ++i)); i++; continue;
    }
    if (a === "--type") {
      args.type = requireValue(a, argv, ++i); i++; continue;
    }

    // Mind palace flags.
    if (a === "--mp-stash") {
      // Consume two args: name and note.
      args.mpStashName = requireValue(a, argv, ++i); i++;
      args.mpStashNote = requireValue("--mp-stash <note>", argv, i); i++;
      continue;
    }
    if (a === "--mp-stash-note") {
      args.mpStashNote = requireValue(a, argv, ++i); i++; continue;
    }
    if (a === "--mp-stash-tag" || a === "--mp-tag") {
      args.mpStashTags.push(requireValue(a, argv, ++i)); i++; continue;
    }
    if (a === "--mp-replace") { args.mpStashReplace = true; i++; continue; }
    if (a === "--mp-list") { args.mpList = true; i++; continue; }
    if (a === "--mp-list-tag") {
      args.mpListTags.push(requireValue(a, argv, ++i)); i++; continue;
    }
    if (a === "--mp-get") { args.mpGet = requireValue(a, argv, ++i); i++; continue; }
    if (a === "--mp-drop") { args.mpDrop = requireValue(a, argv, ++i); i++; continue; }
    if (a === "--mp-from") { args.mpFrom = requireValue(a, argv, ++i); i++; continue; }
    if (a === "--mp-compose") {
      // Greedy: take every non-flag arg as a stash name.
      i++;
      while (i < argv.length && !argv[i].startsWith("-")) {
        for (const p of argv[i].split(",").filter(Boolean)) {
          args.mpCompose.push(p);
        }
        i++;
      }
      continue;
    }
    if (a === "--mp-except") {
      args.mpExcept = requireValue(a, argv, ++i); i++;
      // Greedy remainder = the stashes to exclude.
      while (i < argv.length && !argv[i].startsWith("-")) {
        for (const p of argv[i].split(",").filter(Boolean)) {
          args.mpExceptNames.push(p);
        }
        i++;
      }
      continue;
    }
    if (a === "--mp-intersect") {
      // Greedy: take every non-flag arg as a stash name.
      i++;
      while (i < argv.length && !argv[i].startsWith("-")) {
        for (const p of argv[i].split(",").filter(Boolean)) {
          args.mpIntersect.push(p);
        }
        i++;
      }
      continue;
    }
    if (a === "--mp-path") { args.mpPath = requireValue(a, argv, ++i); i++; continue; }
    if (a === "--mp-ttl") { args.mpTtl = requireValue(a, argv, ++i); i++; continue; }

    // Pruning.
    if (a === "--mp-prune-older-than") { args.mpPruneOlderThan = requireValue(a, argv, ++i); i++; continue; }
    if (a === "--mp-prune-keep") { args.mpPruneKeep = parseInt(requireValue(a, argv, ++i), 10); i++; continue; }
    if (a === "--mp-prune-tag") { args.mpPruneTag = requireValue(a, argv, ++i); i++; continue; }
    if (a === "--mp-prune-all") { args.mpPruneAll = true; i++; continue; }
    if (a === "--mp-prune-confirm") { args.mpPruneConfirm = true; i++; continue; }
    if (a === "--mp-prune-dry-run") { args.mpPruneDryRun = true; i++; continue; }

    // Relationships.
    if (a === "--mp-link") {
      args.mpLinkFrom = requireValue(a, argv, ++i); i++;
      args.mpLinkTo = requireValue("--mp-link <to>", argv, i); i++;
      args.mpLinkType = requireValue("--mp-link <type>", argv, i); i++;
      // Optional note.
      if (i < argv.length && !argv[i].startsWith("-")) {
        args.mpLinkNote = argv[i];
        i++;
      }
      continue;
    }
    if (a === "--mp-unlink") {
      args.mpUnlinkFrom = requireValue(a, argv, ++i); i++;
      args.mpUnlinkTo = requireValue("--mp-unlink <to>", argv, i); i++;
      continue;
    }
    if (a === "--mp-related") {
      args.mpRelated = requireValue(a, argv, ++i); i++; continue;
    }
    if (a === "--mp-graph") {
      args.mpGraph = requireValue(a, argv, ++i); i++;
      // Optional depth.
      if (i < argv.length && !argv[i].startsWith("-")) {
        args.mpGraphDepth = parseInt(argv[i], 10);
        i++;
      }
      continue;
    }

    // Pagination.
    if (a === "--page") { args.page = parseInt(requireValue(a, argv, ++i), 10); i++; continue; }
    if (a === "--page-size") { args.pageSize = parseInt(requireValue(a, argv, ++i), 10); i++; continue; }
    if (a === "--all") { args.all = true; i++; continue; }
    if (a === "--no-auto-tune") { args.noAutoTune = true; i++; continue; }
    if (a === "--ls" || a === "--tree") { args.ls = true; i++; continue; }
    if (a === "--mp-stash-locations") { args.mpStashLocations = true; i++; continue; }

    // Positional: first non-flag is the pattern. Any subsequent
    // non-flag args are treated as input paths (like `rg`).
    if (!a.startsWith("-") && args.pattern === undefined) {
      args.pattern = a;
      i++;
      continue;
    }
    if (!a.startsWith("-") && args.pattern !== undefined) {
      // Trailing positionals after the pattern are paths.
      for (const p of a.split(",").filter(Boolean)) {
        args.inPaths.push(p);
      }
      i++;
      continue;
    }

    throw new Error(`Unknown argument: ${a}`);
  }

  return args;
}

function requireValue(flag: string, argv: string[], i: number): string {
  if (i >= argv.length) throw new Error(`Missing value for ${flag}`);
  return argv[i];
}

/** Resolve a RawArgs into a fully-specified config. */
export function resolveConfig(raw: RawArgs): ResolvedConfig {
  if (raw.help) throw new HelpRequestedError();
  if (raw.version) throw new VersionRequestedError();

  // Pattern is optional: required for searches and for --mp-from /
  // --mp-compose, but not for --mp-list, --mp-get, or --mp-drop.
  const pattern = raw.pattern ?? process.env.MDG_PATTERN;
  const needsPattern =
    !raw.ls && (
    raw.inPaths.length > 0 ||
    raw.cmd !== undefined ||
    raw.url !== undefined ||
    raw.stdin ||
    raw.mpFrom !== undefined ||
    (raw.mpCompose && raw.mpCompose.length > 0) ||
    raw.mpExcept !== undefined ||
    (raw.mpIntersect && raw.mpIntersect.length > 0) ||
    raw.mpStashName !== undefined);
  if (needsPattern && !pattern) {
    throw new Error("No pattern provided. Pass it as the first positional argument, e.g. `mdg \"TODO\"`.");
  }

  // Apply effort preset, then explicit overrides.
  const effort: Effort = raw.effort ?? "quick";
  const preset = EFFORT_PRESETS[effort];
  const before = raw.before ?? preset.before;
  const after = raw.after ?? preset.after;
  const maxNodes = raw.maxNodes ?? preset.maxNodes;
  const strategy: Strategy = raw.strategy ?? "fill";
  const format: OutputFormat = raw.format ?? "llm";
  const color = raw.color ?? (process.stdout.isTTY ?? false);

  // Build the source input list. Resolution to actual Source objects
  // happens in the orchestrator (index.ts) since some sources need
  // async I/O (commands, urls, stdin).
  const inputs: SourceInput[] = [];
  if (raw.inPaths.length > 0) {
    for (const p of raw.inPaths) inputs.push({ type: "path", path: p });
  }
  if (raw.cmd) inputs.push({ type: "command", command: raw.cmd });
  if (raw.url) inputs.push({ type: "url", url: raw.url });
  if (raw.stdin || (!process.stdin.isTTY && inputs.length === 0 && !needsPattern)) {
    inputs.push({ type: "stdin" });
  }

  // If --mp-from or --mp-compose is given, we still need a pattern but
  // can skip the source check: the orchestrator will derive sources
  // from the palace. The check below catches "no inputs AND no palace".
  const hasPalaceInput = raw.mpFrom !== undefined ||
    (raw.mpCompose && raw.mpCompose.length > 0) ||
    raw.mpExcept !== undefined ||
    (raw.mpIntersect && raw.mpIntersect.length > 0);
  if (inputs.length === 0 && !hasPalaceInput && !raw.mpStashName && !raw.mpList && !raw.mpGet && !raw.mpDrop) {
    throw new Error(
      "No source provided. Use --in <path>, --cmd <command>, --url <url>, --mp-from, --mp-compose, or pipe via stdin.",
    );
  }

  const rgOptions: RgOptions = {};
  if (raw.ignoreCase) rgOptions.case_insensitive = true;
  if (raw.word) rgOptions.word_match = true;
  if (raw.fixedStrings) rgOptions.fixed_strings = true;
  if (raw.multiline) rgOptions.multiline = true;
  if (raw.hidden) rgOptions.hidden = true;
  if (raw.noIgnore) rgOptions.no_ignore = true;
  if (raw.includeGlobs.length > 0) rgOptions.include_globs = raw.includeGlobs;
  if (raw.excludeGlobs.length > 0) rgOptions.exclude_globs = raw.excludeGlobs;
  if (raw.type) rgOptions.type = raw.type;

  // Build mind palace ops object if any palace flag was given.
  let mind_palace: ResolvedConfig["mind_palace"];
  if (
    raw.mpStashName || raw.mpList || raw.mpGet || raw.mpDrop ||
    raw.mpFrom || (raw.mpCompose && raw.mpCompose.length > 0) ||
    raw.mpExcept || (raw.mpIntersect && raw.mpIntersect.length > 0) ||
    raw.mpPruneOlderThan || raw.mpPruneKeep !== undefined || raw.mpPruneTag ||
    raw.mpPruneAll || raw.mpTtl || raw.mpPath ||
    raw.mpLinkFrom || raw.mpUnlinkFrom || raw.mpRelated || raw.mpGraph
  ) {
    mind_palace = {
      path: raw.mpPath,
      prune_all: raw.mpPruneAll,
      prune_confirm: raw.mpPruneConfirm,
      prune_dry_run: raw.mpPruneDryRun,
    };
    if (raw.mpStashName) {
      mind_palace.stash = {
        name: raw.mpStashName,
        note: raw.mpStashNote ?? "",
        tags: raw.mpStashTags,
        replace: raw.mpStashReplace,
      };
    }
    if (raw.mpList) mind_palace.list = { tags: raw.mpListTags };
    if (raw.mpGet) mind_palace.get = raw.mpGet;
    if (raw.mpDrop) mind_palace.drop = raw.mpDrop;
    if (raw.mpFrom) mind_palace.from = raw.mpFrom;
    if (raw.mpCompose && raw.mpCompose.length > 0) mind_palace.compose = raw.mpCompose;
    if (raw.mpExcept) {
      mind_palace.except = { base: raw.mpExcept, exclude: raw.mpExceptNames };
    }
    if (raw.mpIntersect && raw.mpIntersect.length > 0) {
      mind_palace.intersect = raw.mpIntersect;
    }
    if (raw.mpTtl) mind_palace.ttl = raw.mpTtl;
    // Relationships.
    if (raw.mpLinkFrom && raw.mpLinkTo && raw.mpLinkType) {
      mind_palace.link = {
        from: raw.mpLinkFrom,
        to: raw.mpLinkTo,
        type: raw.mpLinkType,
        note: raw.mpLinkNote ?? "",
      };
    }
    if (raw.mpUnlinkFrom && raw.mpUnlinkTo) {
      mind_palace.unlink = { from: raw.mpUnlinkFrom, to: raw.mpUnlinkTo };
    }
    if (raw.mpRelated) mind_palace.related = raw.mpRelated;
    if (raw.mpGraph) mind_palace.graph = { name: raw.mpGraph, depth: raw.mpGraphDepth ?? 3 };
    // Pruning.
    if (raw.mpPruneOlderThan) mind_palace.prune_older_than = raw.mpPruneOlderThan;
    if (raw.mpPruneKeep !== undefined) mind_palace.prune_keep = raw.mpPruneKeep;
    if (raw.mpPruneTag) mind_palace.prune_tag = raw.mpPruneTag;
    if (raw.mpPruneAll) mind_palace.prune_all = true;
    mind_palace.prune_confirm = raw.mpPruneConfirm;
    mind_palace.prune_dry_run = raw.mpPruneDryRun;
  }

  return {
    ...(pattern !== undefined ? { pattern } : {}),
    before_tokens: before,
    after_tokens: after,
    max_nodes: maxNodes,
    max_tokens: raw.maxTokens,
    strategy,
    effort,
    format,
    color,
    inputs,
    rg_options: rgOptions,
    mind_palace,
    page: raw.page,
    page_size: raw.pageSize,
    all: raw.all,
    ls: raw.ls,
    mp_stash_locations: raw.mpStashLocations,
    no_auto_tune: raw.noAutoTune,
    auto_tune_eligible: !raw.noAutoTune && raw.before === undefined && raw.after === undefined,
  } as ResolvedConfig;
}

// (Intentionally no extra validation hook here — --page/--all
// compatibility is checked at apply time where the combination is
// actually meaningful.)

export class HelpRequestedError extends Error {
  constructor() { super("help requested"); this.name = "HelpRequestedError"; }
}
export class VersionRequestedError extends Error {
  constructor() { super("version requested"); this.name = "VersionRequestedError"; }
}
