/**
 * Formatters for mind-palace operations.
 *
 * Three outputs:
 *   - formatPalaceList: table of stashes (used by --mp-list)
 *   - formatPalaceGet:  full contents of a single stash (--mp-get)
 *   - formatPalaceStash: confirmation of a stash operation (unused
 *     currently; we emit the confirmation on stderr from the
 *     orchestrator so it doesn't pollute the search result)
 *
 * All formats are LLM-friendly: a header with palace path, structured
 * data, and clear delimiters.
 */

import type { Stash } from "./mind-palace.js";
import type { PaginationMeta } from "./pagination.js";
import { paginationAnnotation, paginationTextNote } from "./pagination.js";
import { formatRelativeTime } from "./mind-palace.js";

const RESET = "\x1b[0m";
const BOLD = "\x1b[1m";
const DIM = "\x1b[2m";
const FG_CYAN = "\x1b[36m";
const FG_YELLOW = "\x1b[33m";
const FG_GREEN = "\x1b[32m";

function c(useColor: boolean, code: string, text: string): string {
  if (!useColor) return text;
  return `${code}${text}${RESET}`;
}

/** Format the output of --mp-list. */
export function formatPalaceList(
  stashes: Stash[],
  palacePath: string,
  useColor: boolean,
  pagination?: PaginationMeta,
): string {
  const out: string[] = [];
  const ann = paginationAnnotation(pagination);
  out.push(`<mpg mind-palace path="${palacePath}" count="${stashes.length}"${ann}>`);
  if (stashes.length === 0 && !pagination) {
    out.push("");
    out.push(c(useColor, DIM, "(empty — no stashes. Use --mp-stash <name> <note> to create one.)"));
    out.push("");
    out.push("</mpg mind-palace>");
    return out.join("\n");
  }
  // Sort by updated_at descending so recent ones are first.
  const sorted = [...stashes].sort((a, b) => b.updated_at.localeCompare(a.updated_at));
  for (const s of sorted) {
    out.push("");
    out.push(`--- STASH ${c(useColor, BOLD + FG_CYAN, s.name)} ---`);
    out.push(`note:    ${s.note || c(useColor, DIM, "(no note)")}`);
    if (s.tags.length > 0) {
      out.push(`tags:    ${s.tags.map((t) => c(useColor, FG_GREEN, `#${t}`)).join(" ")}`);
    }
    out.push(`pattern: ${c(useColor, FG_YELLOW, s.search.pattern)}`);
    out.push(`effort:  ${s.search.effort}`);
    out.push(`nodes:   ${s.nodes.length}  |  sources: ${s.sources.length}`);
    if (s.relations.length > 0) {
      out.push(`links:   ${s.relations.length} relationship${s.relations.length === 1 ? "" : "s"}`);
    }
    const relTime = formatRelativeTime(s.updated_at);
    out.push(`updated: ${relTime} (${s.updated_at})`);
    if (s.expires_at) {
      out.push(`expires: ${formatRelativeTime(s.expires_at)}`);
    }
  }
  if (pagination) {
    out.push("");
    out.push(c(useColor, DIM, paginationTextNote(pagination) + (pagination.has_next ? " (more pages available — pass --page N)" : "")));
  }
  out.push("");
  out.push("</mpg mind-palace>");
  return out.join("\n");
}

/** Format the output of --mp-get <name>.
 *
 * `withNodes` controls whether the captured nodes block is rendered.
 * Default behavior (the **card view**) is `withNodes: false` — it
 * shows the synthesized intel (note, tags, relations, source paths,
 * counts) and skips the per-node context windows. This is what an
 * agent almost always wants when recalling a stash: 5–6× cheaper in
 * tokens than the legacy full dump. Pass `withNodes: true` (CLI:
 * `--with-nodes` or `--full`) to include the nodes block. Pagination
 * is honored only in the nodes mode. */
export function formatPalaceGet(
  stash: Stash,
  palacePath: string,
  useColor: boolean,
  pagination?: PaginationMeta,
  withNodes = false,
): string {
  const out: string[] = [];
  const ann = paginationAnnotation(pagination);
  const view = withNodes ? "full" : "card";
  out.push(`<mpg mind-palace-get name="${stash.name}" view="${view}" path="${palacePath}"${ann}>`);
  out.push("");
  out.push(c(useColor, BOLD, `STASH: ${stash.name}`));
  out.push(`note:     ${stash.note || c(useColor, DIM, "(no note)")}`);
  if (stash.tags.length > 0) {
    out.push(`tags:     ${stash.tags.join(", ")}`);
  }
  out.push(`created:  ${stash.created_at}`);
  out.push(`updated:  ${formatRelativeTime(stash.updated_at)} (${stash.updated_at})`);
  if (stash.expires_at) {
    out.push(`expires:  ${formatRelativeTime(stash.expires_at)} (${stash.expires_at})`);
  }
  out.push(`search:   pattern=${c(useColor, FG_YELLOW, stash.search.pattern)}  effort=${stash.search.effort}`);
  out.push(`nodes:    ${stash.nodes.length}  |  sources: ${stash.sources.length}`);
  out.push("");

  if (withNodes) {
    out.push("--- NODES ---");
    for (let i = 0; i < stash.nodes.length; i++) {
      const n = stash.nodes[i];
      out.push("");
      out.push(`[${i + 1}/${stash.nodes.length}] ${c(useColor, BOLD + FG_CYAN, n.source)}:${n.match_line}  (~${n.tokens}t)`);
      // Show the captured context window.
      const width = String(n.end_line).length;
      for (let j = 0; j < n.context_before.length; j++) {
        const lineNum = n.start_line + j;
        out.push(`  ${String(lineNum).padStart(width, " ")}    ${n.context_before[j]}`);
      }
      out.push(`  ${String(n.match_line).padStart(width, " ")} >> ${n.match_text}`);
      for (let j = 0; j < n.context_after.length; j++) {
        const lineNum = n.match_line + 1 + j;
        out.push(`  ${String(lineNum).padStart(width, " ")}    ${n.context_after[j]}`);
      }
    }
  }

  if (stash.sources.length > 0) {
    out.push("");
    out.push("--- SOURCES (file paths stashed; can be passed to --mp-from) ---");
    for (const s of stash.sources) {
      out.push(`  ${s}`);
    }
  }

  if (stash.relations.length > 0) {
    out.push("");
    out.push("--- RELATIONS ---");
    for (const r of stash.relations) {
      out.push(`  --> ${r.target}  [${r.type}]${r.note ? ` "${r.note}"` : ""}  (${formatRelativeTime(r.created_at)})`);
    }
  }

  if (!withNodes) {
    out.push("");
    out.push(c(useColor, DIM, "(card view — pass --with-nodes or --full to dump the captured node context)"));
  }
  if (pagination) {
    out.push("");
    out.push(c(useColor, DIM, paginationTextNote(pagination) + (pagination.has_next ? " (more pages available — pass --page N)" : "")));
  }

  out.push("");
  out.push("</mpg mind-palace-get>");
  return out.join("\n");
}

/** Confirmation of a stash operation. Emitted to stderr by the orchestrator. */
export function formatPalaceStash(
  action: "created" | "replaced" | "merged",
  name: string,
  nodeCount: number,
  tokens: number,
  palacePath: string,
): string {
  return `<mpg mind-palace-stash action="${action}" name="${name}" nodes="${nodeCount}" tokens="~${tokens}" path="${palacePath}"/>`;
}
