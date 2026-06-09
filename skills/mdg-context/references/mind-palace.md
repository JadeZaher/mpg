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

Stashes can be linked into a directed graph. The graph is what lets
you **traverse the investigation by intent** instead of by remembering
stash names — `--mp-graph <root> 3` reconstructs an entire thread
topology in one CLI call, which is the lifeline when a conversation
gets compacted away mid-task.

| CLI flag | What it does |
| :--- | :--- |
| `--mp-link <from> <to> <type> [note]` | Create a directed edge. |
| `--mp-unlink <from> <to>` | Remove an edge. |
| `--mp-related <name>` | Show all inbound + outbound neighbors of `name`. |
| `--mp-graph <name> [depth]` | BFS traversal from `name` up to `[depth]` levels (default 3). |

### Edge type conventions

Edge types are unenforced strings, but consistent vocabulary makes the
graph readable later. Common types:

| Type | Meaning |
| :--- | :--- |
| `depends-on` | "Reading B is a prerequisite for reading A." |
| `supersedes` | "A is the current view; B is the old one. Ignore B." |
| `see-also` | "B is a related thread worth surfacing alongside A." |
| `parent-of` / `child-of` | Hierarchical decomposition of one investigation into subtopics. |
| `blocks` | "A can't ship until B is resolved." |
| `contradicts` | "A and B disagree — reconciliation needed." |

Pick a vocabulary at the start of an investigation and stay consistent
within it. Mixing `depends-on` with `requires` for the same concept
makes `--mp-graph` output noisy without adding signal.

### Workflow: tracking a multi-thread investigation

The pattern that pays off: build stashes as you investigate (always
with TTLs + tags), link them the moment you notice a relationship,
then traverse by intent in future sessions.

```bash
# Session 1 — building the topology
mdg "JWT" --in src/auth/   --mp-stash auth-jwt    --mp-tag rewrite --mp-ttl 24h
mdg "JWT" --in docs/spec/  --mp-stash spec-jwt    --mp-tag rewrite --mp-ttl 24h
mdg "JWT" --in src/legacy/ --mp-stash legacy-jwt  --mp-tag rewrite --mp-ttl 24h

mdg --mp-link auth-jwt spec-jwt   see-also   "implementation of the spec"
mdg --mp-link auth-jwt legacy-jwt supersedes "post-rewrite, legacy goes away"

# Session 2 — navigation, no need to remember names
mdg --mp-related auth-jwt   # one-hop neighbors with edge labels
mdg --mp-graph auth-jwt 3   # full BFS, three hops out

# When the conversation gets compacted and you've lost the thread:
mdg --mp-graph <known-root> 3
# → reconstructs the whole investigation topology, with edge types
#   that tell you what's current, what's superseded, what blocks what.
```

### When to link (and when not to)

1. **Only link what you'll traverse.** Edges are cheap to make and
   cheap to store, but a graph nobody walks is just noise on
   `--mp-related`. If you wouldn't run `--mp-graph` later, skip the
   link.
2. **Link when discovery is fresh.** The right moment is when you
   notice the relationship. Three sessions later you won't remember
   why two stashes mattered together.
3. **Don't link across unrelated tasks.** If you maintain one palace
   per task (`MDG_MIND_PALACE=.mdg/<task>.json`), this is automatic —
   cross-task links can't even be expressed.
4. **Relink with confidence — it's atomic.** `--mp-unlink` then
   `--mp-link` is a no-op-loss operation; the diff-based save in
   v0.2.5 ensures both edits land cleanly even under concurrent
   writers.

### Quick examples by use case

| Situation | Linkage |
| :--- | :--- |
| Refactor that obsoletes an old subsystem | `--mp-link new-impl old-impl supersedes "after-rewrite"` |
| Implementation depends on a shared library you've already mapped | `--mp-link feature-x lib-y depends-on "uses Y's session API"` |
| Spec and code drift you need to reconcile | `--mp-link spec-claim impl-reality contradicts "spec says X, code does Y"` |
| Decomposing an epic into discrete threads | `--mp-link epic-payments stripe-webhooks child-of` then `--mp-graph epic-payments 2` to walk the whole epic |
| Cross-referencing parallel tracks (impl + tests + docs) | Three stashes, two `see-also` edges between them |

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
