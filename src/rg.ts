/**
 * Thin wrapper over ripgrep's --json output.
 *
 * We don't reimplement grep. rg is the fastest, most correct regex
 * engine available, and `--json` gives us structured matches we can
 * build context nodes from. This module is the only place that
 * knows about rg's CLI.
 *
 * v1.1: stream-parses rg output line-by-line (no full buffering)
 * and cleans up temp files on SIGINT/SIGTERM.
 */

import { spawn } from "node:child_process";
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

  // Search target. Non-file sources go to a temp file.
  let searchTarget: string;
  let cleanup: (() => void) | null = null;

  if (sourceContent !== null) {
    const tmpDir = process.env.TMPDIR || process.env.TMP || process.env.TEMP || "/tmp";
    const safeId = source.id.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 80);
    const tmpPath = resolvePath(tmpDir, `mdg-${process.pid}-${Date.now()}-${safeId}`);
    const { writeFileSync, unlinkSync } = await import("node:fs");
    writeFileSync(tmpPath, sourceContent, "utf8");
    cleanup = () => {
      try { unlinkSync(tmpPath); } catch { /* ignore */ }
    };
    // Clean up the temp file if the process is killed.
    const onSignal = () => {
      if (cleanup) {
        cleanup();
        cleanup = null;
      }
      process.exit(1);
    };
    process.once("SIGINT", onSignal);
    process.once("SIGTERM", onSignal);
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
  // lines as they arrive. This avoids buffering the entire rg output in
  // memory (which could be 100s of MB for a large monorepo).
  let stderr = "";
  if (proc.stderr) {
    proc.stderr.setEncoding("utf8");
    proc.stderr.on("data", (chunk) => { stderr += chunk; });
  }

  let lineBuffer = "";
  let pendingResolve: (() => void) | null = null;
  const pendingMatches: Match[] = [];
  let streamEnded = false;

  function processLine(line: string) {
    if (!line) return;
    let parsed: RgJsonLine;
    try {
      parsed = JSON.parse(line);
    } catch {
      return; // tolerate malformed lines
    }
    if (parsed.type !== "match") return;
    const m = parsed as RgJsonMatch;
    const txt = stripTrailingNewline(m.data.lines.text);
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

  proc.stdout!.setEncoding("utf8");
  proc.stdout!.on("data", (chunk: string) => {
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
    // Process any trailing partial line.
    if (lineBuffer.trim()) processLine(lineBuffer);
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
      if (streamEnded) {
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
    // rg exit codes: 0 = matches, 1 = no matches, 2+ = error.
    if (code !== null && code > 1) {
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
