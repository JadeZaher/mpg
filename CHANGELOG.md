# Changelog

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
