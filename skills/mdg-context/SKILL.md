# mdg-context — Codebase Context Retrieval Skill

## Description

Retrieve token-budgeted context nodes from files, command output, and URLs.
Use for: codebase exploration, multi-step investigation, finding references,
building composable short-term memory across tool-call turns.

## When to use this skill

| Situation | Tool |
| :--- | :--- |
| "Where is X referenced in the codebase?" | `mdg_search` |
| "I need context around a match, not just the line" | `mdg_search` with `before`/`after` |
| "Is this term present at all? Quick scan." | `mdg_search` with `effort: "quick"` |
| "I need deep context for my final answer" | `mdg_search` with `effort: "deep"` |
| "I'll need these results again later" | `mdg_stash` |
| "Search only in files I previously stashed" | `mdg_search` with `from` or `compose` |
| "Show me what stashes I have" | `mdg_list_stashes` |
| "Don't need this stash anymore" | `mdg_drop_stash` |
| "Just read a single file" | Use `read` tool instead (faster) |
| "Search a URL or command output" | `mdg_search` with `url` or `cmd` |

## Decision tree: what effort level to use

```
Surface scan needed?    → effort: "quick"   (200 token windows, 10 nodes)
Default investigation?  → effort: "normal"  (500 token windows, 30 nodes)
Final answer grounding? → effort: "deep"    (2000 token windows, 100 nodes)
Unknown?                → effort: "auto"    (fallback, same as normal)
```

## Decision tree: how to use the mind palace (short-term memory)

```
BUILD UP memory across turns:
  1. Search & stash: mdg_search → mdg_stash(name, note, tags)
  2. Browse stashes:  mdg_list_stashes → decide what's relevant
  3. Compose stashes: mdg_search(compose: [a, b]) to cross-reference
  4. Re-search scoped: mdg_search(from: name) to re-query within a stash
  5. Free memory:     mdg_drop_stash(name) when a slot is no longer needed

PRUNE stale memory:
  - mdg_prune_older_than("7d") — remove stashes older than 7 days
  - mdg_prune_keep(10) — keep only the 10 most recent
  - mdg_prune_tag("temp") — remove all temp-tagged stashes
  - mdg_prune_dry_run before any destructive prune
  - Use --mp-ttl (e.g. "2h", "30m") when creating ephemeral stashes

GOLDEN RULES:
  - Stash by default. Even if you think you won't need it, stash it.
  - Tag stashes: "auth", "p0", "temp", "perf", "review". This pays off
    when you have 10+ stashes and need to filter or prune.
  - Compose before you conclude.
  - Drop or prune when done. Stashes are persistent on disk.
  - Use --mp-ttl for ephemeral stashes (e.g. "2h", "30m").
  - Prune old stashes regularly: --mp-prune-older-than 7d.
  - Create relationships: --mp-link <a> <b> depends-on "note".
  - Traverse the graph: --mp-graph <name> 3 to see the dependency chain.
  - Always --mp-prune-dry-run before a destructive prune.
  - Use separate palaces per task.
```

## Pagination pattern

```
Start:  mdg_search(pattern, page: 1, pageSize: 5)
Check:  result.pagination.has_next
If has_next:  mdg_search(pattern, page: 2, pageSize: 5)
...
Stop when has_next is false or you have enough context.

The same pattern works for mdg_list_stashes and mdg_get_stash.
```

## Error recovery hints

| Exit code / condition | What to do |
| :--- | :--- |
| `status: "no_matches"` | No hits. Try broader pattern, remove `-w`, add `-I` for case-insensitive. |
| `status: "truncated"` | Hit --max-tokens budget. Narrow the search (more specific pattern) OR increase max_tokens and re-run. |
| `status: "error"` | Check stderr for details. Common: unknown stash name (run --mp-list), rg not installed, bad regex. |
| `pagination.has_next === true` | There's more data. Decide if you need to page, or if the current page is sufficient. |
| No matches on `--mp-from` | The stash's files may have changed. Re-stash with a fresh search. |
| Unknown stash error | Run `mdg_list_stashes` to see what's available. |

## Integration with other Pi skills

- **extension-orchestrator (Pi-Horizon)**: mdg is a Grounding tool. Use it in
  the Grounding phase to understand the codebase before planning.
- **conductor-context**: If a conductor/ directory exists, use mdg to find
  references to task IDs, track names, or phase names across the codebase.
- **deep-research**: After fetching a URL, use mdg to search the fetched content.
- **batch-task-master**: Use mdg to find all instances of a pattern before
  running a mass refactoring.
- **subagent (scout)**: mdg complements the scout agent. Scout does unstructured
  exploration; mdg does structured, token-budgeted retrieval.

## Capabilities exposed as MCP tools / function calls

### mdg_search
```
Search files, command output, or URLs for a regex pattern.
Returns token-budgeted context nodes with file:line attribution.
Query params: pattern (required), in (paths[]), cmd, url,
  before, after, max_nodes, max_tokens, effort, strategy,
  from (stash name), compose (stash names[]), page, page_size, all
```

### mdg_stash
```
Save a search result to the mind palace under a named slot.
Stashes are addressable: other searches can use them as input
via mdg_search(from: name) or mdg_search(compose: [a, b]).
Query params: name (required), note, tags[], replace
```

### mdg_list_stashes
```
List all stashes in the mind palace. Optionally filter by tag.
Query params: tag_filter[], page, page_size
Returns: array of { name, note, tags, pattern, effort, nodes_count, sources_count, updated_at }
```

### mdg_get_stash
```
Show the full contents of one stash.
Query params: name (required), page, page_size
Returns: { name, note, tags, nodes[], sources[], created_at, updated_at }
```

### mdg_drop_stash
```
Remove a stash from the mind palace.
Query params: name (required)
```

## Anti-patterns: what NOT to do

- **Don't use deep effort for a quick scan.** Quick is 1/10th the cost.
- **Don't stash and then immediately drop.** Stashes are cheap storage.
- **Don't search for the same pattern twice without stashing.** Stash it the first time.
- **Don't use mdg to read a single file.** Use the `read` tool. mdg is for searching.
- **Don't forget to pass `page: 1` to paginate.** Without it, you get everything at once.
- **Don't use comma-separated stash names in compose without quoting.**
- **Don't create stashes with names that collide with flags.** Avoid names
  that look like `--help`, `-v`, etc. (mdg handles these but the LLM
  shouldn't create confusion.)

## Quick reference: effort presets

| effort | before | after | max_nodes | use case |
| :--- | ---: | ---: | ---: | :--- |
| quick  |   200 |   200 |     10 | Initial recon, "is this term in the codebase?" |
| normal |   500 |   500 |     30 | Default investigation |
| deep   |  2000 |  2000 |    100 | Final-answer grounding |
| auto   |   500 |   500 |     30 | Fallback |
