# Multi-agent palace patterns

The mind palace is a single JSON file. Multiple processes / agents
sharing it coordinate via a per-palace `.lock` file plus an atomic
write path (tmp file + rename + on-disk re-read-and-merge under the
lock). The race conditions that earlier versions had — silently lost
stashes when two agents stashed in the same second — no longer apply.

You still pick a layout based on **what kind of context you want
agents to share**, not based on data-loss risk.

## Recommended layouts

### Layout A: per-agent isolated palaces

Each agent gets its own palace file. Use when agents are pursuing
genuinely independent investigations and you don't want context bleed
between them.

```bash
# Agent A
MPG_MIND_PALACE=.mpg/agent-a.json mpg "TODO" --in src/ --mp-stash mine "..."

# Agent B
MPG_MIND_PALACE=.mpg/agent-b.json mpg "TODO" --in src/ --mp-stash mine "..."
```

Pros: zero lock contention, easy to garbage-collect (just `rm` the
file when the agent finishes), one task = one palace = one mental model.
Cons: agents can't see each other's findings — you have to manually
copy or merge if context-sharing turns out to matter.

### Layout B: shared read-only palace + per-agent scratch

One canonical palace, populated by a coordinator agent. Worker agents
**read** from it (`--mp-from`, `--mp-compose`, `--mp-list`,
`--mp-get`) but write to their own scratch palaces.

```bash
# Coordinator stashes the project's key contexts:
MPG_MIND_PALACE=.mpg/shared.json mpg "TODO" --in src/auth/ \
  --mp-stash auth-overview "Auth subsystem"

# Workers read from shared, write to their own scratch:
MPG_MIND_PALACE=.mpg/worker-1.json \
  mpg "rate.limit" --mp-from auth-overview --mp-stash w1-findings "..."
```

Pros: shared context with a clear authorship model — coordinator
owns the canonical map, workers own their own findings.
Cons: workers can't contribute back to the shared palace without an
explicit merge step.

### Layout C: shared read-write palace

All agents share one palace. As of v0.2.4 this is safe under
concurrent writes: each save acquires a `.lock` file, re-reads the
on-disk palace under the lock, merges any stashes the other writer
added, then renames atomically into place.

```bash
# All agents
export MPG_MIND_PALACE=.mpg/team.json
```

Pros: maximum visibility — everyone sees everyone's findings as
soon as they're written.
Cons: lock contention if many agents stash in a tight loop. For
extreme write loads (autopilot/swarm patterns with hundreds of
near-simultaneous stashes), still prefer Layout A or B — the lock
will serialize you, and serialization at high write rates means
the slowest agent's stash latency becomes everyone's stash latency.

## Concurrency model (what the lock actually does)

mpg's write path is:

1. Acquire `<palace>.lock` (sibling file, `O_EXCL`). Backs off with
   jitter for up to 2s; force-breaks a stale lock older than 30s.
2. Read the on-disk palace JSON (the version *some other process*
   may have written since we last loaded).
3. Merge stashes the on-disk version has that our in-memory copy
   doesn't (last-write-wins on collision by stash name).
4. Write to `<palace>.tmp.<pid>.<rand>` then atomically rename onto
   the real path.
5. Release the lock.

Consequence for agent design:

- **Two agents stashing different stash names in parallel: both land.**
  The merge step in (3) ensures it.
- **Two agents stashing the same name in parallel: last writer wins
  for that stash.** This is intentional — `mpg_stash` with `replace`
  semantics is supposed to overwrite. If you want a merge of two
  parallel updates to the same stash, model them as two different
  names and compose them later.
- **A crashed agent that died mid-write leaves a stale lock.** Other
  agents will detect this (mtime > 30s) and break it. No manual
  cleanup needed unless something is very wrong (in which case
  `rm <palace>.lock`).
- **A corrupted palace file is preserved, not overwritten.** mpg
  copies it aside as `<palace>.corrupt.<timestamp>` and **refuses
  to save** for the rest of that process unless `MPG_FORCE_RESET=1`
  is set. Inspect the backup before forcing.

The palace file is still plain JSON. If you suspect divergence between
two agents' worldviews, diff the file directly — there's no opaque
binary state.

## Naming conventions for shared palaces

When multiple agents share a palace, name stashes with a prefix to
avoid collisions and make ownership obvious:

```
<agent-id>-<topic>           e.g. coordinator-auth, worker1-perf
<task-id>-<topic>            e.g. t42-auth, t42-perf
<phase>-<topic>              e.g. grounding-auth, planning-auth
```

Tag with the agent or task ID too:

```bash
mpg "TODO" --in src/ --mp-stash w1-auth "Worker 1 auth findings" \
  --mp-tag worker1 --mp-tag task-42
```

That makes `--mp-list-tag worker1` or `--mp-prune-tag worker1` work
cleanly when a worker is done.

## Lifecycle hygiene

- **Use TTL on transient findings**: `--mp-ttl 2h` on a worker's
  exploratory stashes so the palace self-cleans.
- **Prune by tag on agent shutdown**: when a worker finishes, run
  `mpg --mp-prune-tag <worker-id>` to drop its scratch.
- **Snapshot before destructive ops**: `cp .mpg/shared.json .mpg/shared.bak`
  before any `--mp-prune-*`.

## Anti-patterns

- **Multiple concurrent writers to one palace with high frequency.**
  Will lose stashes. Use Layout A or serialize writes.
- **Sharing a palace across unrelated tasks.** Context bleed makes
  stashes harder to find and prune. One palace per task.
- **Stashing tool outputs with no TTL in a long-running agent.**
  The palace grows unbounded.
