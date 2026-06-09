/**
 * Treatment-arm tool implementations.
 *
 * Exports all four control tools plus five mind-palace tools that shell
 * out to the local mpg CLI:
 *
 *   mpg_search        — search the codebase, optionally stash
 *   mpg_stash         — search + stash in one shot
 *   mpg_list_stashes  — list all stashes in the palace
 *   mpg_get_stash     — retrieve a named stash
 *   mpg_drop_stash    — free a named stash
 *
 * Every mpg invocation passes --mp-path <palacePath> when palacePath is
 * set, ensuring per-task palace isolation across concurrent runs.
 */

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { Tool } from "./client.js";
import {
  CONTROL_TOOL_DEFS,
  buildControlDispatch,
  type ToolDef,
  type ToolInput,
} from "./tools-control.js";

// ─── Repo root resolution ─────────────────────────────────────────────────────

const __filename = fileURLToPath(import.meta.url);
// bench/macro/agent/ -> bench/macro/ -> bench/ -> repo root
const _agentDir = dirname(__filename);
const _macroDir = dirname(_agentDir);
const _benchDir = dirname(_macroDir);
const _rootCandidate = dirname(_benchDir);

function getRepoRoot(): string {
  // Walk up from this file's directory until we find package.json.
  const candidates = [_rootCandidate, dirname(_rootCandidate), process.cwd()];
  for (const c of candidates) {
    if (existsSync(resolve(c, "package.json"))) return c;
  }
  return process.cwd();
}

const REPO_ROOT = getRepoRoot();
const MPG_CLI = resolve(REPO_ROOT, "dist", "index.js");

// ─── mpg shell helper ─────────────────────────────────────────────────────────

interface MpgResult {
  stdout: string;
  stderr: string;
  code: number;
}

function runMpg(args: string[], cwd: string): MpgResult {
  const r = spawnSync("node", [MPG_CLI, ...args], {
    encoding: "utf8",
    cwd,
    stdio: ["ignore", "pipe", "pipe"],
    maxBuffer: 32 * 1024 * 1024,
  });
  return {
    stdout: r.stdout ?? "",
    stderr: r.stderr ?? "",
    code: r.status ?? -1,
  };
}

function palaceArgs(palacePath: string | undefined): string[] {
  return palacePath ? ["--mp-path", palacePath] : [];
}

function str(v: unknown, fallback = ""): string {
  return typeof v === "string" ? v : fallback;
}

// ─── mpg_search ───────────────────────────────────────────────────────────────

const mpgSearchSchema: Tool = {
  name: "mpg_search",
  description:
    "Search files with mpg. Think of mpg as a LENS over the corpus with no boundary " +
    "between files — you set the focal points (matches) and their depth (window). " +
    "It does what grep does (file:line hits) AND what read does (full content), " +
    "depending on flags. " +
    "TLDR:\n" +
    "  - To grep: effort='scan', clip_chars=30 -> 3.2x cheaper than rg at same recall.\n" +
    "  - To read one file: in=['file.md'], effort='deep' -> full content via the lens.\n" +
    "  - To browse recency: effort='scan', sort='recent', page=1, page_size=10.\n" +
    "  - To compact a topic: effort='scan', clip_chars=30, max_tokens=2000.\n" +
    "  - For typos: fuzzy=true (handles drop/insert/swap/sub, edit dist <= 2).\n" +
    "  - Stash via stash_name to reuse across turns; later scope with from='<name>'.",
  input_schema: {
    type: "object" as const,
    properties: {
      pattern: {
        type: "string",
        description: "Regex pattern (ripgrep syntax) to search for.",
      },
      in: {
        type: "array",
        items: { type: "string" },
        description: "Files, directories, or globs to search. Single file = 'read this file'.",
      },
      effort: {
        type: "string",
        enum: ["scan", "quick", "normal", "deep"],
        description:
          "Lens depth. scan=20t windows uncapped (cheap index, like grep). " +
          "quick=200t/10n. normal=500t/30n. deep=2000t/100n (like read). Default: quick.",
      },
      max_nodes: {
        type: "number",
        description: "Maximum number of nodes to return. Use to cap result size.",
      },
      max_tokens: {
        type: "number",
        description:
          "Total token budget across all returned nodes. Use to produce a compaction " +
          "in a fixed budget (e.g. max_tokens: 2000 for a 2k-token summary).",
      },
      before: {
        type: "number",
        description: "Tokens of context before each match (overrides effort preset).",
      },
      after: {
        type: "number",
        description: "Tokens of context after each match (overrides effort preset).",
      },
      clip_chars: {
        type: "number",
        description:
          "Sub-line snippet mode. Drops line context entirely; trims the match line to " +
          "this many chars on each side of the matched span (with ellipsis markers). " +
          "Combine with effort='scan' for the cheapest possible hit list — " +
          "~30 tokens per hit, beats raw rg on tokens at the same recall. " +
          "Use 0-50 for a tight index, 100+ when more snippet context helps.",
      },
      fuzzy: {
        type: "boolean",
        description:
          "Typo-tolerant search. Handles drop/insert/substitute/swap typos at " +
          "edit distance <= 2 via trigram-union + Levenshtein. Use when the user " +
          "input might be misspelled.",
      },
      sort: {
        type: "string",
        enum: ["default", "recent", "oldest"],
        description:
          "Order returned nodes by source file mtime. 'recent' surfaces what just " +
          "changed first — great with scan for a time-ordered memory index. " +
          "Paginate to browse back in history.",
      },
      window_curve: {
        type: "string",
        enum: ["flat", "linear", "log"],
        description:
          "Per-node window decay across ranks. flat: every node full. " +
          "linear: full at rank 0, ~10% at last. log: full / log2(rank+2). " +
          "Combine with sort='recent' for rich context on recent hits, " +
          "tight windows on older ones. 'log' saves ~50% tokens at rank-0 parity.",
      },
      page: {
        type: "number",
        description: "1-indexed page number for paginated results.",
      },
      page_size: {
        type: "number",
        description: "Items per page. Default 10 for nodes.",
      },
      from: {
        type: "string",
        description:
          "Use a previously stashed file list as the search target (stash name). " +
          "Replaces the search root with just the files in the stash — much cheaper " +
          "than re-searching the whole corpus.",
      },
      compose: {
        type: "array",
        items: { type: "string" },
        description: "Compose search across multiple stash file lists (union).",
      },
      stash_name: {
        type: "string",
        description:
          "If provided, stash results under this name in the mind palace. " +
          "Stash anything you'll reference later; future searches scope via from='<name>'.",
      },
      stash_note: {
        type: "string",
        description: "Optional description for the stash.",
      },
      stash_tags: {
        type: "array",
        items: { type: "string" },
        description: "Optional tags for the stash.",
      },
    },
    required: ["pattern"],
  },
};

function mpgSearchImpl(
  input: ToolInput,
  cwd: string,
  palacePath: string | undefined,
): string {
  const pattern = str(input["pattern"]);
  if (!pattern) return "[error] mpg_search: 'pattern' is required";

  const args: string[] = [pattern, "--format", "json", "--no-color"];

  const paths = input["in"];
  if (Array.isArray(paths) && paths.length > 0) {
    args.push("--in", ...(paths as string[]));
  }

  const effort = str(input["effort"]);
  if (effort) args.push("--effort", effort);

  const maxNodes = input["max_nodes"];
  if (typeof maxNodes === "number") args.push("--max-nodes", String(maxNodes));

  const maxTokens = input["max_tokens"];
  if (typeof maxTokens === "number") args.push("--max-tokens", String(maxTokens));

  const before = input["before"];
  if (typeof before === "number") args.push("--before", String(before));

  const after = input["after"];
  if (typeof after === "number") args.push("--after", String(after));

  const clipChars = input["clip_chars"];
  if (typeof clipChars === "number") args.push("--clip", String(clipChars));

  if (input["fuzzy"] === true) args.push("--fuzzy");

  const sort = str(input["sort"]);
  if (sort) args.push("--sort", sort);

  const windowCurve = str(input["window_curve"]);
  if (windowCurve) args.push("--window-curve", windowCurve);

  const page = input["page"];
  if (typeof page === "number") args.push("--page", String(page));

  const pageSize = input["page_size"];
  if (typeof pageSize === "number") args.push("--page-size", String(pageSize));

  const from = str(input["from"]);
  if (from) args.push("--mp-from", from);

  const compose = input["compose"];
  if (Array.isArray(compose) && compose.length > 0) {
    args.push("--mp-compose", ...(compose as string[]));
  }

  const stashName = str(input["stash_name"]);
  if (stashName) {
    args.push("--mp-stash", stashName);
    const note = str(input["stash_note"]);
    if (note) args.push(note);
    const tags = input["stash_tags"];
    if (Array.isArray(tags)) {
      for (const t of tags as string[]) args.push("--mp-tag", t);
    }
  }

  args.push(...palaceArgs(palacePath));

  const { stdout, stderr, code } = runMpg(args, cwd);
  if (code !== 0 && !stdout) {
    return `[error] mpg_search exited ${code}: ${stderr.trim() || "(no stderr)"}`;
  }

  try {
    const parsed = JSON.parse(stdout);
    return JSON.stringify(parsed, null, 2);
  } catch {
    return stdout || stderr || "(no output)";
  }
}

// ─── mpg_stash ────────────────────────────────────────────────────────────────

const mpgStashSchema: Tool = {
  name: "mpg_stash",
  description:
    "Search and stash results in one shot. Runs mpg with a pattern and stores " +
    "the matching nodes under the given name in the mind palace. Retrieve later " +
    "via mpg_get_stash without paying search cost again.",
  input_schema: {
    type: "object" as const,
    properties: {
      name: {
        type: "string",
        description: "Name to store the stash under (must be unique in the palace).",
      },
      pattern: {
        type: "string",
        description: "Regex pattern to search for.",
      },
      in: {
        type: "array",
        items: { type: "string" },
        description: "Paths or directories to search in.",
      },
      effort: {
        type: "string",
        enum: ["quick", "normal", "deep"],
        description: "Effort preset. Default: normal.",
      },
      note: {
        type: "string",
        description: "Human-readable description of what this stash contains.",
      },
      tags: {
        type: "array",
        items: { type: "string" },
        description: "Tags to associate with this stash.",
      },
    },
    required: ["name", "pattern"],
  },
};

function mpgStashImpl(
  input: ToolInput,
  cwd: string,
  palacePath: string | undefined,
): string {
  const name = str(input["name"]);
  const pattern = str(input["pattern"]);
  if (!name) return "[error] mpg_stash: 'name' is required";
  if (!pattern) return "[error] mpg_stash: 'pattern' is required";

  const args: string[] = [pattern, "--mp-stash", name];

  const note = str(input["note"]);
  if (note) args.push(note);

  const paths = input["in"];
  if (Array.isArray(paths) && paths.length > 0) {
    args.push("--in", ...(paths as string[]));
  }

  const effort = str(input["effort"]);
  if (effort) args.push("--effort", effort);

  const tags = input["tags"];
  if (Array.isArray(tags)) {
    for (const t of tags as string[]) args.push("--mp-tag", t);
  }

  args.push("--no-color", ...palaceArgs(palacePath));

  const { stdout, stderr, code } = runMpg(args, cwd);
  if (code !== 0 && !stdout) {
    return `[error] mpg_stash exited ${code}: ${stderr.trim() || "(no stderr)"}`;
  }
  return stdout.trim() || `Stash '${name}' saved.`;
}

// ─── mpg_list_stashes ─────────────────────────────────────────────────────────

const mpgListStashesSchema: Tool = {
  name: "mpg_list_stashes",
  description:
    "List all named stashes currently held in the mind palace. " +
    "Use this to see what you have saved before retrieving or dropping.",
  input_schema: {
    type: "object" as const,
    properties: {},
  },
};

function mpgListStashesImpl(
  _input: ToolInput,
  cwd: string,
  palacePath: string | undefined,
): string {
  const args = ["--mp-list", "--no-color", ...palaceArgs(palacePath)];
  const { stdout, stderr, code } = runMpg(args, cwd);
  if (code !== 0 && !stdout) {
    return `[error] mpg_list_stashes exited ${code}: ${stderr.trim() || "(no stderr)"}`;
  }
  return stdout.trim() || "(no stashes)";
}

// ─── mpg_get_stash ────────────────────────────────────────────────────────────

const mpgGetStashSchema: Tool = {
  name: "mpg_get_stash",
  description:
    "Retrieve a named stash from the mind palace. Returns the stored nodes " +
    "without running a new search — recall is free in token cost.",
  input_schema: {
    type: "object" as const,
    properties: {
      name: {
        type: "string",
        description: "Name of the stash to retrieve.",
      },
    },
    required: ["name"],
  },
};

function mpgGetStashImpl(
  input: ToolInput,
  cwd: string,
  palacePath: string | undefined,
): string {
  const name = str(input["name"]);
  if (!name) return "[error] mpg_get_stash: 'name' is required";

  const args = ["--mp-get", name, "--no-color", ...palaceArgs(palacePath)];
  const { stdout, stderr, code } = runMpg(args, cwd);
  if (code !== 0 && !stdout) {
    return `[error] mpg_get_stash exited ${code}: ${stderr.trim() || "(no stderr)"}`;
  }
  return stdout.trim() || `(stash '${name}' is empty or not found)`;
}

// ─── mpg_drop_stash ───────────────────────────────────────────────────────────

const mpgDropStashSchema: Tool = {
  name: "mpg_drop_stash",
  description:
    "Free a named stash from the mind palace to reclaim the slot. " +
    "Use when you no longer need the stored results.",
  input_schema: {
    type: "object" as const,
    properties: {
      name: {
        type: "string",
        description: "Name of the stash to drop.",
      },
    },
    required: ["name"],
  },
};

function mpgDropStashImpl(
  input: ToolInput,
  cwd: string,
  palacePath: string | undefined,
): string {
  const name = str(input["name"]);
  if (!name) return "[error] mpg_drop_stash: 'name' is required";

  const args = ["--mp-drop", name, "--no-color", ...palaceArgs(palacePath)];
  const { stdout, stderr, code } = runMpg(args, cwd);
  if (code !== 0 && !stdout) {
    return `[error] mpg_drop_stash exited ${code}: ${stderr.trim() || "(no stderr)"}`;
  }
  return stdout.trim() || `Stash '${name}' dropped.`;
}

// ─── Exports ──────────────────────────────────────────────────────────────────

export const TREATMENT_MPG_SCHEMAS: Tool[] = [
  mpgSearchSchema,
  mpgStashSchema,
  mpgListStashesSchema,
  mpgGetStashSchema,
  mpgDropStashSchema,
];

export const ALL_TREATMENT_SCHEMAS: Tool[] = [
  ...CONTROL_TOOL_DEFS.map((d) => d.schema),
  ...TREATMENT_MPG_SCHEMAS,
];

/**
 * Build a dispatch map for all treatment-arm tools (control + mpg).
 * palacePath is captured in each mpg handler's closure.
 */
export function buildTreatmentDispatch(
  cwd: string,
  palacePath: string | undefined,
): Map<string, (input: ToolInput) => string> {
  const m = buildControlDispatch(cwd);

  const bind =
    (fn: (i: ToolInput, cwd: string, pp: string | undefined) => string) =>
    (input: ToolInput) =>
      fn(input, cwd, palacePath);

  m.set("mpg_search", bind(mpgSearchImpl));
  m.set("mpg_stash", bind(mpgStashImpl));
  m.set("mpg_list_stashes", bind(mpgListStashesImpl));
  m.set("mpg_get_stash", bind(mpgGetStashImpl));
  m.set("mpg_drop_stash", bind(mpgDropStashImpl));

  return m;
}

// Re-export control-arm items so callers only need to import from one place.
export { CONTROL_TOOL_DEFS, buildControlDispatch };
export type { ToolDef, ToolInput };
