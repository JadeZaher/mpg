# mdg — node-centric context retrieval for LLM harnesses

`mdg` is a CLI tool for retrieving **token-budgeted context nodes** from
files, command output, URLs, and stdin, designed to be consumed directly by
LLM harnesses.

The differentiator: a search returns **nodes** (a match + sized pre/post
context), not files or lines. Each node is sized in **tokens**, not lines,
and you can cap the **number of nodes** and the **total token budget**
independently. The depth of context is adjusted by `effort` rather than by
blindly loading more text.

## Command reference

Every flag, grouped by category. The shape of every command is:

```
mdg [<pattern>] [options]
```

`<pattern>` is a ripgrep regex (or a literal string with `-F`). It is
required for searches and stash-producing operations, and omitted for
pure palace operations (`--mp-list`, `--mp-get`, `--mp-drop`, `--mp-link`,
`--mp-related`, `--mp-graph`, `--mp-prune-*`, `--ls`).

### Sources — where to search

| Flag | Example | What it does |
| :--- | :--- | :--- |
| `-i, --in <path>...` | `mdg "TODO" --in src/ test/` | One or more files, dirs, or globs. Greedy: consumes non-flag args. Dirs recurse. |
| `--in @<file>` | `mdg "TODO" --in @files.txt` | Read path list from a file (one per line, `#` comments). |
| `--in @-` | `ls *.ts \| mdg "TODO" --in @-` | Read path list from stdin. |
| `--in a,b,c` | `mdg "TODO" --in src/,test/` | Comma-separated path list. |
| trailing paths | `mdg "TODO" src/ test/` | rg-style positionals; equivalent to `--in`. |
| `--cmd <cmd>` | `mdg "error" --cmd "git log --oneline -100"` | Search the stdout of a shell command. |
| `--stdin` | `cat README.md \| mdg "install"` | Search piped stdin (auto-detected when piped). |
| `-u, --url <url>` | `mdg "deprecated" -u https://example.com/docs` | Fetch URL body and search it. |

### Node sizing — control context width and density

| Flag | Example | What it does |
| :--- | :--- | :--- |
| `-b, --before <tokens>` | `--before 800` | Tokens of context before each match. Default: 500. |
| `-a, --after <tokens>` | `--after 800` | Tokens of context after each match. Default: 500. |
| `-n, --max-nodes <n>` | `--max-nodes 20` | Hard cap on nodes returned. Default: 30. |
| `--max-tokens <n>` | `--max-tokens 8000` | Total token budget across all nodes. |
| `--strategy fill\|deep` | `--strategy deep` | Spend `--max-tokens` on more nodes (`fill`) or deeper per node (`deep`). |
| `-e, --effort <preset>` | `--effort quick` | Preset bundles: `quick` (200t/10n), `normal` (500t/30n), `deep` (2000t/100n), `auto`. |

### Output

| Flag | Example | What it does |
| :--- | :--- | :--- |
| `-f, --format <fmt>` | `--format json` | `llm` (default), `markdown`, `json`, `text`. |
| `--color` / `--no-color` | `--no-color` | Force or disable ANSI color. Auto by default. |

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
| `--page <n>` | `--page 1` | Return only the Nth page (1-indexed). Paginates nodes (search / `--mp-get`) or stashes (`--mp-list`). |
| `--page-size <n>` | `--page-size 5` | Items per page. Defaults: 10 for nodes, 20 for stashes. |
| `--all` | `--all` | Disable pagination, return everything. |

### Mind palace — instantiable short-term memory

A palace is a JSON file (default `./.mdg/mind-palace.json`) that holds
named **stashes** of search results. Stashes are addressable: future
searches can use them as inputs.

| Flag | Example | What it does |
| :--- | :--- | :--- |
| `--mp-stash <name> <note>` | `mdg "TODO" --in src/ --mp-stash auth "Auth TODOs"` | Run the search, save the result under `name`. Merges into an existing stash; pass `--mp-replace` to overwrite. |
| `--mp-stash-note <note>` | `--mp-stash-note "extra context"` | Set the note separately. |
| `--mp-stash-tag <tag>` / `--mp-tag <tag>` | `--mp-tag p0 --mp-tag auth` | Tag a stash (repeatable). |
| `--mp-replace` | `--mp-replace` | Overwrite an existing stash rather than merging. |
| `--mp-ttl <duration>` | `--mp-ttl 2h` | Auto-expire this stash after the duration (e.g. `30m`, `2h`, `7d`). |
| `--mp-list` | `mdg --mp-list` | List all stashes (with relative timestamps). |
| `--mp-list-tag <tag>` | `mdg --mp-list --mp-list-tag p0` | Filter list by tag (repeatable). |
| `--mp-get <name>` | `mdg --mp-get auth` | Show the full contents of one stash. |
| `--mp-drop <name>` | `mdg --mp-drop auth` | Remove a stash. |
| `--mp-from <name>` | `mdg "rate.limit" --mp-from auth` | Re-run a fresh search, scoped to the files in a stash. |
| `--mp-compose <a> <b>...` | `mdg "error" --mp-compose auth perf` | Run a search across the **union** of multiple stashes' files. |
| `--mp-except <a>` / `--mp-except <a> <b>...` | `mdg "TODO" --mp-except deprecated` | Search files NOT in the listed stash(es). |
| `--mp-intersect <a> <b>...` | `mdg "TODO" --mp-intersect auth perf` | Search files in **all** the listed stashes (set intersection). |
| `--mp-path <file>` | `--mp-path .mdg/task-42.json` | Use an isolated palace file. Also: `MDG_MIND_PALACE` env var. |
| `--mp-stash-locations` | `--mp-stash-locations` | Save only file:line pointers, drop context text (lean stashes). |

### Pruning — keep the palace from growing unbounded

| Flag | Example | What it does |
| :--- | :--- | :--- |
| `--mp-prune-older-than <dur>` | `--mp-prune-older-than 7d` | Remove stashes not updated within the duration. |
| `--mp-prune-keep <n>` | `--mp-prune-keep 10` | Keep only the N most recently updated stashes. |
| `--mp-prune-tag <tag>` | `--mp-prune-tag temp` | Remove all stashes carrying the tag. |
| `--mp-prune-expired` | `--mp-prune-expired` | Remove stashes whose `--mp-ttl` has elapsed. |
| `--mp-prune-all` | `--mp-prune-all --mp-prune-confirm` | Clear the entire palace. `--mp-prune-confirm` required. |
| `--mp-prune-dry-run` | `--mp-prune-older-than 7d --mp-prune-dry-run` | Show what *would* be pruned, don't delete. **Use this first.** |

### Relationships — make the *graph* in markdowngraphcli real

| Flag | Example | What it does |
| :--- | :--- | :--- |
| `--mp-link <from> <to> <type> [note]` | `mdg --mp-link auth perf depends-on "shared db"` | Create a directed edge. Types: `depends-on`, `related-to`, `see-also`, `parent-of`, `child-of`, `supersedes`, or any custom string. |
| `--mp-unlink <from> <to>` | `mdg --mp-unlink auth perf` | Remove a relationship. |
| `--mp-related <name>` | `mdg --mp-related auth` | Show all stashes connected to `name` (inbound + outbound). |
| `--mp-graph <name> [depth]` | `mdg --mp-graph auth 3` | Traversal graph from `name` up to `[depth]` (default 3). |

### Discovery & meta

| Flag | Example | What it does |
| :--- | :--- | :--- |
| `--ls` / `--tree` | `mdg --ls --in src/` | List/tree all searchable files under the given paths and exit. |
| `-h, --help` | `mdg --help` | Show inline help. |
| `-v, --version` | `mdg --version` | Print version. |

### Environment variables

| Variable | Effect |
| :--- | :--- |
| `MDG_MIND_PALACE` | Override default palace path (`./.mdg/mind-palace.json`). |
| `MDG_PATTERN` | Default pattern if none is passed positionally. |

### Common recipes (copy-paste)

```bash
# Quick recon
mdg "auth" --in . --effort quick --max-nodes 5

# Deep grounding for a final answer
mdg "session" --in src/auth/ --effort deep --max-tokens 16000

# Stash + tag + TTL
mdg "TODO" --in src/auth/ --mp-stash auth-todos "Auth TODOs" \
  --mp-tag auth --mp-tag p0 --mp-ttl 7d

# Compose two stashes, re-search across their union
mdg "error" --mp-compose auth-todos perf-hotspots

# Re-search scoped to one stash's files
mdg "rate.limit" --mp-from auth-todos

# Link stashes into a graph, then traverse it
mdg --mp-link auth-todos perf-hotspots depends-on "shared db layer"
mdg --mp-graph auth-todos 3

# Prune safely
mdg --mp-prune-older-than 7d --mp-prune-dry-run     # preview
mdg --mp-prune-older-than 7d                        # commit

# Use an isolated palace for one task
MDG_MIND_PALACE=./.mdg/task-42.json mdg "TODO" --in src/ --mp-stash t42 "..."

# Programmatic JSON for a harness
mdg "TODO" --in src/ --format json --page 1 --page-size 5
```

### Exit codes

| Code | Meaning |
| ---: | :--- |
| 0 | Matches found (or palace operation succeeded) |
| 1 | No matches (matches ripgrep's convention) |
| 2 | Bad arguments |
| 3 | ripgrep not installed |
| 4 | Mind palace error (unknown stash, etc.) |
| 99 | Unexpected error |

---

## Why

Most context tools are file-centric (`@filename`) or line-centric
(`grep -C N`). For an LLM harness, this is wasteful:

- A 500-line file might be 8,000 tokens, but the LLM only needs 200 tokens
  of context around the actual match.
- `grep -C 50` gives 50 *lines* of context, regardless of how long those
  lines are. One symbol-dense line is 10 tokens; one long paragraph is 80.
- Without a node cap, a single regex can flood the context with thousands
  of hits.

`mdg` fixes this:

| Knob | What it does |
| :--- | :--- |
| `--before N` / `--after N` | Tokens of context around each match |
| `--max-nodes N` | Cap on the number of hits returned |
| `--max-tokens N` | Total token budget across all nodes |
| `--strategy fill\|deep` | How to use the budget (more nodes vs deeper per node) |
| `--effort quick\|normal\|deep\|auto` | Preset that bundles the above |
| `--in`, `--cmd`, `--url`, `--stdin` | Multi-source inputs |
| `--format llm\|markdown\|json\|text` | Output format (default: `llm`) |

The `llm` output format is the default and the point: clear delimiters,
file:line attribution, match highlighting, and a summary footer. Paste
the entire output into an LLM context and it knows exactly where every
snippet came from.

## Install

Requires [Node 20+](https://nodejs.org) and [ripgrep](https://github.com/BurntSushi/ripgrep).

```bash
npm install -g mdg-cli
# or from source:
git clone https://github.com/JadeZaher/mdg.git
cd mdg && npm install && npm run build && npm link
```

For Claude / Gemini / coding agents: load `skills/mdg-context/SKILL.md`
into your system prompt or tool descriptions. It provides a decision tree
for effort levels, mind palace patterns, pagination, and error recovery.

Verify:

```bash
mdg --version
mdg --help
```

## Quickstart

```bash
# Find TODOs in src/, with 500 tokens of context, up to 20 nodes
mdg "TODO" --in src/ --max-nodes 20

# Multiple paths in one flag (greedy, like git add or curl)
mdg "TODO" --in src/ test/ docs/

# Trailing positional paths (rg-style)
mdg "TODO" src/ test/

# Directory: recurses into all files automatically
mdg "TODO" --in src/auth/

# Read path list from a file (one per line, # comments allowed)
mdg "TODO" --in @filelist.txt

# Read path list from stdin
echo -e "src/\ntest/" | mdg "TODO" --in @-

# Comma-separated paths
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
```

The `--in` flag is greedy: it consumes every non-flag argument that
follows it, so `--in src/ test/ docs/` is equivalent to three separate
`--in` flags. To pass a path that starts with `-`, prefix it with `./`
(so `./-weird-name`) or use the `@file` syntax.

## Output format: `llm`

The default. Designed to be both human-readable and directly consumable
by an LLM harness:

```text
<mdg result pattern="TODO" nodes=4 tokens=~566 effort=normal strategy=fill>

--- NODE 1 of 4 | src/auth/login.ts:8 | ~196 tokens ---
  1    import { User } from './types';
  2    import { db } from './db';
  3    import { logger } from '../../utils/logger';
  4
  5    // Authentication flow for the public API.
  6    // Validates the user credentials, then issues a short-lived session token.
  7    export async function login(user: User, password: string) {
  8 >>   // **TODO**: add rate limiting per IP+user to prevent brute force
  9      const valid = await db.users.verifyPassword(user.id, password);
 10      if (!valid) {
 11        logger.warn(`failed login for ${user.id}`);
 12        return null;
 13      }
 14      const session = await db.sessions.create({ userId: user.id });
 15      return session;
 16    }

--- NODE 2 of 4 | src/auth/session.ts:8 | ~166 tokens ---
 ...

--- TOTAL ---
4 nodes | ~566 tokens | 3 sources | 30ms
</mdg result>
```

An LLM can paste the entire `<mdg result>...</mdg result>` block into its
context and immediately know:

- The pattern being searched (`pattern="TODO"`)
- The total cost in tokens (`tokens=~566`)
- The source attribution of every snippet (`src/auth/login.ts:8`)
- The matched substring (highlighted with `>>` and `**bold**`)

## Effort presets

| Preset | before | after | max-nodes | Use when |
| :--- | ---: | ---: | ---: | :--- |
| `quick`  |   200 |   200 |     10 | Initial recon, "is this term in the codebase?" |
| `normal` |   500 |   500 |     30 | Default. Good for most LLM context windows. |
| `deep`   |  2000 |  2000 |    100 | Final-answer grounding, large context windows. |
| `auto`   |   500 |   500 |     30 | Same as `normal` for now; future: heuristic sizing. |

## Token estimation

`mdg` uses a simple `chars/4` heuristic for token estimation. This is
fast and dependency-free, and accurate enough to make *budgeting*
decisions (sizing context windows, capping output). It is not a substitute
for a real tokenizer when billing accuracy matters.

The `tokens` field in JSON output is always approximate and prefixed with
`~` in the `llm` format.

## Path spec syntax

`--in` accepts any of:

The mind palace is the LLM's **addressable short-term memory** for
search results. It works like RAM that the LLM can write to, read from,
and compose across multiple invocations.

The metaphor: while investigating a codebase, the LLM builds up a set of
named "stashes". Each stash holds a search result with a note. Stashes
can be used as inputs to *future* searches (so the LLM can scope a new
search to the files it cared about before) and can be composed together.

### The lifecycle

| Operation | CLI | What it does |
| :--- | :--- | :--- |
| **Instantiate** | `--mp-stash <name> <note>` | Run the current search, save the result under `name` with `note`. |
| **Read** | `--mp-from <name>` | Re-run a search, but only in the files stashed under `name`. |
| **Compose** | `--mp-compose <a> <b> ...` | Re-run a search across the union of multiple stashes' file lists. |
| **Inspect** | `--mp-list [--mp-list-tag t]` | See all stashes, optionally filtered by tag. |
| **Inspect** | `--mp-get <name>` | Show the full contents of one stash. |
| **Free** | `--mp-drop <name>` | Remove a stash from the palace. |

Stashes default to **merge on duplicate name** (dedup by file:line);
pass `--mp-replace` to overwrite. Tag stashes with `--mp-tag <t>`
(repeatable) and filter the list with `--mp-list-tag <t>`.

### Storage

A palace is a JSON file. Default location: `./.mdg/mind-palace.json`
(project-scoped). The LLM can have **multiple isolated palaces** by
pointing `--mp-path <file>` at a different file — one palace per task
or per session. Override at runtime with `MDG_MIND_PALACE=<file>`.

### Example: multi-step investigation

```bash
# 1. The LLM starts by stashing "auth" issues
mdg "TODO" --in src/auth/ --mp-stash auth-issues "Auth TODOs to fix" \
  --mp-tag auth --mp-tag p0

# 2. Then "performance" hotspots from a different search
mdg "performance\|slow\|TODO" --in src/ --effort deep \
  --mp-stash perf-hotspots "Performance concerns" --mp-tag perf

# 3. The LLM wants to find files involved in BOTH: compose them
mdg "TODO" --mp-compose auth-issues perf-hotspots

# 4. The LLM wants to re-search "rate" but only in files that had TODOs
mdg "rate.limit" --mp-from auth-issues

# 5. The LLM is done with auth-issues, frees the slot
mdg --mp-drop auth-issues
```

The mind palace is **persistent** across `mdg` invocations within the
same project (the JSON file lives on disk) but **logical** — a fresh
palace can be created instantly by pointing `--mp-path` elsewhere.

### Pruning & TTL

The palace can grow unbounded. mdg provides several ways to prune:

| Prune operation | CLI flag |
| :--- | :--- |
| By age | `--mp-prune-older-than 7d` — stashes not updated in 7 days |
| By count | `--mp-prune-keep 10` — keep only the 10 most recently updated |
| By tag | `--mp-prune-tag temp` — remove all stashes tagged `temp` |
| All | `--mp-prune-all --mp-prune-confirm` — clear entire palace |
| Expired TTL | Auto-pruned on every `--mp-list` / `--mp-get` |

`--mp-prune-dry-run` shows what WOULD be pruned without deleting.

TTL stashes auto-expire:

```bash
mdg "debug_stmt" --in src/ --mp-stash temp-findings "Temp" \
  --mp-ttl 2h --mp-tag temp
```

Relative timestamps are shown in all listings (`just now`, `3m ago`, `2d ago`).

## Pagination

For finer-grained traversal of large result sets, `mdg` supports
opt-in pagination. The LLM can page through nodes in a search, stashes
in `--mp-list`, or nodes within a stash in `--mp-get`.

```bash
# Page through a large search result
mdg "TODO" --in src/ --page 1 --page-size 5
mdg "TODO" --in src/ --page 2 --page-size 5

# Browse a large mind palace 20 stashes at a time
mdg --mp-list --page 1 --page-size 20

# Browse a stash's nodes 5 at a time
mdg --mp-get auth-issues --page 2 --page-size 5
```

The LLM format annotates the result with pagination metadata:

```text
<mdg result pattern="TODO" nodes=6 tokens=~816 effort=normal
       page=1 of 3 page_size=2 total_items=6>
```

The JSON format includes a `pagination` block:

```json
{
  "nodes": [ ... 2 items ... ],
  "pagination": {
    "page": 1,
    "page_size": 2,
    "total_items": 6,
    "total_pages": 3,
    "has_next": true,
    "has_prev": false
  }
}
```

`--all` disables pagination (returns everything). Pagination is off
by default for backwards compatibility; the LLM harness should pass
`--page 1` in its tool wrapper to enable it.

## Programmatic API

For TS/Node harnesses that prefer to embed `mdg` rather than shell
out, the `mdg` package exports a programmatic API:

```ts
import { search, stash, listStashes, toolDefinition } from "mdg";

const result = await search({
  pattern: "TODO",
  in: ["src/"],
  effort: "quick",
  page: 1,
  pageSize: 5,
});

// Stash the result for later composition.
await stash(result, {
  name: "auth-issues",
  note: "Auth TODOs to review",
  tags: ["auth", "p0"],
});

// Browse stashes.
const all = listStashes();

// Expose to OpenAI / Anthropic function calling:
openai.tools.create({ name: "mdg", ...toolDefinition });
```

The API mirrors the CLI 1:1 — every flag has a corresponding option.

## Path spec syntax

`--in` accepts any of:

| Form | Meaning |
| :--- | :--- |
| `--in path/to/file`     | A single file |
| `--in path/to/dir`      | A directory; recurses into all files |
| `--in '**/*.ts'`        | A glob (single or multiple wildcards) |
| `--in src/ test/ docs/` | Multiple paths in one flag (greedy) |
| `--in src/,test/,docs/` | Comma-separated paths |
| `--in @list.txt`        | Read paths from a file (one per line, `#` comments) |
| `--in @-`               | Read paths from stdin (one per line, `#` comments) |
| `mdg PATTERN path/ ...` | Trailing positionals also act as paths (rg-style) |

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
  index.ts         orchestrator (entry point)
```

`mdg` does not reimplement grep. It shells out to `rg --json` for the
actual search, which is the fastest, most correct regex engine available
and provides structured match data. Everything else — node building,
context sizing, output formatting — is in-process TypeScript.

## Development

```bash
npm run dev     # run with tsx (no build step)
npm run build   # compile to dist/
npm test        # run smoke tests
```

## Exit codes

| Code | Meaning |
| ---: | :--- |
| 0 | Matches found (or palace operation succeeded) |
| 1 | No matches (matches ripgrep's convention) |
| 2 | Bad arguments |
| 3 | ripgrep not installed |
| 4 | Mind palace error (unknown stash, etc.) |
| 99 | Unexpected error |

## License

MIT.
