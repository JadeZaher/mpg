# mpg — node-centric context retrieval for LLM harnesses

`mpg` is a CLI for retrieving **token-budgeted context nodes** from
files, command output, URLs, and stdin, designed to be consumed
directly by LLM harnesses.

The differentiator: a search returns **nodes** (a match + sized pre/post
context), not files or lines. Each node is sized in **tokens**, and you
can cap the **number of nodes** and the **total token budget**
independently. Depth of context is set by `effort`, not by blindly
loading more text.

Plus a persistent **mind palace** — named, addressable stashes of
search results that compose, intersect, prune, and form a graph. mpg
is how agents browse and trim long-term memory, not just how they grep.

## Headline numbers vs alternatives

Pulled from the in-repo benchmark suite (`bench/` + [`BENCHMARKS.md`](./BENCHMARKS.md)).

| workload | mpg config | result vs alternatives |
| :--- | :--- | :--- |
| Literal recall on a markdown/JSON memory corpus | `--effort scan --clip 30` | 100% / 100% / **377 tokens** vs ripgrep's 1,197 — **3.2× cheaper than rg** |
| Typo-tolerant search (drop / insert / swap / sub) | `--fuzzy` | **100%** recall vs ripgrep's 0%, ~12× cheaper than per-file embedding retrieval |
| Topic compaction at fixed token budget | `--effort scan --clip 30 --max-tokens N` | 67% downstream-Q&A pass vs LLM summarization's 33% — at **zero LLM input tokens** |
| Multi-turn agent convergence | `mpg_search` + `mpg_stash` | 24% fewer input tokens, **half the tool calls and turns** vs read+grep control |
| Mind palace set semantics | `--mp-compose` / `--mp-intersect` / `--mp-except` | 17/17 micro assertions pass |

[`BENCHMARKS.md`](./BENCHMARKS.md) has the full scorecard and the
cases where mpg loses (single-keyword greps, CLI cold start), reported
honestly.

## Install

Requires [Node 20+](https://nodejs.org) and [ripgrep](https://github.com/BurntSushi/ripgrep).

```bash
npm install -g mind-palace-graph
# or from source:
git clone https://github.com/JadeZaher/mind-palace-graph.git
cd mind-palace-graph && npm install && npm run build && npm link
```

For Claude / Gemini / coding agents: load `skills/mpg-context/SKILL.md`
into your system prompt or tool descriptions — it has the decision tree
for effort levels, mind palace patterns, pagination, and error recovery.

## Command reference

The shape of every command is:

```
mpg [<pattern>] [options]
```

`<pattern>` is a ripgrep regex (or a literal with `-F`). It is required
for searches and stash-producing operations, omitted for pure palace
operations (`--mp-list`, `--mp-get`, `--mp-drop`, `--mp-link`,
`--mp-related`, `--mp-graph`, `--mp-prune-*`, `--ls`).

### Sources — where to search

| Flag | Example | What it does |
| :--- | :--- | :--- |
| `-i, --in <path>...` | `mpg "TODO" --in src/ test/` | One or more files, dirs, or globs. Greedy: consumes non-flag args. Dirs recurse. |
| `--in @<file>` | `mpg "TODO" --in @files.txt` | Read path list from a file (one per line, `#` comments). |
| `--in @-` | `ls *.ts \| mpg "TODO" --in @-` | Read path list from stdin. |
| `--in a,b,c` | `mpg "TODO" --in src/,test/` | Comma-separated path list. |
| trailing paths | `mpg "TODO" src/ test/` | rg-style positionals; equivalent to `--in`. |
| `--in '**/*.ts'` | `mpg "TODO" --in '**/*.ts'` | Glob (single or multi-wildcard). |
| `--cmd <cmd>` | `mpg "error" --cmd "git log --oneline -100"` | Search the stdout of a shell command. |
| `--stdin` | `cat README.md \| mpg "install"` | Search piped stdin (auto-detected when piped). |
| `-u, --url <url>` | `mpg "deprecated" -u https://example.com/docs` | Fetch URL body and search it. |

To pass a path that starts with `-`, prefix it with `./` (e.g.
`./-weird-name`) or use `@file` syntax.

### Node sizing — context width and density

| Flag | Example | What it does |
| :--- | :--- | :--- |
| `-b, --before <tokens>` | `--before 800` | Tokens of context before each match. Default: 500. |
| `-a, --after <tokens>` | `--after 800` | Tokens of context after each match. Default: 500. |
| `-n, --max-nodes <n>` | `--max-nodes 20` | Hard cap on nodes returned. Default: 30. |
| `--max-tokens <n>` | `--max-tokens 8000` | Total token budget across all nodes. |
| `--strategy fill\|deep` | `--strategy deep` | Spend `--max-tokens` on more nodes (`fill`) or deeper per node (`deep`). |
| `-e, --effort <preset>` | `--effort scan` | Bundles before/after/max-nodes. **`scan`** (20t / uncapped, index mode), **`quick`** (200t / 10n, **default**), `normal` (500t / 30n), `deep` (2000t / 100n). |
| `--clip <N>` | `--clip 30` | **Sub-line snippet mode.** Drops line context; trims the match line to N chars on each side of the matched span. Combine with `--effort scan` for the cheapest possible index. |
| `--sort <mode>` | `--sort recent` | Order nodes by source file mtime: `recent` (newest first), `oldest`, `default` (rg's order). Pairs with `scan` for a time-ordered memory index. |
| `--window-curve <mode>` | `--window-curve log` | Per-node window decay across ranks: `flat` (default), `linear` (full → ~10% at last), `log` (`full / log2(rank+2)`). Combine with `--sort recent` for "rich on what just changed, tight on older history." |
| `--fuzzy` | `--fuzzy` | Typo-tolerant search. Trigram-union driver + Levenshtein post-filter (edit distance ≤ 2). Handles drop / insert / substitute / swap. Skipped when the pattern already has regex metacharacters. |

### Output

| Flag | Example | What it does |
| :--- | :--- | :--- |
| `-f, --format <fmt>` | `--format json` | `llm` (default), `markdown`, `json`, `text`. |
| `--json` | `--json` | Alias for `--format json` (ecosystem convention). |
| `--color` / `--no-color` | `--no-color` | Force or disable ANSI color. Auto by default. |

Token estimation uses a fast `chars/4` heuristic — accurate enough for
budgeting, not a substitute for a real tokenizer when billing matters.
The `tokens` field is always approximate and prefixed with `~` in `llm`
format.

### Search options (forwarded to ripgrep)

| Flag | Example | What it does |
| :--- | :--- | :--- |
| `-I, --ignore-case` | `-I` | Case-insensitive match. |
| `-w, --word` | `-w` | Match whole words only. |
| `-F, --fixed-strings` | `-F` | Treat pattern as a literal string, not a regex. |
| `-U, --multiline` | `-U` | Allow patterns to span lines. |
| `--hidden` | `--hidden` | Include hidden files and dirs. |
| `--no-ignore` | `--no-ignore` | Don't respect `.gitignore`. |
| `--include <glob>` | `--include '*.ts'` | Only files matching glob (repeatable). |
| `--exclude <glob>` | `--exclude '*.test.ts'` | Skip files matching glob (repeatable). |
| `--type <lang>` | `--type ts` | ripgrep file-type filter (`ts`, `rust`, `py`, ...). |

### Pagination

| Flag | Example | What it does |
| :--- | :--- | :--- |
| `--page <n>` | `--page 1` | Return only the Nth page (1-indexed). Paginates nodes (search / `--mp-get --with-nodes`) or stashes (`--mp-list`). |
| `--page-size <n>` | `--page-size 5` | Items per page. Defaults: 10 for nodes, 20 for stashes. |
| `--all` | `--all` | Disable pagination, return everything. |

### Mind palace — instantiable short-term memory

A palace is a JSON file (default `./.mpg/mind-palace.json`) of named
**stashes**: search results addressable by name. Future searches can
use stashes as inputs (`--mp-from`), compose them across sets
(`--mp-compose` / `--mp-intersect` / `--mp-except`), tag them, and link
them into a graph. Stashes default to **merge on duplicate name**
(dedup by file:line); pass `--mp-replace` to overwrite. Override the
palace file at runtime with `--mp-path` or `MPG_MIND_PALACE=<file>` —
useful for one-palace-per-task isolation.

| Flag | Example | What it does |
| :--- | :--- | :--- |
| `--mp-stash <name> <note>` | `mpg "TODO" --in src/ --mp-stash auth "Auth TODOs"` | Run the search, save the result under `name`. |
| `--mp-stash-note <note>` | `--mp-stash-note "extra context"` | Set the note separately. |
| `--mp-tag <tag>` | `--mp-tag p0 --mp-tag auth` | Tag a stash (repeatable). |
| `--mp-replace` | `--mp-replace` | Overwrite an existing stash rather than merging. |
| `--mp-ttl <duration>` | `--mp-ttl 2h` | Auto-expire this stash after the duration (e.g. `30m`, `2h`, `7d`). |
| `--mp-list` | `mpg --mp-list` | List all stashes (with relative timestamps). |
| `--mp-list-tag <tag>` | `mpg --mp-list --mp-list-tag p0` | Filter list by tag (repeatable). |
| `--mp-get <name>` | `mpg --mp-get auth` | Show a stash. Default: **card view** (note, tags, sources, counts — no captured nodes). Add `--with-nodes` for the full dump. |
| `--mp-drop <name>` | `mpg --mp-drop auth` | Remove a stash. |
| `--mp-from <name>` | `mpg "rate.limit" --mp-from auth` | Re-run a fresh search, scoped to the files in a stash. |
| `--mp-compose <a> <b>...` | `mpg "error" --mp-compose auth perf` | Search across the **union** of multiple stashes' files. |
| `--mp-except <a> <b>...` | `mpg "TODO" --mp-except deprecated` | Search files NOT in the listed stash(es). |
| `--mp-intersect <a> <b>...` | `mpg "TODO" --mp-intersect auth perf` | Search files in **all** the listed stashes. |
| `--mp-path <file>` | `--mp-path .mpg/task-42.json` | Use an isolated palace file. |
| `--mp-stash-locations` | `--mp-stash-locations` | Save only file:line pointers, drop context text (lean stashes). |

### Pruning — keep the palace from growing unbounded

| Flag | Example | What it does |
| :--- | :--- | :--- |
| `--mp-prune-older-than <dur>` | `--mp-prune-older-than 7d` | Remove stashes not updated within the duration. |
| `--mp-prune-keep <n>` | `--mp-prune-keep 10` | Keep only the N most recently updated stashes. |
| `--mp-prune-tag <tag>` | `--mp-prune-tag temp` | Remove all stashes carrying the tag. |
| `--mp-prune-expired` | `--mp-prune-expired` | Remove stashes whose `--mp-ttl` has elapsed. |
| `--mp-prune-all` | `--mp-prune-all --mp-prune-confirm` | Clear the entire palace. `--mp-prune-confirm` required. |
| `--mp-prune-dry-run` | `--mp-prune-older-than 7d --mp-prune-dry-run` | Show what *would* be pruned. **Always use this first.** |

Expired-TTL stashes also auto-prune silently on every `--mp-list` /
`--mp-get`.

### Relationships — make the *graph* in mind-palace-graph real

| Flag | Example | What it does |
| :--- | :--- | :--- |
| `--mp-link <from> <to> <type> [note]` | `mpg --mp-link auth perf depends-on "shared db"` | Create a directed edge. Types: `depends-on`, `related-to`, `see-also`, `parent-of`, `child-of`, `supersedes`, or any custom string. |
| `--mp-unlink <from> <to>` | `mpg --mp-unlink auth perf` | Remove a relationship. |
| `--mp-related <name>` | `mpg --mp-related auth` | Show all stashes connected to `name` (inbound + outbound). |
| `--mp-graph <name> [depth]` | `mpg --mp-graph auth 3` | Traversal graph from `name` up to `[depth]` (default 3). |

### Discovery & meta

| Flag | Example | What it does |
| :--- | :--- | :--- |
| `--ls` / `--tree` | `mpg --ls --in src/` | List/tree all searchable files and exit. |
| `-h, --help` | `mpg --help` | Show inline help. |
| `-v, --version` | `mpg --version` | Print version. |
| `--print-entry` | `mpg --print-entry` | Print the resolved JS entry path (`dist/index.js`) and exit. For Node subprocess callers — see [Calling mpg from another process](#calling-mpg-from-another-process). |
| `--pattern-file <path>` | `mpg --pattern-file /tmp/p --in src/` | Read the regex from a file (trailing newline stripped). Mutually exclusive with the positional pattern. Keeps exotic regexes off argv. |

### Environment variables

| Variable | Effect |
| :--- | :--- |
| `MPG_MIND_PALACE` | Override default palace path (`./.mpg/mind-palace.json`). |
| `MPG_PATTERN` | Default pattern if none is passed positionally. |

### Exit codes

| Code | Meaning |
| ---: | :--- |
| 0 | Matches found (or palace operation succeeded) |
| 1 | No matches (matches ripgrep's convention) |
| 2 | Bad arguments |
| 3 | ripgrep not installed |
| 4 | Mind palace error (unknown stash, etc.) |
| 99 | Unexpected error |

## Recipes

```bash
# Cheapest first-touch index — "browse my recent memory"
# 3.2x cheaper than rg at 100/100 recall/precision on memory-system content.
mpg "JWT|Bearer|ProviderContext" --in . \
  --effort scan --clip 30 --sort recent --page 1 --page-size 10

# Typo-tolerant search (catches drop/insert/substitute/swap, edit dist <= 2)
mpg "PrvderiContext" --in . --fuzzy --effort scan --clip 30

# Topic compaction at a hard token budget (zero LLM cost)
mpg "auth|JWT|Bearer|ProviderContext" --in conductor/tracks \
  --effort scan --clip 30 --sort recent --window-curve log \
  --max-tokens 2000 --format llm > auth-compaction.md

# Quick recon
mpg "auth" --in . --effort quick --max-nodes 5

# Deep grounding for a final answer
mpg "session" --in src/auth/ --effort deep --max-tokens 16000

# Search the output of a command
mpg "error" --cmd "git log --oneline -100"

# Pipe content in
cat README.md | mpg "install"

# Stash + tag + TTL
mpg "TODO" --in src/auth/ --mp-stash auth-todos "Auth TODOs" \
  --mp-tag auth --mp-tag p0 --mp-ttl 7d

# Compose two stashes, re-search across their union
mpg "error" --mp-compose auth-todos perf-hotspots

# Re-search scoped to one stash's files
mpg "rate.limit" --mp-from auth-todos

# Link stashes into a graph, then traverse it
mpg --mp-link auth-todos perf-hotspots depends-on "shared db layer"
mpg --mp-graph auth-todos 3

# Prune safely
mpg --mp-prune-older-than 7d --mp-prune-dry-run     # preview
mpg --mp-prune-older-than 7d                        # commit

# One palace per task (isolation)
MPG_MIND_PALACE=./.mpg/task-42.json mpg "TODO" --in src/ --mp-stash t42 "..."

# Programmatic JSON for a harness
mpg "TODO" --in src/ --format json --page 1 --page-size 5
```

## Output format: `llm`

The default. Designed to be both human-readable and directly consumed
by an LLM harness:

```text
<mpg result pattern="TODO" nodes=4 tokens=~566 effort=normal strategy=fill>

--- NODE 1 of 4 | src/auth/login.ts:8 | ~196 tokens ---
  5    // Authentication flow for the public API.
  6    // Validates the user credentials, then issues a short-lived session token.
  7    export async function login(user: User, password: string) {
  8 >>   // **TODO**: add rate limiting per IP+user to prevent brute force
  9      const valid = await db.users.verifyPassword(user.id, password);
 10      if (!valid) {
 11        logger.warn(`failed login for ${user.id}`);
 ...

--- TOTAL ---
4 nodes | ~566 tokens | 3 sources | 30ms
</mpg result>
```

The result block carries the pattern, total token cost, source
attribution per snippet, and match highlighting (`>>` + `**bold**`).
The JSON format includes a `pagination` block with `total_items`,
`total_pages`, `has_next`, `has_prev`.

## Programmatic API

For TS/Node harnesses that prefer to embed mpg rather than shell out:

```ts
import { search, stash, listStashes, toolDefinition } from "mind-palace-graph";

const result = await search({
  pattern: "TODO",
  in: ["src/"],
  effort: "quick",
  page: 1,
  pageSize: 5,
});

await stash(result, {
  name: "auth-issues",
  note: "Auth TODOs to review",
  tags: ["auth", "p0"],
});

// Expose to OpenAI / Anthropic function calling:
openai.tools.create({ name: "mpg", ...toolDefinition });
```

The API mirrors the CLI 1:1. Pre-built tool schemas are exported as
`claudeTools` and `geminiTools`.

## Calling mpg from another process

If you spawn `mpg` from Node `child_process.spawn` rather than from a
shell, Windows needs care. The npm-installed `mpg` on Windows is a
`.cmd` shim, and the obvious approaches both fail:

| Approach | What happens on Windows |
| :--- | :--- |
| `spawn("mpg", args)` | `EINVAL` — Node won't directly execute a `.cmd`. |
| `spawn("mpg", args, { shell: true })` | cmd.exe parses the line and splits on `&`/`\|`/`^`/etc.; flags get **corrupted** before mpg sees them. Typical symptom: `'--stdin' is not recognized as an internal or external command` followed by `mpg: Unknown argument: --git`. |

Spawn `node` directly on mpg's resolved JS entry instead:

```ts
import { spawn } from "node:child_process";
import { entryPath } from "mind-palace-graph/entry";

spawn(process.execPath, [
  entryPath, "TODO", "--in", "src/", "--json",
], { stdio: ["ignore", "pipe", "pipe"] });
```

`entryPath` is exported by the side-effect-free `mind-palace-graph/entry`
subpath (importing does NOT execute the CLI). For non-Node callers,
`mpg --print-entry` prints the same path on stdout.

For regexes with shell metacharacters or untrusted input, write the
pattern to a temp file and pass `--pattern-file <path>`:

```ts
import { writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "mpg-"));
const patternFile = join(dir, "p");
writeFileSync(patternFile, exoticRegex);

spawn(process.execPath, [
  entryPath, "--pattern-file", patternFile, "--in", "src/", "--json",
]);
```

Quick picker:

| You are building... | Use |
| :--- | :--- |
| MCP host (Claude Desktop, Cline, Windsurf) | The MCP server. No subprocess concerns. |
| Node agent that imports the SDK directly | `import { search } from "mind-palace-graph"`. |
| Custom Node subprocess wrapper (Pi extension, agent runner) | `spawn(process.execPath, [entryPath, ...args])`. |
| Shell-only agent (bash one-liners) | Plain `mpg ...`. Shells handle the shim correctly; the footgun only hits when spawning *from another program*. |

## Architecture

```
src/
  cli.ts           hand-rolled arg parser + effort preset resolution
  types.ts         shared types (Node, Source, Result, etc.)
  tokens.ts        token estimation + line trimming to budget
  rg.ts            ripgrep wrapper (rg --json)
  sources.ts       source resolution: file / glob / command / stdin / url
  nodes.ts         match → context node construction
  format.ts        llm / markdown / json / text output
  mind-palace.ts   stash / drop / list / compose / except / intersect
  palace-format.ts llm-friendly formatters for palace output
  pagination.ts    page-through-the-results utility
  api.ts           programmatic API (search, stash, toolDefinition)
  entry.ts         side-effect-free JS entry path export
  index.ts         orchestrator (CLI entry point)
```

mpg shells out to `rg --json` for the actual search — fastest regex
engine, structured match data. Everything else (node building, context
sizing, output formatting, mind palace) is in-process TypeScript.

## Development

```bash
npm run dev     # run with tsx (no build step)
npm run build   # compile to dist/
npm test        # run smoke tests
```

## License

MIT.
