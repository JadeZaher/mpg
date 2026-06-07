/**
 * Control-arm tool implementations.
 *
 * Exposes four general-purpose file-system and shell tools:
 *   read, grep, write, bash
 *
 * Each ToolImpl receives the raw `input` object from the model's tool_use
 * block and returns a string to feed back as the tool_result content.
 * Errors are caught and returned as error strings so the model can adapt.
 */

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import type { Tool } from "./client.js";

// ─── Types ───────────────────────────────────────────────────────────────────

export type ToolInput = Record<string, unknown>;
export type ToolImpl = (input: ToolInput, cwd: string) => string;

export interface ToolDef {
  schema: Tool;
  impl: ToolImpl;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

const CAP_READ = 100_000; // chars
const CAP_BASH = 50_000; // chars
const DEFAULT_GREP_MAX = 50;

function str(v: unknown, fallback = ""): string {
  return typeof v === "string" ? v : fallback;
}

function num(v: unknown, fallback: number): number {
  return typeof v === "number" && Number.isFinite(v) ? v : fallback;
}

function truncate(s: string, limit: number): string {
  if (s.length <= limit) return s;
  return s.slice(0, limit) + `\n[truncated — output exceeded ${limit} chars]`;
}

// ─── read ─────────────────────────────────────────────────────────────────────

const readSchema: Tool = {
  name: "read",
  description:
    "Read the full contents of a file. Output is capped at 100 000 characters with a [truncated] marker if exceeded.",
  input_schema: {
    type: "object" as const,
    properties: {
      path: {
        type: "string",
        description: "Absolute or repo-relative path to the file to read.",
      },
    },
    required: ["path"],
  },
};

function readImpl(input: ToolInput, cwd: string): string {
  const path = str(input["path"]);
  if (!path) return "[error] read: 'path' is required";
  try {
    const abs = resolve(cwd, path);
    const content = readFileSync(abs, "utf8");
    return truncate(content, CAP_READ);
  } catch (e) {
    return `[error] read: ${(e as Error).message}`;
  }
}

// ─── grep ─────────────────────────────────────────────────────────────────────

const grepSchema: Tool = {
  name: "grep",
  description:
    "Search for a regex pattern in a file or directory using ripgrep. Returns matching lines with line numbers. Results are capped at max_results lines.",
  input_schema: {
    type: "object" as const,
    properties: {
      pattern: {
        type: "string",
        description: "Regular expression pattern (ripgrep syntax).",
      },
      path: {
        type: "string",
        description: "File or directory path to search.",
      },
      max_results: {
        type: "number",
        description: `Maximum number of matching lines to return. Default: ${DEFAULT_GREP_MAX}.`,
      },
    },
    required: ["pattern", "path"],
  },
};

function grepImpl(input: ToolInput, cwd: string): string {
  const pattern = str(input["pattern"]);
  const path = str(input["path"]);
  const maxResults = num(input["max_results"], DEFAULT_GREP_MAX);

  if (!pattern) return "[error] grep: 'pattern' is required";
  if (!path) return "[error] grep: 'path' is required";

  try {
    const abs = resolve(cwd, path);
    const r = spawnSync(
      "rg",
      ["--line-number", "--no-heading", "--color", "never", pattern, abs],
      {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
        maxBuffer: 16 * 1024 * 1024,
      },
    );

    const stdout: string = r.stdout ?? "";
    const stderr: string = r.stderr ?? "";

    if (r.status === 2) {
      // rg exits 2 on error (1 = no matches, which is fine)
      return `[error] grep: ripgrep error — ${stderr.trim() || "unknown"}`;
    }

    const lines = stdout.split(/\r?\n/).filter(Boolean);
    const capped = lines.slice(0, maxResults);
    const suffix =
      lines.length > maxResults
        ? `\n[truncated — showing ${maxResults} of ${lines.length} matches]`
        : "";

    return capped.join("\n") + suffix || "(no matches)";
  } catch (e) {
    return `[error] grep: ${(e as Error).message}`;
  }
}

// ─── write ────────────────────────────────────────────────────────────────────

const writeSchema: Tool = {
  name: "write",
  description:
    "Write content to a file, creating parent directories if needed. Returns 'ok' on success.",
  input_schema: {
    type: "object" as const,
    properties: {
      path: {
        type: "string",
        description: "Absolute or repo-relative path to write.",
      },
      content: {
        type: "string",
        description: "Content to write. Overwrites any existing file.",
      },
    },
    required: ["path", "content"],
  },
};

function writeImpl(input: ToolInput, cwd: string): string {
  const path = str(input["path"]);
  const content = str(input["content"]);
  if (!path) return "[error] write: 'path' is required";
  try {
    const abs = resolve(cwd, path);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, content, "utf8");
    return "ok";
  } catch (e) {
    return `[error] write: ${(e as Error).message}`;
  }
}

// ─── bash ─────────────────────────────────────────────────────────────────────

const bashSchema: Tool = {
  name: "bash",
  description:
    "Run an arbitrary shell command. Stdout and stderr are returned concatenated. Output is capped at 50 000 characters.",
  input_schema: {
    type: "object" as const,
    properties: {
      command: {
        type: "string",
        description: "Shell command to execute.",
      },
      cwd: {
        type: "string",
        description:
          "Working directory for the command. Defaults to the task working directory.",
      },
    },
    required: ["command"],
  },
};

function bashImpl(input: ToolInput, cwd: string): string {
  const command = str(input["command"]);
  const cmdCwd = str(input["cwd"]) || cwd;
  if (!command) return "[error] bash: 'command' is required";
  try {
    const r = spawnSync(command, [], {
      shell: true,
      encoding: "utf8",
      cwd: cmdCwd,
      stdio: ["ignore", "pipe", "pipe"],
      maxBuffer: 64 * 1024 * 1024,
    });
    const combined = (r.stdout ?? "") + (r.stderr ?? "");
    return truncate(combined, CAP_BASH) || "(no output)";
  } catch (e) {
    return `[error] bash: ${(e as Error).message}`;
  }
}

// ─── Exports ──────────────────────────────────────────────────────────────────

export const CONTROL_TOOL_DEFS: ToolDef[] = [
  { schema: readSchema, impl: readImpl },
  { schema: grepSchema, impl: grepImpl },
  { schema: writeSchema, impl: writeImpl },
  { schema: bashSchema, impl: bashImpl },
];

/** Map tool name → impl (for fast dispatch in the loop). */
export function buildControlDispatch(cwd: string): Map<string, (input: ToolInput) => string> {
  const m = new Map<string, (input: ToolInput) => string>();
  for (const { schema, impl } of CONTROL_TOOL_DEFS) {
    const name = schema.name;
    m.set(name, (input) => impl(input, cwd));
  }
  return m;
}
