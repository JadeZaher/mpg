# Anti-patterns

What NOT to do with mdg, and why.

## Search

**Don't use `deep` effort for a quick scan.**
`quick` is 1/10th the cost. Reserve `deep` (2000-token windows, 100
nodes) for the final answer-grounding pass, not initial recon.

**Don't search the same pattern twice without stashing.**
If you'll need a pattern more than once, `mdg_stash` it the first
time. Stash storage is cheap; re-running a search is not.

**Don't use mdg to read a single file.**
The host's `read` tool is faster and clearer. mdg is for *searching*
across multiple files, not retrieving one.

**Don't forget `page: 1` when paginating.**
Without an explicit page, mdg returns everything (up to `max_nodes`).
For results expected to exceed 10 hits, pass `page: 1, page_size: 5`
so you can decide whether to keep going.

**Don't omit `--in` for non-trivial searches.**
With no source, mdg reads stdin or errors out. Always be explicit
about where you're searching.

## Mind palace

**Don't stash and immediately drop.**
If you knew you weren't going to need it, you shouldn't have stashed.
The cost is the stash decision, not the storage.

**Don't reuse stash names across unrelated investigations.**
A new investigation = a new task = a new palace (`--mp-path` /
`MDG_MIND_PALACE`) OR a name-prefixed stash. Reusing names silently
overwrites or merges, which surprises the model later.

**Don't use comma-separated stash names in `compose` without quoting.**
The shell may split them. Prefer space-separated:
`--mp-compose auth-todos perf-hotspots`.

**Don't create stashes with names that look like flags.**
Avoid names like `--help`, `-v`, etc. mdg handles these but the LLM
should not have to disambiguate.

**Don't skip `--mp-prune-dry-run`.**
Always preview a prune before committing. Stash mistakes are
permanent — the JSON is overwritten in place.

**Don't share a high-write palace across concurrent agents.**
mdg has no file locking; concurrent writes race and lose data. See
`multi-agent.md` for safer layouts.

**Don't stash without tags.**
At >10 stashes, untagged ones become impossible to filter or prune.
Tag every stash with at least one topic word.

**Don't forget TTL on transient findings.**
Use `--mp-ttl 2h` (or similar) on scratch / exploratory stashes so
they auto-reap. Manual pruning at agent shutdown is fine too, but TTL
is the cheaper default.

**Don't build dense relationship graphs you won't traverse.**
Edges are cheap, but a graph nobody walks is noise. Only `--mp-link`
when you actually plan to `--mp-related` or `--mp-graph` later.

## Sources

**Don't pipe gigabyte files to `--cmd` or `--stdin`.**
mdg buffers in memory (64 MB cap for `--cmd`). For huge corpora, use
`--in` with file paths so ripgrep streams.

**Don't `--url` against SPA-rendered pages.**
mdg fetches raw HTML — no JS execution. SPAs return empty shells.
Use a real HTTP client + render step upstream if you need it.

**Don't combine `--cmd` and `--stdin` for the same content.**
Pick one. Combining them is legal but confusing — they coexist for
**different** content sources, not the same one.

## Output format

**Don't parse `llm` format programmatically.**
It's designed for the model to read. For machine consumption use
`--format json`.

**Don't strip the `<mdg result ...>` wrapper before showing the
result to the model.**
The header carries the pattern, effort, status, pagination state, and
token budget — load-bearing for the model's reasoning. Keep it.

## Integration

**Don't register the MCP server at project scope when you want it
everywhere.**
Use `--scope user` so it's available across all projects:
`claude mcp add --scope user mdg -- node <path>`.

**Don't shell out from inside an MCP host for the five core tools.**
That's what the MCP server exists for. Shell-out only for the wider
mind-palace surface (relationships, prune, intersect, except) that
isn't exposed via MCP yet.
