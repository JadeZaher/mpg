# Sources — what mpg can search

mpg can search **four** kinds of sources. Pick the right one for the
question.

| Source | Flag | Use when |
| :--- | :--- | :--- |
| Files / dirs / globs | `--in <path>` | Codebase exploration (most common) |
| Command stdout | `--cmd "<command>"` | Searching `git log`, `npm ls`, build output, etc. |
| URL body | `--url <url>` | Searching docs pages, API responses |
| Stdin | `--stdin` (auto when piped) | Ad-hoc pipelines |

## `--in` path syntax

`--in` is greedy and accepts every form below:

| Form | Meaning |
| :--- | :--- |
| `--in path/to/file` | A single file. |
| `--in path/to/dir` | A directory — recurses into all files. |
| `--in '**/*.ts'` | A glob. Quote it so the shell doesn't expand first. |
| `--in src/ test/ docs/` | Multiple paths in one flag. |
| `--in src/,test/,docs/` | Comma-separated list. |
| `--in @list.txt` | Read paths from a file (one per line, `#` comments allowed). |
| `--in @-` | Read paths from stdin (one per line). |
| `mpg PATTERN path/ ...` | Trailing positionals also work (rg-style). |

To pass a path that starts with `-`, prefix it with `./` (so
`./-weird-name`) or use the `@file` syntax.

## File filtering

Layered on top of `--in`:

| Flag | What it does |
| :--- | :--- |
| `--include <glob>` | Only files matching glob (repeatable). |
| `--exclude <glob>` | Skip files matching glob (repeatable). |
| `--type <lang>` | ripgrep file-type filter: `ts`, `rust`, `py`, `go`, etc. |
| `--hidden` | Include dotfiles and `.dotdirs`. |
| `--no-ignore` | Don't respect `.gitignore`. |

```bash
# All TS files except tests
mpg "TODO" --in src/ --type ts --exclude '*.test.ts'

# Include hidden + ignored files
mpg "API_KEY" --in . --hidden --no-ignore
```

## `--cmd` — search command stdout

Captures the stdout of a shell command and searches it. Stderr is
discarded.

```bash
# Find error lines in the last 100 commits
mpg "error|fix|bug" --cmd "git log --oneline -100"

# Look for deprecation warnings in build output
mpg "deprecated" --cmd "npm run build"

# Combine with stash
mpg "TODO" --cmd "git log --pretty=%B -200" \
  --mp-stash recent-todos "TODOs from recent commit messages"
```

Caveats:
- The command is split on whitespace — no shell features (pipes,
  redirects) inline. If you need them, wrap in `bash -c "..."`.
- Output is buffered in memory (cap: 64 MB).
- Sources resolve as `cmd:<command>` in node attribution.

## `--url` — search HTTP body

GETs a URL and searches the response body as text.

```bash
# Search a public docs page
mpg "rate.limit" -u https://api.example.com/docs

# Combine with --format json to feed back into a research agent
mpg "deprecated" -u https://example.com/changelog --format json
```

Caveats:
- Follows redirects.
- Sends `User-Agent: mpg/0.1`.
- The full body is downloaded — don't point at gigabyte assets.
- No JS execution; SPA-rendered pages won't have their dynamic content.

## `--stdin` — pipe content in

Auto-detected when stdin is not a TTY. Useful for ad-hoc pipelines.

```bash
cat README.md | mpg "install"

curl -s https://api.example.com/feed | mpg "ERROR" --effort deep

kubectl logs my-pod | mpg "panic|fatal" --effort quick
```

Caveats:
- Stdin is read once and cached (so both content-from-stdin and path
  list `--in @-` can coexist in one invocation).
- Sources resolve as `stdin:` in node attribution.

## Combining sources

`--in`, `--cmd`, `--url`, `--stdin` can all coexist in a single
invocation. Each becomes a separate source in the result.

```bash
# Search the codebase, git log, AND a docs URL in one shot
mpg "deprecated" \
  --in src/ \
  --cmd "git log --oneline -200" \
  -u https://example.com/changelog
```
