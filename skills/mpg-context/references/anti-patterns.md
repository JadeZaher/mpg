# Anti-patterns

What NOT to do with mpg, and why.

## Search

**Don't use `deep` effort for a quick scan.**
`quick` is 1/10th the cost. Reserve `deep` (2000-token windows, 100
nodes) for the final answer-grounding pass, not initial recon.

**Don't search the same pattern twice without stashing.**
If you'll need a pattern more than once, `mpg_stash` it the first
time. Stash storage is cheap; re-running a search is not.

**Don't use mpg to read a single file.**
The host's `read` tool is faster and clearer. mpg is for *searching*
across multiple files, not retrieving one.

**Don't forget `page: 1` when paginating.**
Without an explicit page, mpg returns everything (up to `max_nodes`).
For results expected to exceed 10 hits, pass `page: 1, page_size: 5`
so you can decide whether to keep going.

**Don't omit `--in` for non-trivial searches.**
With no source, mpg reads stdin or errors out. Always be explicit
about where you're searching.

## Mind palace

**Don't stash and immediately drop.**
If you knew you weren't going to need it, you shouldn't have stashed.
The cost is the stash decision, not the storage.

**Don't reuse stash names across unrelated investigations.**
A new investigation = a new task = a new palace (`--mp-path` /
`MPG_MIND_PALACE`) OR a name-prefixed stash. Reusing names silently
overwrites or merges, which surprises the model later.

**Don't use comma-separated stash names in `compose` without quoting.**
The shell may split them. Prefer space-separated:
`--mp-compose auth-todos perf-hotspots`.

**Don't create stashes with names that look like flags.**
Avoid names like `--help`, `-v`, etc. mpg handles these but the LLM
should not have to disambiguate.

**Don't skip `--mp-prune-dry-run`.**
Always preview a prune before committing. Stash mistakes are
permanent — the JSON is overwritten in place.

**Don't pound a shared palace with hundreds of near-simultaneous writes.**
v0.2.4 added a `.lock` + atomic-rename write path, so concurrent
writers no longer lose data — but they *do* serialize. A swarm of
agents stashing in tight loops over one palace turns into a
single-writer queue. For high-write fan-out, give each agent its own
palace (Layout A in `multi-agent.md`) and compose at the end.

**Don't ignore a "WARNING — mind palace is corrupt" stderr line.**
When mpg encounters an unparseable palace it copies the file aside as
`<palace>.corrupt.<timestamp>`, taints the in-memory copy, and
**refuses to save** for the rest of that process. If you press on
without inspecting the backup, the next process will start from a
real empty palace once `MPG_FORCE_RESET=1` is set — you'll lose every
stash that wasn't already on disk in a parseable state. Read the
backup file first; recover by hand-merging or by deleting the
corrupt original.

**Don't ignore `result.errors[]`.**
When some sources error and others succeed, `status` is `"partial"`
and the per-source failures land in `errors: [{source, message}]`.
Treating a partial result as a clean "no matches" leads the agent
into wrong conclusions about the corpus. Always check the array;
if it's non-empty, decide explicitly whether to retry, fall back,
or surface the failure.

**Don't stash without tags.**
At >10 stashes, untagged ones become impossible to filter or prune.
Tag every stash with at least one topic word.

**Don't forget TTL on transient findings.**
Use `--mp-ttl 2h` (or similar) on scratch / exploratory stashes so
they auto-reap. Manual pruning at agent shutdown is fine too, but TTL
is the cheaper default. Combined with `--mp-prune-expired` at the
start of a session, this is how a long-running palace stays small
without manual gardening.

**Don't let the palace grow unbounded across a long-context task.**
Stash count creep is the silent killer of multi-hour agent loops:
`--mp-from` over a 200-stash palace gets noisy fast. Set a budget
(say 20–30 active stashes) and run `--mp-prune-keep 30` or
`--mp-prune-older-than 6h` every few major turns. Always
`--mp-prune-dry-run` first.

**Don't build dense relationship graphs you won't traverse.**
Edges are cheap, but a graph nobody walks is noise. Only `--mp-link`
when you actually plan to `--mp-related` or `--mp-graph` later.

## Sources

**Don't pipe gigabyte files to `--cmd` or `--stdin`.**
mpg buffers in memory (64 MB cap for `--cmd`). For huge corpora, use
`--in` with file paths so ripgrep streams.

**Don't `--url` against SPA-rendered pages.**
mpg fetches raw HTML — no JS execution. SPAs return empty shells.
Use a real HTTP client + render step upstream if you need it.

**Don't combine `--cmd` and `--stdin` for the same content.**
Pick one. Combining them is legal but confusing — they coexist for
**different** content sources, not the same one.

## Output format

**Don't parse `llm` format programmatically.**
It's designed for the model to read. For machine consumption use
`--format json`.

**Don't strip the `<mpg result ...>` wrapper before showing the
result to the model.**
The header carries the pattern, effort, status, pagination state, and
token budget — load-bearing for the model's reasoning. Keep it.

## Integration

**Don't register the MCP server at project scope when you want it
everywhere.**
Use `--scope user` so it's available across all projects:
`claude mcp add --scope user mpg -- node <path>`.

**Don't shell out from inside an MCP host for the five core tools.**
That's what the MCP server exists for. Shell-out only for the wider
mind-palace surface (relationships, prune, intersect, except) that
isn't exposed via MCP yet.
