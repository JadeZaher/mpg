/**
 * Output formatters.
 *
 * The default `llm` format is designed to be both human-readable and
 * directly consumable by an LLM harness: clear delimiters, source
 * attribution, line numbers, and a summary footer. An LLM can paste
 * the entire output into its context and immediately know which file
 * each snippet came from.
 *
 * Other formats:
 *   - text:     raw, like rg -C output with file:line prefixes
 *   - markdown: GitHub-flavored markdown with code blocks
 *   - json:     structured for programmatic harness integration
 */

import type { Result, OutputFormat } from "./types.js";
import { paginationAnnotation, paginationTextNote } from "./pagination.js";

const RESET = "\x1b[0m";
const BOLD = "\x1b[1m";
const DIM = "\x1b[2m";
const FG_RED = "\x1b[31m";
const FG_CYAN = "\x1b[36m";
const FG_YELLOW = "\x1b[33m";

export function format(result: Result, fmt: OutputFormat, color: boolean): string {
  switch (fmt) {
    case "json":     return formatJson(result);
    case "markdown": return formatMarkdown(result, color);
    case "text":     return formatText(result, color);
    case "llm":      return formatLlm(result, color);
  }
}

function formatJson(result: Result): string {
  return JSON.stringify(result, null, 2);
}

function formatText(result: Result, color: boolean): string {
  const out: string[] = [];
  for (const node of result.nodes) {
    out.push("");
    out.push(colorize(color, BOLD + FG_CYAN, node.source.id) +
             colorize(color, DIM, `:${node.match_line}`));
    for (let i = 0; i < node.context_before.length; i++) {
      const lineNum = node.start_line + i;
      out.push(`${lineNum}  ${node.context_before[i]}`);
    }
    out.push(colorize(color, BOLD + FG_RED, `${node.match_line}  ${node.match_text}`));
    for (let i = 0; i < node.context_after.length; i++) {
      const lineNum = node.match_line + 1 + i;
      out.push(`${lineNum}  ${node.context_after[i]}`);
    }
    out.push(colorize(color, DIM, `~${node.tokens} tokens`));
  }
  if (result.truncated) {
    out.push("");
    out.push(colorize(color, FG_YELLOW, `[truncated: total token budget reached]`));
  }
  return out.join("\n");
}

function formatMarkdown(result: Result, color: boolean): string {
  const out: string[] = [];
  for (const node of result.nodes) {
    out.push(`### \`${node.source.id}\` line ${node.match_line}`);
    out.push("");
    const lang = inferLang(node.source.id);
    const lines: string[] = [];
    for (let i = 0; i < node.context_before.length; i++) {
      lines.push(`${node.start_line + i}  ${node.context_before[i]}`);
    }
    lines.push(`**${node.match_line}**  ${node.match_text}`);
    for (let i = 0; i < node.context_after.length; i++) {
      lines.push(`${node.match_line + 1 + i}  ${node.context_after[i]}`);
    }
    out.push("```" + lang);
    out.push(lines.join("\n"));
    out.push("```");
    out.push("");
    if (color) out.push(`*${node.tokens} tokens*`);
    else out.push(`_${node.tokens} tokens_`);
    out.push("");
  }
  if (result.truncated) {
    out.push(`> ⚠ Truncated to fit token budget.`);
  }
  return out.join("\n");
}

/**
 * The LLM-friendly default. This is what the tool is built for.
 *
 * Layout:
 *
 *   <mpg result pattern="X" nodes=3 tokens=1234 effort=normal strategy=fill>
 *   --- NODE 1 of 3 | src/file.ts:42 | ~380 tokens ---
 *   <code block with line numbers, match highlighted with >> prefix>
 *   --- NODE 2 of 3 | ...
 *   --- TOTAL ---
 *   3 nodes | ~1234 tokens | 2 sources | 234ms
 *   </mpg result>
 */
function formatLlm(result: Result, color: boolean): string {
  const out: string[] = [];
  const header = [
    `pattern="${result.pattern}"`,
    `status=${result.status}`,
    `nodes=${result.total_nodes}`,
    `tokens=~${result.total_tokens}`,
    result.page_tokens !== result.total_tokens
      ? `page_tokens=~${result.page_tokens}` : null,
    `effort=${result.effort}`,
    `strategy=${result.strategy}`,
    paginationAnnotation(result.pagination),
  ].filter(Boolean).join(" ");
  out.push(`<mpg result ${header.trim()}>`);

  for (const node of result.nodes) {
    out.push("");
    const meta = `NODE ${node.id} of ${result.total_nodes} | ${node.source.id}:${node.match_line} | ~${node.tokens} tokens`;
    out.push(`--- ${meta} ---`);

    // Build a code block with line numbers and match highlight.
    const startLine = node.start_line;
    const allLines: Array<{ num: number; text: string; isMatch: boolean }> = [];
    for (let i = 0; i < node.context_before.length; i++) {
      allLines.push({ num: startLine + i, text: node.context_before[i], isMatch: false });
    }
    allLines.push({ num: node.match_line, text: node.match_text, isMatch: true });
    for (let i = 0; i < node.context_after.length; i++) {
      allLines.push({ num: node.match_line + 1 + i, text: node.context_after[i], isMatch: false });
    }

    // Render with the match line prefixed by ">>" and the others by "  ".
    // Highlight the actual matched substring within the match line.
    const width = String(node.end_line).length;
    for (const line of allLines) {
      const numStr = String(line.num).padStart(width, " ");
      const marker = line.isMatch ? ">>" : "  ";
      const prefix = `${numStr} ${marker} `;
      if (line.isMatch && node.match_spans.length > 0 && color) {
        const [s, e] = node.match_spans[0];
        const before = line.text.slice(0, s);
        const hit = line.text.slice(s, e);
        const after = line.text.slice(e);
        out.push(prefix + before + colorize(color, BOLD + FG_YELLOW, hit) + after);
      } else if (line.isMatch) {
        const [s, e] = node.match_spans[0] ?? [0, 0];
        const before = line.text.slice(0, s);
        const hit = line.text.slice(s, e);
        const after = line.text.slice(e);
        out.push(prefix + before + `**${hit}**` + after);
      } else {
        out.push(prefix + line.text);
      }
    }
  }

  out.push("");
  out.push(`--- TOTAL ---`);
  const total = [
    `${result.total_nodes} node${result.total_nodes === 1 ? "" : "s"}`,
    `~${result.total_tokens} tokens`,
    `${result.sources_count} source${result.sources_count === 1 ? "" : "s"}`,
    `${result.duration_ms}ms`,
  ].join(" | ");
  out.push(total);
  if (result.truncated) {
    out.push(colorize(color, FG_YELLOW, `(truncated: hit --max-tokens budget)`));
  }
  if (result.pagination) {
    const nav = result.pagination.has_next ? " (more pages available — pass --page N)" : "";
    out.push(colorize(color, DIM, paginationTextNote(result.pagination) + nav));
  }
  out.push("</mpg result>");
  return out.join("\n");
}

function inferLang(path: string): string {
  if (path.endsWith(".ts") || path.endsWith(".tsx")) return "typescript";
  if (path.endsWith(".js") || path.endsWith(".jsx")) return "javascript";
  if (path.endsWith(".py")) return "python";
  if (path.endsWith(".rs")) return "rust";
  if (path.endsWith(".go")) return "go";
  if (path.endsWith(".md")) return "markdown";
  if (path.endsWith(".json")) return "json";
  if (path.endsWith(".yaml") || path.endsWith(".yml")) return "yaml";
  if (path.endsWith(".sh") || path.endsWith(".bash")) return "bash";
  if (path.endsWith(".sql")) return "sql";
  return "";
}

function colorize(useColor: boolean, code: string, text: string): string {
  if (!useColor) return text;
  return `${code}${text}${RESET}`;
}
