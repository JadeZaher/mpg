/**
 * Treatment-arm tool implementations.
 *
 * Exports all four control tools plus five mind-palace tools that shell
 * out to the local mdg CLI:
 *
 *   mdg_search        — search the codebase, optionally stash
 *   mdg_stash         — search + stash in one shot
 *   mdg_list_stashes  — list all stashes in the palace
 *   mdg_get_stash     — retrieve a named stash
 *   mdg_drop_stash    — free a named stash
 *
 * Every mdg invocation passes --mp-path <palacePath> when palacePath is
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
const MDG_CLI = resolve(REPO_ROOT, "dist", "index.js");

// ─── mdg shell helper ─────────────────────────────────────────────────────────

interface MdgResult {
  stdout: string;
  stderr: string;
  code: number;
}

function runMdg(args: string[], cwd: string): MdgResult {
  const r = spawnSync("node", [MDG_CLI, ...args], {
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

// ─── mdg_search ───────────────────────────────────────────────────────────────

const mdgSearchSchema: Tool = {
  name: "mdg_search",
  description:
    "Search the codebase using mdg. Returns token-budgeted context nodes around " +
    "each match. Optionally stash the results via 'stash_name' for later recall " +
    "without re-searching.",
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
        description: "Paths, directories, or globs to search in.",
      },
      effort: {
        type: "string",
        enum: ["quick", "normal", "deep"],
        description:
          "Effort preset: quick=200t/10n, normal=500t/30n, deep=2000t/100n. Default: normal.",
      },
      max_nodes: {
        type: "number",
        description: "Maximum number of nodes to return.",
      },
      before: {
        type: "number",
        description: "Tokens of context before each match.",
      },
      after: {
        type: "number",
        description: "Tokens of context after each match.",
      },
      from: {
        type: "string",
        description:
          "Use a previously stashed file list as the search target (stash name).",
      },
      compose: {
        type: "array",
        items: { type: "string" },
        description: "Compose search across multiple stash file lists.",
      },
      stash_name: {
        type: "string",
        description:
          "If provided, stash results under this name in the mind palace. " +
          "Combine with stash_note / stash_tags.",
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

function mdgSearchImpl(
  input: ToolInput,
  cwd: string,
  palacePath: string | undefined,
): string {
  const pattern = str(input["pattern"]);
  if (!pattern) return "[error] mdg_search: 'pattern' is required";

  const args: string[] = [pattern, "--format", "json", "--no-color"];

  const paths = input["in"];
  if (Array.isArray(paths) && paths.length > 0) {
    args.push("--in", ...(paths as string[]));
  }

  const effort = str(input["effort"]);
  if (effort) args.push("--effort", effort);

  const maxNodes = input["max_nodes"];
  if (typeof maxNodes === "number") args.push("--max-nodes", String(maxNodes));

  const before = input["before"];
  if (typeof before === "number") args.push("--before", String(before));

  const after = input["after"];
  if (typeof after === "number") args.push("--after", String(after));

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

  const { stdout, stderr, code } = runMdg(args, cwd);
  if (code !== 0 && !stdout) {
    return `[error] mdg_search exited ${code}: ${stderr.trim() || "(no stderr)"}`;
  }

  try {
    const parsed = JSON.parse(stdout);
    return JSON.stringify(parsed, null, 2);
  } catch {
    return stdout || stderr || "(no output)";
  }
}

// ─── mdg_stash ────────────────────────────────────────────────────────────────

const mdgStashSchema: Tool = {
  name: "mdg_stash",
  description:
    "Search and stash results in one shot. Runs mdg with a pattern and stores " +
    "the matching nodes under the given name in the mind palace. Retrieve later " +
    "via mdg_get_stash without paying search cost again.",
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

function mdgStashImpl(
  input: ToolInput,
  cwd: string,
  palacePath: string | undefined,
): string {
  const name = str(input["name"]);
  const pattern = str(input["pattern"]);
  if (!name) return "[error] mdg_stash: 'name' is required";
  if (!pattern) return "[error] mdg_stash: 'pattern' is required";

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

  const { stdout, stderr, code } = runMdg(args, cwd);
  if (code !== 0 && !stdout) {
    return `[error] mdg_stash exited ${code}: ${stderr.trim() || "(no stderr)"}`;
  }
  return stdout.trim() || `Stash '${name}' saved.`;
}

// ─── mdg_list_stashes ─────────────────────────────────────────────────────────

const mdgListStashesSchema: Tool = {
  name: "mdg_list_stashes",
  description:
    "List all named stashes currently held in the mind palace. " +
    "Use this to see what you have saved before retrieving or dropping.",
  input_schema: {
    type: "object" as const,
    properties: {},
  },
};

function mdgListStashesImpl(
  _input: ToolInput,
  cwd: string,
  palacePath: string | undefined,
): string {
  const args = ["--mp-list", "--no-color", ...palaceArgs(palacePath)];
  const { stdout, stderr, code } = runMdg(args, cwd);
  if (code !== 0 && !stdout) {
    return `[error] mdg_list_stashes exited ${code}: ${stderr.trim() || "(no stderr)"}`;
  }
  return stdout.trim() || "(no stashes)";
}

// ─── mdg_get_stash ────────────────────────────────────────────────────────────

const mdgGetStashSchema: Tool = {
  name: "mdg_get_stash",
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

function mdgGetStashImpl(
  input: ToolInput,
  cwd: string,
  palacePath: string | undefined,
): string {
  const name = str(input["name"]);
  if (!name) return "[error] mdg_get_stash: 'name' is required";

  const args = ["--mp-get", name, "--no-color", ...palaceArgs(palacePath)];
  const { stdout, stderr, code } = runMdg(args, cwd);
  if (code !== 0 && !stdout) {
    return `[error] mdg_get_stash exited ${code}: ${stderr.trim() || "(no stderr)"}`;
  }
  return stdout.trim() || `(stash '${name}' is empty or not found)`;
}

// ─── mdg_drop_stash ───────────────────────────────────────────────────────────

const mdgDropStashSchema: Tool = {
  name: "mdg_drop_stash",
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

function mdgDropStashImpl(
  input: ToolInput,
  cwd: string,
  palacePath: string | undefined,
): string {
  const name = str(input["name"]);
  if (!name) return "[error] mdg_drop_stash: 'name' is required";

  const args = ["--mp-drop", name, "--no-color", ...palaceArgs(palacePath)];
  const { stdout, stderr, code } = runMdg(args, cwd);
  if (code !== 0 && !stdout) {
    return `[error] mdg_drop_stash exited ${code}: ${stderr.trim() || "(no stderr)"}`;
  }
  return stdout.trim() || `Stash '${name}' dropped.`;
}

// ─── Exports ──────────────────────────────────────────────────────────────────

export const TREATMENT_MDG_SCHEMAS: Tool[] = [
  mdgSearchSchema,
  mdgStashSchema,
  mdgListStashesSchema,
  mdgGetStashSchema,
  mdgDropStashSchema,
];

export const ALL_TREATMENT_SCHEMAS: Tool[] = [
  ...CONTROL_TOOL_DEFS.map((d) => d.schema),
  ...TREATMENT_MDG_SCHEMAS,
];

/**
 * Build a dispatch map for all treatment-arm tools (control + mdg).
 * palacePath is captured in each mdg handler's closure.
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

  m.set("mdg_search", bind(mdgSearchImpl));
  m.set("mdg_stash", bind(mdgStashImpl));
  m.set("mdg_list_stashes", bind(mdgListStashesImpl));
  m.set("mdg_get_stash", bind(mdgGetStashImpl));
  m.set("mdg_drop_stash", bind(mdgDropStashImpl));

  return m;
}

// Re-export control-arm items so callers only need to import from one place.
export { CONTROL_TOOL_DEFS, buildControlDispatch };
export type { ToolDef, ToolInput };
