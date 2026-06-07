# Mind Palace — full surface

The palace is a JSON file (default `./.mdg/mind-palace.json`) holding
named **stashes** of search results. Stashes are addressable: future
searches can use them as inputs, compose them, intersect them, link
them into a graph, and prune them by age/tag/count.

## Lifecycle

```
SEARCH   →   STASH    →   COMPOSE / FROM / INTERSECT / EXCEPT
              ↓
            LIST  ←  TAG, FILTER, PAGINATE
              ↓
            LINK  →  RELATED  →  GRAPH (traverse)
              ↓
            PRUNE (by age / count / tag / TTL / all)  →  DROP
```

## Stash operations

| CLI flag | What it does |
| :--- | :--- |
| `--mp-stash <name> <note>` | Save current search's results. Merges into existing (dedup by file:line) unless `--mp-replace`. |
| `--mp-stash-note <note>` | Set note separately from the stash flag. |
| `--mp-stash-tag <tag>` / `--mp-tag <tag>` | Tag the stash (repeatable). |
| `--mp-replace` | Overwrite an existing stash outright. |
| `--mp-ttl <duration>` | Auto-expiry (`30m`, `2h`, `7d`). Expired stashes are reaped on next `--mp-list` / `--mp-get`. |
| `--mp-stash-locations` | Save only file:line pointers (no context text). Use for lean stashes when you'll re-search later. |

## Recall operations

| CLI flag | What it does |
| :--- | :--- |
| `--mp-list` | List all stashes with relative timestamps (`3m ago`, `2d ago`). |
| `--mp-list-tag <tag>` | Filter list by tag (repeatable). |
| `--mp-get <name>` | Show full contents of one stash. |
| `--mp-drop <name>` | Remove a stash. |

## Set operations over file lists

These all run a **fresh search**, scoped to a derived file list.

| Operation | CLI | Files searched |
| :--- | :--- | :--- |
| **Scope** | `--mp-from <name>` | Files in the named stash |
| **Union** | `--mp-compose <a> <b> ...` | Files in **any** of the named stashes |
| **Intersection** | `--mp-intersect <a> <b> ...` | Files in **all** of the named stashes |
| **Difference** | `--mp-except <a>` or `--mp-except <a> <b> ...` | Files **not** in the named stash(es) |

Examples:

```bash
# Re-search a single stash's files
mdg "rate.limit" --mp-from auth-todos

# Files mentioned in any of two stashes
mdg "TODO" --mp-compose auth-todos perf-hotspots

# Files mentioned in BOTH stashes
mdg "TODO" --mp-intersect auth-todos perf-hotspots

# Files in auth-todos but NOT in deprecated
mdg "TODO" --mp-except deprecated
```

The MCP tools today expose `from` and `compose` only — drop to CLI for
`intersect` and `except`.

## Relationships (the graph in markdowngraphcli)

Stashes can be linked into a directed graph. Useful for tracking
dependency, supersession, or cross-references between investigation
threads.

| CLI flag | What it does |
| :--- | :--- |
| `--mp-link <from> <to> <type> [note]` | Create a directed edge. |
| `--mp-unlink <from> <to>` | Remove an edge. |
| `--mp-related <name>` | Show all inbound + outbound neighbors of `name`. |
| `--mp-graph <name> [depth]` | Traversal from `name` up to `[depth]` levels (default 3). |

Edge types are conventional but not enforced: `depends-on`,
`related-to`, `see-also`, `parent-of`, `child-of`, `supersedes`, or
any custom string.

```bash
mdg --mp-link auth-todos perf-hotspots depends-on "shared db layer"
mdg --mp-graph auth-todos 3
```

## Pruning

A palace grows unbounded unless pruned. Always preview first.

| CLI flag | Effect |
| :--- | :--- |
| `--mp-prune-older-than <dur>` | Stashes not updated within duration. |
| `--mp-prune-keep <n>` | Keep only the N most recently updated. |
| `--mp-prune-tag <tag>` | All stashes carrying the tag. |
| `--mp-prune-expired` | All TTL-expired stashes. |
| `--mp-prune-all` | Entire palace. Requires `--mp-prune-confirm`. |
| `--mp-prune-dry-run` | Preview only — do not delete. **Use this first.** |

```bash
mdg --mp-prune-older-than 7d --mp-prune-dry-run    # preview
mdg --mp-prune-older-than 7d                       # commit
```

TTL-tagged stashes are *also* auto-reaped on every `--mp-list` or
`--mp-get` — no explicit prune required for the TTL case.

## Multi-palace isolation

Use a separate palace per task to avoid context bleed.

```bash
# Explicit per-invocation:
mdg "TODO" --in src/ --mp-stash t42 "..." --mp-path .mdg/task-42.json

# Or via env, so all subsequent calls use the same palace:
export MDG_MIND_PALACE=.mdg/task-42.json
mdg "TODO" --in src/ --mp-stash t42 "..."
mdg --mp-list
```

The default `./.mdg/mind-palace.json` is searched walking up from CWD
(like `.gitignore`), so monorepo subdirs share a project palace by
default.

## Storage format

Each stash holds:

```jsonc
{
  "name": "auth-todos",
  "note": "Auth TODOs to review",
  "tags": ["auth", "p0"],
  "pattern": "TODO",
  "effort": "quick",
  "nodes": [ /* file:line + context */ ],
  "sources": [ /* canonical file paths */ ],
  "created_at": "2025-...",
  "updated_at": "2025-...",
  "expires_at": "2025-..." // if --mp-ttl was set
}
```

Plus a top-level `relationships: [{from, to, type, note, created_at}]`
array for edges.

The file is plain JSON — safe to inspect, version-control, or hand-edit
for one-off corrections.
