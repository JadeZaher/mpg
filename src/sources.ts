/**
 * Source resolution.
 *
 * A "source" is a stream of text we can search. mdg supports four kinds:
 *
 *   - file/glob: read from disk
 *   - command:   exec a shell command, search its stdout
 *   - stdin:     read piped input
 *   - url:       fetch with HTTP GET
 *
 * For non-file sources we capture the content into memory and feed it
 * to rg via a temp file (see rg.ts). This keeps rg as the single
 * search engine while supporting arbitrary content types.
 */

import { spawn } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { resolve as resolvePath } from "node:path";
import { Readable } from "node:stream";
import type { Source } from "./types.js";

/** Cached stdin content so @- and content stdin don't double-read. */
let _cachedStdin: string | null = null;

/** Read stdin once and cache it. Returns cached value on subsequent calls. */
export async function getStdin(): Promise<string> {
  if (_cachedStdin !== null) return _cachedStdin;
  if (process.stdin.isTTY) {
    _cachedStdin = "";
    return "";
  }
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin as Readable) {
    chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
  }
  _cachedStdin = Buffer.concat(chunks).toString("utf8");
  return _cachedStdin;
}

/** Reset the cached stdin (e.g. in test teardown). */
export function resetStdinCache(): void {
  _cachedStdin = null;
}

export interface ResolvedSource {
  source: Source;
  /** Inline content if we have it (stdin, command, url, or small files). */
  content: string | null;
}

/** Expand globs into individual file paths using Node's built-in fs.glob. */
export async function expandGlobs(patterns: string[]): Promise<string[]> {
  if (patterns.length === 0) return [];
  const { glob } = await import("node:fs/promises");
  const { statSync } = await import("node:fs");
  const out = new Set<string>();

  async function walk(p: string) {
    // If p is a directory, recurse with a trailing /** pattern.
    // If p is a file, add it.
    // If p contains wildcards, glob it.
    let s: import("node:fs").Stats | null = null;
    try { s = statSync(p); } catch { /* not on disk */ }

    // Node's fs.glob treats `\` as a glob escape, so absolute Windows
    // paths with backslashes never match. Normalize separators for the
    // pattern only — entries returned by glob are still valid paths.
    const toGlobPattern = (s: string) => s.replace(/\\/g, "/");

    if (s && s.isDirectory()) {
      const trimmed = p.replace(/[\\\/]+$/, "");
      const recursePattern = `${toGlobPattern(trimmed)}/**`;
      try {
        for await (const entry of glob(recursePattern)) {
          try {
            const es = statSync(entry);
            if (es.isFile()) out.add(entry);
          } catch { /* skip */ }
        }
      } catch { /* ignore */ }
    } else if (s && s.isFile()) {
      out.add(p);
    } else {
      // Not on disk — treat as a glob pattern.
      try {
        for await (const entry of glob(toGlobPattern(p))) {
          try {
            const es = statSync(entry);
            if (es.isFile()) out.add(entry);
          } catch { /* skip */ }
        }
      } catch { /* ignore */ }
    }
  }

  for (const pattern of patterns) {
    await walk(pattern);
  }
  return [...out];
}

/** Heuristic: if a path exists as a file/dir, classify it. */
export function classifyPath(p: string): "file" | "glob" {
  if (!existsSync(p)) return "glob";
  const s = statSync(p);
  if (s.isDirectory()) return "glob";
  if (s.isFile()) return "file";
  return "glob";
}

/**
 * Resolve a list of path specs to actual file paths.
 *
 * If `stdinContent` is provided, it is used as the content when
 * resolving `@-` specs instead of reading process.stdin again.
 * This avoids double-reading stdin when both content-from-stdin and
 * path-list-from-stdin are used in the same invocation.
 *
 * A spec can be:
 *   - `@-`         read paths from stdin, one per line
 *   - `@<file>`    read paths from a file, one per line
 *   - `path`       a literal file or directory path
 *   - `glob`       a glob pattern; expanded via fs.glob
 *
 * Directories are recursed into. Empty lines and `#` comments are
 * ignored when reading from a file.
 */
export async function resolvePathSpecs(specs: string[], stdinContent?: string | null): Promise<string[]> {
  const out = new Set<string>();
  for (const spec of specs) {
    if (spec === "@-") {
      // Read paths from stdin.
      const text = stdinContent ?? await getStdin();
      for (const line of text.split(/\r?\n/)) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith("#")) continue;
        await addExpanded(trimmed, out);
      }
      continue;
    }
    if (spec.startsWith("@")) {
      // Read paths from a file.
      const filePath = spec.slice(1);
      let text: string;
      try {
        const { readFileSync } = await import("node:fs");
        text = readFileSync(filePath, "utf8");
      } catch (err) {
        throw new Error(`Cannot read path list from @${filePath}: ${(err as Error).message}`);
      }
      for (const line of text.split(/\r?\n/)) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith("#")) continue;
        await addExpanded(trimmed, out);
      }
      continue;
    }
    await addExpanded(spec, out);
  }
  return [...out];
}

/**
 * Split path specs into two buckets without expanding directories:
 *
 *   - `files`:    literal file paths the caller asked for. Each becomes
 *                 a separate `runRg` invocation so they can be searched
 *                 in parallel and their per-file content cache is hot.
 *   - `bulk`:     directories and glob patterns. These get passed to
 *                 rg as-is — rg walks them itself in parallel, much
 *                 faster than fan-out-per-file from Node. Each bulk
 *                 entry becomes one `runRg` invocation that may emit
 *                 matches from many files.
 *
 * `@file` / `@-` are still expanded inline (the caller asked for an
 * explicit list, so we respect that).
 *
 * Returns absolute paths so deduplication is stable across cwd-relative
 * vs absolute inputs.
 */
export async function classifyPathSpecs(
  specs: string[],
  stdinContent?: string | null,
): Promise<{ files: string[]; bulk: string[] }> {
  const files = new Set<string>();
  const bulk = new Set<string>();

  function hasGlobMeta(s: string): boolean {
    // Match characters that imply globbing. We don't try to handle
    // brace expansion (`{a,b}`) — rg doesn't accept it on argv either,
    // so we expand ourselves below.
    return /[*?\[\]]/.test(s);
  }

  async function classify(spec: string) {
    if (existsSync(spec)) {
      const s = statSync(spec);
      if (s.isFile()) {
        files.add(resolvePath(spec));
        return;
      }
      if (s.isDirectory()) {
        // The big win: directories go to rg as-is. rg walks them
        // itself in parallel, much faster than one rg invocation per
        // file from Node.
        bulk.add(resolvePath(spec));
        return;
      }
    }
    if (hasGlobMeta(spec)) {
      // rg does NOT accept shell-style globs as path args. Expand
      // ourselves to literal files so the search target list stays
      // valid. The win against the old code is that *dirs* (the
      // common case) now skip expansion.
      const expanded = await expandGlobs([spec]);
      for (const f of expanded) files.add(resolvePath(f));
      return;
    }
    // Spec doesn't exist and has no glob meta — most likely a typo or
    // a stale stash entry. Let rg surface the error rather than
    // swallowing it silently.
    bulk.add(spec);
  }

  for (const spec of specs) {
    if (spec === "@-") {
      const text = stdinContent ?? await getStdin();
      for (const line of text.split(/\r?\n/)) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith("#")) continue;
        await classify(trimmed);
      }
      continue;
    }
    if (spec.startsWith("@")) {
      const filePath = spec.slice(1);
      let text: string;
      try {
        const { readFileSync } = await import("node:fs");
        text = readFileSync(filePath, "utf8");
      } catch (err) {
        throw new Error(`Cannot read path list from @${filePath}: ${(err as Error).message}`);
      }
      for (const line of text.split(/\r?\n/)) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith("#")) continue;
        await classify(trimmed);
      }
      continue;
    }
    await classify(spec);
  }
  return { files: [...files], bulk: [...bulk] };
}

/** Classify a spec, expand globs, and add all files to `out`. */
async function addExpanded(spec: string, out: Set<string>): Promise<void> {
  const t = classifyPath(spec);
  if (t === "file") {
    out.add(spec);
    return;
  }
  // Glob or directory — expand.
  const files = await expandGlobs([spec]);
  for (const f of files) out.add(f);
}

export function resolveFileSource(p: string): ResolvedSource {
  const abs = resolvePath(p);
  return {
    source: { id: abs, type: "file" },
    content: null, // let rg read the file directly (streaming, no temp file)
  };
}

export async function resolveGlobSource(pattern: string): Promise<ResolvedSource[]> {
  const files = await expandGlobs([pattern]);
  return files.map((f) => ({
    source: { id: resolvePath(f), type: "file" },
    content: null,
  }));
}

export function resolveCommandSource(cmd: string): ResolvedSource {
  return {
    source: { id: `cmd:${cmd}`, type: "command", label: `$ ${cmd}` },
    content: null, // will be filled by captureCommand
  };
}

/** Cap captured command stdout at 64MB. Past that we truncate with a marker. */
const COMMAND_OUTPUT_MAX_BYTES = 64 * 1024 * 1024;
/** Default command timeout — 60s for `git log` etc. is plenty. */
const COMMAND_TIMEOUT_MS = 60_000;

/**
 * Capture a shell command's stdout for searching.
 *
 * Quoting handled correctly: the command runs through the platform
 * shell (`bash -c` on POSIX, `cmd /c` on Windows), so `git log
 * --grep="fix bug"` parses the way the user typed it.
 *
 * Output is capped at COMMAND_OUTPUT_MAX_BYTES and the command is
 * killed after COMMAND_TIMEOUT_MS so a hanging or runaway command
 * can't lock up the agent harness.
 */
export async function captureCommand(cmd: string): Promise<string> {
  const trimmed = cmd.trim();
  if (!trimmed) throw new Error("Empty command");

  const shell = process.platform === "win32" ? "cmd.exe" : "bash";
  const shellArgs = process.platform === "win32" ? ["/c", trimmed] : ["-c", trimmed];

  return await new Promise<string>((resolve, reject) => {
    const proc = spawn(shell, shellArgs, { stdio: ["ignore", "pipe", "pipe"] });
    const chunks: Buffer[] = [];
    let bytes = 0;
    let truncated = false;
    let stderr = "";
    let settled = false;

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try { proc.kill("SIGTERM"); } catch { /* ignore */ }
      reject(new Error(
        `Command timed out after ${COMMAND_TIMEOUT_MS}ms: ${trimmed.slice(0, 200)}`,
      ));
    }, COMMAND_TIMEOUT_MS);

    proc.stdout!.on("data", (chunk: Buffer) => {
      if (truncated) return;
      const remaining = COMMAND_OUTPUT_MAX_BYTES - bytes;
      if (chunk.length <= remaining) {
        chunks.push(chunk);
        bytes += chunk.length;
        return;
      }
      // Take what we can, then signal SIGTERM. Anything after the cap
      // is silently dropped — we keep a marker so the caller can tell.
      if (remaining > 0) {
        chunks.push(chunk.subarray(0, remaining));
        bytes += remaining;
      }
      truncated = true;
      try { proc.kill("SIGTERM"); } catch { /* ignore */ }
    });

    proc.stderr!.setEncoding("utf8");
    proc.stderr!.on("data", (chunk: string) => { stderr += chunk; });

    proc.on("error", (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(err);
    });

    proc.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (truncated) {
        // Successful path: caller gets the truncated output plus a
        // marker. We don't reject because partial data is still useful.
        const out = Buffer.concat(chunks).toString("utf8") +
          `\n[mdg: command output truncated at ${COMMAND_OUTPUT_MAX_BYTES} bytes]\n`;
        resolve(out);
        return;
      }
      if (code !== 0 && code !== null) {
        reject(new Error(
          `Command exited with code ${code}: ${trimmed.slice(0, 200)}` +
          (stderr ? `\nstderr: ${stderr.slice(0, 500)}` : ""),
        ));
        return;
      }
      resolve(Buffer.concat(chunks).toString("utf8"));
    });
  });
}

/** Deprecated: use getStdin() instead to avoid double-reads. */
export async function captureStdin(): Promise<string> {
  return getStdin();
}

/** Cap fetched URL body at 16MB — anything larger is a denial-of-context risk. */
const URL_FETCH_MAX_BYTES = 16 * 1024 * 1024;
/** Default URL fetch timeout. */
const URL_FETCH_TIMEOUT_MS = 30_000;

export async function captureUrl(url: string): Promise<string> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), URL_FETCH_TIMEOUT_MS);
  let res: Response;
  try {
    res = await fetch(url, {
      redirect: "follow",
      headers: { "user-agent": "mdg/0.2 (+https://github.com/JadeZaher/mdg)" },
      signal: controller.signal,
    });
  } catch (err) {
    clearTimeout(timer);
    if ((err as Error).name === "AbortError") {
      throw new Error(`Fetch of ${url} timed out after ${URL_FETCH_TIMEOUT_MS}ms`);
    }
    throw err;
  }
  try {
    if (!res.ok) {
      throw new Error(`Failed to fetch ${url}: ${res.status} ${res.statusText}`);
    }
    // Cheap MIME guard — we are searching text. Reject obvious binary
    // types before we read the body so an LLM can't OOM us by passing
    // a video URL.
    const ct = (res.headers.get("content-type") ?? "").toLowerCase();
    if (ct && !ct.startsWith("text/") && !/json|xml|yaml|javascript|csv|html|markdown/.test(ct)) {
      throw new Error(
        `Refusing to fetch non-text content-type "${ct}" from ${url}. ` +
        `Use a different tool to search binary payloads.`,
      );
    }
    // Content-length pre-check (cheap if the server set it).
    const clHeader = res.headers.get("content-length");
    if (clHeader) {
      const cl = parseInt(clHeader, 10);
      if (!Number.isNaN(cl) && cl > URL_FETCH_MAX_BYTES) {
        throw new Error(
          `Refusing to fetch ${cl} bytes from ${url} (cap: ${URL_FETCH_MAX_BYTES}). ` +
          `Download manually and search the file.`,
        );
      }
    }
    // Stream-with-cap. If content-length lied or wasn't set, we still
    // bail out as soon as we cross the threshold.
    if (!res.body) return "";
    const reader = res.body.getReader();
    const decoder = new TextDecoder("utf-8");
    let out = "";
    let bytes = 0;
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > URL_FETCH_MAX_BYTES) {
        try { await reader.cancel(); } catch { /* ignore */ }
        throw new Error(
          `Fetched body exceeded ${URL_FETCH_MAX_BYTES} bytes from ${url}. ` +
          `Download manually and search the file.`,
        );
      }
      out += decoder.decode(value, { stream: true });
    }
    out += decoder.decode();
    return out;
  } finally {
    clearTimeout(timer);
  }
}

export function resolveUrlSource(url: string): ResolvedSource {
  return {
    source: { id: url, type: "url" },
    content: null, // filled by captureUrl
  };
}
