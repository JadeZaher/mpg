# Multi-agent palace patterns

The mind palace is a single JSON file. Multiple processes / agents
sharing it have to coordinate, because mdg reads-modifies-writes the
whole file on every mutation.

## Recommended layouts

### Layout A: per-agent isolated palaces (safest)

Each agent gets its own palace file. No coordination needed.

```bash
# Agent A
MDG_MIND_PALACE=.mdg/agent-a.json mdg "TODO" --in src/ --mp-stash mine "..."

# Agent B
MDG_MIND_PALACE=.mdg/agent-b.json mdg "TODO" --in src/ --mp-stash mine "..."
```

Pros: zero races, clean shutdown, easy to garbage-collect.
Cons: agents can't see each other's findings.

### Layout B: shared read-only palace + per-agent scratch (recommended)

One canonical palace, populated by a coordinator agent. Worker agents
**read** from it (`--mp-from`, `--mp-compose`, `--mp-list`,
`--mp-get`) but write to their own scratch palaces.

```bash
# Coordinator stashes the project's key contexts:
MDG_MIND_PALACE=.mdg/shared.json mdg "TODO" --in src/auth/ \
  --mp-stash auth-overview "Auth subsystem"

# Workers read from shared, write to their own scratch:
MDG_MIND_PALACE=.mdg/worker-1.json \
  mdg "rate.limit" --mp-from auth-overview --mp-stash w1-findings "..."
```

Pros: shared context, no write races.
Cons: workers need to be careful not to mutate the shared palace.

### Layout C: shared read-write palace (use with care)

All agents share one palace. Works fine when mutations are infrequent
and serialized externally (e.g. one agent at a time, or a queue).

```bash
# All agents
export MDG_MIND_PALACE=.mdg/team.json
```

Pros: maximum visibility — everyone sees everything.
Cons: concurrent writes race. mdg does not lock the file; the last
writer wins and can clobber a parallel mutation.

## Race conditions

mdg's write path is roughly:

1. Read palace JSON from disk.
2. Apply mutation in memory.
3. Write whole palace back.

Two concurrent writers each do (1)→(2)→(3); the second's write
overwrites the first's mutation. Symptoms: silently lost stashes,
disappearing relationships.

Mitigations:

- **Run agents sequentially** when they write to the same palace.
- **Layout A or B** if agents must run concurrently.
- **Avoid the shared palace for high-write loops** (autopilot/swarm
  patterns with many concurrent stashes).
- The palace file is plain JSON — if you suspect divergence, diff
  the file between agent runs to confirm.

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
mdg "TODO" --in src/ --mp-stash w1-auth "Worker 1 auth findings" \
  --mp-tag worker1 --mp-tag task-42
```

That makes `--mp-list-tag worker1` or `--mp-prune-tag worker1` work
cleanly when a worker is done.

## Lifecycle hygiene

- **Use TTL on transient findings**: `--mp-ttl 2h` on a worker's
  exploratory stashes so the palace self-cleans.
- **Prune by tag on agent shutdown**: when a worker finishes, run
  `mdg --mp-prune-tag <worker-id>` to drop its scratch.
- **Snapshot before destructive ops**: `cp .mdg/shared.json .mdg/shared.bak`
  before any `--mp-prune-*`.

## Anti-patterns

- **Multiple concurrent writers to one palace with high frequency.**
  Will lose stashes. Use Layout A or serialize writes.
- **Sharing a palace across unrelated tasks.** Context bleed makes
  stashes harder to find and prune. One palace per task.
- **Stashing tool outputs with no TTL in a long-running agent.**
  The palace grows unbounded.
