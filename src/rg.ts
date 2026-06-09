/**
 * Thin wrapper over ripgrep's --json output.
 *
 * We don't reimplement grep. rg is the fastest, most correct regex
 * engine available, and `--json` gives us structured matches we can
 * build context nodes from. This module is the only place that
 * knows about rg's CLI.
 *
 * Defensive posture against pathological input:
 *   - Pass `--max-columns` so rg refuses to emit megabyte-long
 *     `lines.text` payloads (minified assets, generated blobs).
 *     A preview marker still tells us a match existed.
 *   - Cap the in-memory line buffer. If rg emits a single JSON line
 *     longer than the cap, we kill the process and throw rather than
 *     letting V8 string-concat blow up O(n^2).
 *   - Clip per-Match `text` so a single oversized match line can't
 *     pin many megabytes into `pendingMatches` once per submatch.
 *   - Surface JSON parse failures via `MDG_DEBUG` instead of silently
 *     swallowing them — otherwise a truncated tail line looks like a
 *     clean "no matches" result.
 */

import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { resolve as resolvePath } from "node:path";
import type { Match, RgOptions, Source } from "./types.js";

export class RgError extends Error {
  constructor(
    message: string,
    public readonly code: number | null,
    public readonly stderr: string,
  ) {
    super(message);
    this.name = "RgError";
  }
}

export class RgNotFoundError extends Error {
  constructor() {
    super(
      "ripgrep (rg) is not installed or not on PATH. Install it from https://github.com/BurntSushi/ripgrep",
    );
    this.name = "RgNotFoundError";
  }
}

/** Hard cap on per-line size we will buffer before bailing out. */
const MAX_LINE_BUFFER_BYTES = 16 * 1024 * 1024; // 16 MB

/** Default cap on per-line columns rg will emit. */
const DEFAULT_MAX_COLUMNS = 1_000_000;

/** Hard cap on per-Match.text size we push downstream. */
const MAX_MATCH_TEXT_CHARS = 16 * 1024; // 16 KB per node's match line

interface RgJsonMatch {
  type: "match";
  data: {
    path: { text: string };
    lines: { text: string; bytes: number };
    line_number: number;
    absolute_offset: number;
    submatches: Array<{
      match: { text: string; bytes: number };
      start: number;
      end: number;
    }>;
  };
}

type RgJsonLine = RgJsonMatch | { type: string; data: unknown };

function debugLog(msg: string): void {
  if (process.env.MDG_DEBUG) {
    try { process.stderr.write(`mdg[rg]: ${msg}\n`); } catch { /* ignore */ }
  }
}

/**
 * Run ripgrep and yield structured matches as they arrive (streaming).
 */
export async function* runRg(
  pattern: string,
  source: Source,
  sourceContent: string | null,
  options: RgOptions = {},
): AsyncGenerator<Match> {
  const args: string[] = ["--json", "--no-heading", "--no-messages"];

  // Always cap per-line size. rg emits the preview form (still flags
  // the match, just doesn't ship the body) for oversized lines.
  const maxColumns = options.max_columns ?? DEFAULT_MAX_COLUMNS;
  args.push("--max-columns", String(maxColumns));
  args.push("--max-columns-preview");

  if (options.case_insensitive) args.push("-i");
  if (options.word_match) args.push("-w");
  if (options.fixed_strings) args.push("-F");
  if (options.multiline) args.push("-U", "--multiline-dotall");
  if (options.hidden) args.push("--hidden");
  if (options.no_ignore) args.push("-u");
  if (options.include_globs) {
    for (const g of options.include_globs) args.push("--glob", g);
  }
  if (options.exclude_globs) {
    for (const g of options.exclude_globs) args.push("--glob", `!${g}`);
  }
  if (options.type) args.push("--type", options.type);
  if (options.glob_case_insensitive) args.push("--glob-case-insensitive");

  // Search target. Non-file sources go to a temp file with a random
  // suffix — pid+ms is not enough when callers spawn many rg processes
  // in the same millisecond.
  let searchTarget: string;
  let cleanup: (() => void) | null = null;

  if (sourceContent !== null) {
    const tmpDir = process.env.TMPDIR || process.env.TMP || process.env.TEMP || "/tmp";
    const safeId = source.id.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 80);
    const rand = randomBytes(6).toString("hex");
    const tmpPath = resolvePath(tmpDir, `mdg-${process.pid}-${Date.now()}-${rand}-${safeId}`);
    const { writeFileSync, unlinkSync } = await import("node:fs");
    writeFileSync(tmpPath, sourceContent, "utf8");
    cleanup = () => {
      try { unlinkSync(tmpPath); } catch { /* ignore */ }
    };
    searchTarget = tmpPath;
  } else {
    searchTarget = source.id;
  }

  args.push("--", pattern, searchTarget);

  // Spawn rg.
  let proc: ReturnType<typeof spawn>;
  try {
    proc = spawn("rg", args, { stdio: ["ignore", "pipe", "pipe"] });
  } catch (err) {
    if (cleanup) cleanup();
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      throw new RgNotFoundError();
    }
    throw err;
  }

  // Stream-parse: accumulate chunks, split by newline, process complete
  // lines as they arrive. We track the buffer size so a pathological
  // single line (e.g. minified asset containing many alternation hits)
  // can't grow V8's string-concat path into O(n^2) memory.
  let stderr = "";
  if (proc.stderr) {
    proc.stderr.setEncoding("utf8");
    proc.stderr.on("data", (chunk) => { stderr += chunk; });
  }

  let lineBuffer = "";
  let bufferOverflow = false;
  let parseErrors = 0;
  let pendingResolve: (() => void) | null = null;
  const pendingMatches: Match[] = [];
  let streamEnded = false;
  let aborted = false;

  function clipMatchText(s: string): string {
    if (s.length <= MAX_MATCH_TEXT_CHARS) return s;
    const head = MAX_MATCH_TEXT_CHARS - 16;
    return s.slice(0, head) + "…[clipped]";
  }

  function processLine(line: string) {
    if (!line) return;
    let parsed: RgJsonLine;
    try {
      parsed = JSON.parse(line);
    } catch (err) {
      parseErrors++;
      debugLog(
        `JSON.parse failed on line of length ${line.length}: ${(err as Error).message}`,
      );
      return;
    }
    if (parsed.type !== "match") return;
    const m = parsed as RgJsonMatch;
    // rg emits `lines.text` as a string when the line fits under
    // --max-columns. With --max-columns-preview, oversized lines get a
    // truncated preview but the field is still a string.
    const rawText = m.data?.lines?.text;
    if (typeof rawText !== "string") {
      debugLog(`match record missing lines.text at line ${m.data?.line_number}`);
      return;
    }
    const txt = clipMatchText(stripTrailingNewline(rawText));
    let matchSource: Source;
    if (sourceContent !== null) {
      matchSource = source;
    } else {
      const filePath = resolvePath(m.data.path.text);
      matchSource = { id: filePath, type: "file" };
    }
    for (const sub of m.data.submatches) {
      pendingMatches.push({
        source: matchSource,
        line: m.data.line_number,
        text: txt,
        match_start: sub.start,
        match_end: sub.end,
      });
    }
  }

  function abortProc(reason: string) {
    if (aborted) return;
    aborted = true;
    debugLog(`aborting rg: ${reason}`);
    try { proc.kill("SIGTERM"); } catch { /* ignore */ }
  }

  proc.stdout!.setEncoding("utf8");
  proc.stdout!.on("data", (chunk: string) => {
    if (aborted) return;
    // Guard before any string-concat. If a single line is already
    // bigger than our cap, kill rg and let the generator surface the
    // error on close — we never want O(n^2) string-concat growth.
    if (lineBuffer.length + chunk.length > MAX_LINE_BUFFER_BYTES) {
      bufferOverflow = true;
      abortProc(`single line exceeded ${MAX_LINE_BUFFER_BYTES} bytes`);
      if (pendingResolve) { pendingResolve(); pendingResolve = null; }
      return;
    }
    lineBuffer += chunk;
    const lines = lineBuffer.split("\n");
    lineBuffer = lines.pop()!; // keep incomplete last line
    for (const line of lines) processLine(line);
    if (pendingMatches.length > 0 && pendingResolve) {
      pendingResolve();
      pendingResolve = null;
    }
  });

  proc.stdout!.on("end", () => {
    // Process any trailing partial line — if we aborted because of
    // overflow, skip this so we don't try to parse a multi-MB
    // mid-line buffer.
    if (!bufferOverflow && lineBuffer.trim()) processLine(lineBuffer);
    streamEnded = true;
    if (pendingResolve) {
      pendingResolve();
      pendingResolve = null;
    }
  });

  const closePromise = new Promise<{ code: number | null }>((resolve, reject) => {
    proc.on("error", reject);
    proc.on("close", (code) => resolve({ code }));
  });

  // Async generator loop: drain pending matches, wait for more, repeat.
  try {
    let allEmitted = false;
    while (!allEmitted) {
      while (pendingMatches.length > 0) {
        yield pendingMatches.shift()!;
      }
      if (streamEnded || bufferOverflow) {
        allEmitted = true;
      } else {
        await new Promise<void>((resolve) => {
          pendingResolve = resolve;
        });
      }
    }
  } finally {
    const { code } = await closePromise;
    if (cleanup) cleanup();
    if (parseErrors > 0) {
      debugLog(`${parseErrors} JSON line(s) failed to parse during this scan`);
    }
    if (bufferOverflow) {
      throw new RgError(
        `mdg: a single match line exceeded ${MAX_LINE_BUFFER_BYTES} bytes ` +
        `for source ${source.id}. This usually means a minified asset or ` +
        `generated blob — exclude it with --glob '!path' or pass a more ` +
        `restrictive pattern.`,
        code,
        stderr,
      );
    }
    // rg exit codes: 0 = matches, 1 = no matches, 2+ = error.
    // We treat SIGTERM (null code on POSIX, sometimes propagated as
    // exit 143 / signal name) as our own abort signal and don't
    // surface it as a separate error.
    if (!aborted && code !== null && code > 1) {
      throw new RgError(
        `ripgrep exited with code ${code}: ${stderr.trim() || "unknown error"}`,
        code,
        stderr,
      );
    }
  }
}

function stripTrailingNewline(s: string): string {
  if (s.endsWith("\r\n")) return s.slice(0, -2);
  if (s.endsWith("\n")) return s.slice(0, -1);
  return s;
}
