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

import { execFileSync } from "node:child_process";
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

export async function captureCommand(cmd: string): Promise<string> {
  // Use execFile with a shell so the user can pass arbitrary commands.
  // We split on whitespace for simplicity; if you need shell features
  // (pipes, redirects) wrap in `bash -c` yourself.
  const parts = cmd.split(/\s+/).filter(Boolean);
  if (parts.length === 0) throw new Error("Empty command");
  const out = execFileSync(parts[0], parts.slice(1), {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
  });
  return out;
}

/** Deprecated: use getStdin() instead to avoid double-reads. */
export async function captureStdin(): Promise<string> {
  return getStdin();
}

export async function captureUrl(url: string): Promise<string> {
  const res = await fetch(url, {
    redirect: "follow",
    headers: { "user-agent": "mdg/0.1 (+https://github.com/)" },
  });
  if (!res.ok) {
    throw new Error(`Failed to fetch ${url}: ${res.status} ${res.statusText}`);
  }
  return await res.text();
}

export function resolveUrlSource(url: string): ResolvedSource {
  return {
    source: { id: url, type: "url" },
    content: null, // filled by captureUrl
  };
}
