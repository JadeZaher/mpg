# Changelog

## 0.2.5

Perf pass driven by a benchmark that revealed `mdg "import" --in .
--effort scan` was timing out at 30s. Also fixes three field-reported
correctness bugs from in-the-wild use, including a data-loss-shaped
`--mp-drop` issue that resurrected dropped stashes whenever a
follow-up writer touched the palace.

### Perf

| workload | v0.2.4 | v0.2.5 | speedup |
| :--- | ---: | ---: | ---: |
| `--ls` / noop | 58 ms | 61 ms | — |
| single file | 74 ms | 78 ms | — |
| `--in src/` (15 files) | 85 ms | 81 ms | 1.05× |
| repo root (mixed) | 616 ms | 83 ms | **7×** |
| repo root, `effort: scan` | **30 s (timeout)** | 89 ms | **>300×** |

(`bench/perf/run.ts`, 5-run median per workload. Baselines pinned in
`bench/results/perf-baseline-v0.2.4.json` and `perf-v0.2.5.json`.)

The cause: every path spec was pre-expanded to a flat list of files in
Node, then each file got its own `rg` subprocess. On a directory with
hundreds of files (`.` in a real repo) that meant hundreds of process
spawns, bypassing rg's own parallel ignore-aware directory walk. The
fix routes dirs and untyped specs straight to rg as path args and lets
rg do what it does best. Explicit file paths still go through the
per-file path so the per-file content cache stays hot.

### Bug fixes

- **`--mp-drop` was a silent no-op when a follow-up writer touched the
  palace.** v0.2.4's read-merge-write logic merged on-disk stashes
  back into the in-memory copy whenever they were "missing" — but a
  dropped stash is, by definition, missing in memory. The result: drop
  reported success, but the next save (from any other writer) would
  resurrect the dropped entry from disk. Replaced with a snapshot-based
  diff: `loadPalace` records the loaded state, `savePalace` computes
  the diff this process made (added X / modified Y / removed Z) and
  replays it on top of whatever's actually on disk at save time. The
  diff includes explicit drops, so they stay dropped.
- **`--json` now works as an alias for `--format json`.** Matches the
  ecosystem convention (`rg --json`, `gh --json`, `jq --json`).
- **`--mp-prune-expired` is now wired through.** The flag was
  documented in `--help` but never parsed in v0.2.4 — calling it
  returned `Unknown argument`. Now does what the help text said it did.

### Internals

- `seenLines` per-source dedup is now always-on (was only enabled
  when auto-tune fired). Two TODOs on one line — rg's submatch
  emission — no longer become two separate nodes with identical
  `(source.id, match_line)`.
- New `bench/perf` harness for measuring CLI wall-clock on
  representative workloads. Run with `npm run bench:perf`.
- 5 new regression tests in `test/smoke.ts` cover the `--mp-drop`
  fix, the parallel-writer scenario, `--json`, and `--mp-prune-expired`.

### Compatibility

No breaking changes. The on-disk palace format is unchanged. The
diff-based save reads palaces written by 0.2.4 and earlier as-is.

## 0.2.4

Robustness pass driven by an external code review focused on
agent-harness failure modes (silent garbage stashes, cascading
parallel-call cancellation, memory blowups on pathological input).
All 10 HIGH findings landed in one bundle.

### Bug fixes

- **Alternation patterns over files with multi-megabyte single lines
  no longer crash or silently corrupt stashes.** ripgrep is now
  invoked with `--max-columns 1000000 --max-columns-preview`, the
  per-line stdout buffer is hard-capped at 16 MB (rg is killed and
  a clear `RgError` is thrown if exceeded), and per-match
  `text` is clipped at 16 KB with a `…[clipped]` marker before being
  pushed downstream. Verified by a 2 MB single-line repro that
  previously hung or OOM'd — now completes in tens of ms.
- **Concurrent `--mp-stash` calls no longer clobber each other.**
  `savePalace` now goes through a tmp-file + atomic rename guarded
  by a sibling `<palace>.lock` file. Under the lock it re-reads the
  on-disk palace and merges any stashes the parallel writer added.
  Stale locks older than 30 s are force-broken.
- **Corrupt palace files are preserved instead of silently overwritten.**
  `loadPalace` copies the bad file aside as
  `<palace>.corrupt.<timestamp>`, taints the in-memory copy, emits a
  loud stderr warning, and refuses to save unless `MDG_FORCE_RESET=1`
  is set.
- **`file_paths` on a stash now uses the `Source.type` discriminator
  instead of a Windows-path heuristic.** The old `s.includes(":")`
  check misclassified `cmd:...` and `https://...` as file paths and
  silently dropped them when `--mp-from` re-resolved the stash.
- **`captureCommand` now goes through `bash -c` (or `cmd /c` on
  Windows)** so quoted command args parse correctly. Runs async via
  `spawn`, capped at 64 MB stdout, 60 s timeout. Old whitespace-split
  + `execFileSync` path is gone.
- **`captureUrl` enforces a 30 s timeout, 16 MB cap (pre-checked
  via `content-length`, enforced via streaming), and a content-type
  guard** that rejects non-text MIMEs.
- **Per-source content cache.** `search()` (api.ts and index.ts) now
  reads each file at most once per scan instead of once per matching
  line. A 1000-match file no longer reads from disk 1000 times.
- **`sampleMedianLineLength` bounded.** Was up to 30 MB sync read
  per search; now capped at 64 KB per file and 256 KB total via
  `openSync`/`readSync`, with NUL-byte binary detection to skip
  accidentally-included binary files.
- **`--ls` (`rg --files`)** streams directly to stdout via `spawn`
  instead of buffering through `execFileSync` with a 64 MB cap.
- **Silent `JSON.parse` failures in the rg adapter are no longer
  silent.** With `MDG_DEBUG=1` set, parse errors and other internal
  aborts are written to stderr.

### Hardening

- **`buildFuzzyRegex` validates inputs.** Empty / whitespace-only
  patterns now throw with a clear error (previously they returned
  `""`, which matched every line and exploded token budgets).
  Trigram count is capped at 64; past that we fall back to a literal
  search of the longest token. Regex-meta patterns are still passed
  through, but with an `MDG_DEBUG` warning so a confused caller can
  see the silent skip.

### API surface

- **`SearchResult.status` gains `"partial"`.** Set when at least one
  source errored but others returned matches. `"error"` is now
  emitted when *all* sources errored. Agents branching on `status`
  see the truth instead of a misleading `"no_matches"`.
- **`SearchResult.errors[]` added.** Array of `{ source, message }`
  pairs for every source that failed during the scan. Always
  present; empty array when clean.
- **`StashOptions.ttl` and `StashOptions.locations` exposed.**
  The programmatic API now matches the CLI surface.

### Performance

- **Bounded-parallel per-source scan.** `search()` now fans out up
  to 4 concurrent `rg` processes by default. Tune with the
  `MDG_RG_CONCURRENCY` environment variable. Source order is
  preserved deterministically.
- **Per-source tmp files use a 6-byte random suffix** in addition to
  pid + ms, so two parallel scans on cmd/url/stdin sources can't
  collide on the temp path.

### New environment variables

- `MDG_DEBUG=1` — surface internal parse failures, fuzzy fallbacks,
  and other aborts on stderr.
- `MDG_RG_CONCURRENCY=N` — bound parallel rg processes per search
  (default 4).
- `MDG_FORCE_RESET=1` — permit overwriting a tainted palace file.
  Only set after inspecting the `.corrupt.<ts>` backup.

### Compatibility

No breaking changes to the CLI flag surface or the JSON result
schema's existing fields. The new `errors[]` field is additive;
callers that ignore unknown fields are unaffected. The new
`"partial"` status value is additive; callers using
`switch (status)` should add a case.

The mind-palace file format is unchanged.
