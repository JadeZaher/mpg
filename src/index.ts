#!/usr/bin/env node
/**
 * mdg — entry point.
 *
 * Wires together: arg parsing → source resolution → rg search → node
 * building → budget enforcement → (optional) mind-palace operations
 * → formatting → stdout.
 */

import { format } from "./format.js";
import { paginate } from "./pagination.js";
import { formatPalaceList, formatPalaceGet } from "./palace-format.js";
import {
  addStash,
  addRelation,
  removeRelation,
  getRelated,
  traversalGraph,
  composeToSources,
  exceptToSources,
  intersectToSources,
  defaultPalacePath,
  dropStash,
  getStash,
  listStashes,
  loadPalace,
  pruneExpired,
  pruneOlderThan,
  pruneKeep,
  pruneTag,
  pruneAll,
  savePalace,
} from "./mind-palace.js";
import { applyTotalBudget, applyWindowCurve, buildNode, loadSourceContent } from "./nodes.js";
import { runRg, RgError, RgNotFoundError } from "./rg.js";
import {
  captureCommand,
  getStdin,
  captureUrl,
  resolvePathSpecs,
  type ResolvedSource,
} from "./sources.js";
import { parseArgs, resolveConfig, HelpRequestedError, VersionRequestedError } from "./cli.js";
import { sampleMedianLineLength, WIDE_RECORD_MEDIAN_THRESHOLD } from "./api.js";
import type { Node, ResolvedConfig, Result, Source } from "./types.js";
import type { Stash } from "./mind-palace.js";

const VERSION = "0.2.3";

/**
 * Transform a literal pattern into a typo-tolerant regex by allowing
 * up to 2 extra characters between each consecutive letter pair.
 * `foo` becomes `f[^\n]{0,2}o[^\n]{0,2}o`. Cheap and effective for
 * single-word lookups; for multi-word patterns the user should
 * tokenize themselves (pass space-separated keywords and OR them).
 */
function fuzzyTransform(pat: string): string {
  // Don't touch patterns that already look regex-y — too risky to
  // transform something with anchors or character classes.
  if (/[\\^$.()\[\]{}|*+?]/.test(pat)) return pat;
  const chars = [...pat];
  if (chars.length < 2) return pat;
  return chars
    .map((c) => c.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
    .join("[^\\n]{0,2}");
}

async function main(): Promise<number> {
  // 1. Parse + resolve config.
  let config: ResolvedConfig;
  try {
    const raw = parseArgs(process.argv.slice(2));
    config = resolveConfig(raw);
  } catch (err) {
    if (err instanceof HelpRequestedError) {
      const { HELP } = await import("./cli.js");
      process.stdout.write(HELP);
      return 0;
    }
    if (err instanceof VersionRequestedError) {
      process.stdout.write(`mdg ${VERSION}\n`);
      return 0;
    }
    process.stderr.write(`mdg: ${(err as Error).message}\n`);
    process.stderr.write(`Run 'mdg --help' for usage.\n`);
    return 2;
  }

  // 2. Handle --ls / --tree (discovery command).
  if (config.ls) {
    const { execFileSync } = await import("node:child_process");
    try {
      const cwd = process.cwd();
      const out = execFileSync("rg", ["--files", "--no-messages", cwd], {
        encoding: "utf8",
        maxBuffer: 64 * 1024 * 1024,
      });
      process.stdout.write(out);
      return 0;
    } catch (err: any) {
      if (err.status === 1) { process.stdout.write(""); return 0; }
      process.stderr.write(`mdg: ${err.message}\n`);
      return 3;
    }
  }

  // 3. Handle mind-palace operations that don't require a search.
  const palacePath = config.mind_palace?.path ?? defaultPalacePath();
  const palace = loadPalace(palacePath);

  // Pruning operations.
  if (config.mind_palace?.prune_older_than) {
    const r = pruneOlderThan(palace, config.mind_palace.prune_older_than, config.mind_palace.prune_dry_run ?? false);
    if (!r.dry_run) savePalace(palacePath, palace);
    process.stdout.write(formatPruneResult(r));
    return 0;
  }
  if (config.mind_palace?.prune_keep !== undefined) {
    const r = pruneKeep(palace, config.mind_palace.prune_keep, config.mind_palace.prune_dry_run ?? false);
    if (!r.dry_run) savePalace(palacePath, palace);
    process.stdout.write(formatPruneResult(r));
    return 0;
  }
  if (config.mind_palace?.prune_tag) {
    const r = pruneTag(palace, config.mind_palace.prune_tag, config.mind_palace.prune_dry_run ?? false);
    if (!r.dry_run) savePalace(palacePath, palace);
    process.stdout.write(formatPruneResult(r));
    return 0;
  }
  if (config.mind_palace?.prune_all) {
    const r = pruneAll(palace, config.mind_palace.prune_confirm ?? false, config.mind_palace.prune_dry_run ?? false);
    if (!r.dry_run) savePalace(palacePath, palace);
    process.stdout.write(formatPruneResult(r));
    return 0;
  }
  // Auto-prune expired stashes (runs silently on every mp-list, mp-get, etc.)
  const expired = pruneExpired(palace, config.mind_palace?.prune_dry_run ?? false);
  if (expired.removed > 0 && !expired.dry_run) savePalace(palacePath, palace);

  if (config.mind_palace?.list) {
    const allStashes = listStashes(palace, config.mind_palace.list.tags);
    const { items: stashes, pagination } = paginate(allStashes, {
      page: config.page,
      pageSize: config.page_size,
      all: config.all,
    });
    process.stdout.write(formatPalaceList(stashes, palacePath, config.color, pagination));
    process.stdout.write("\n");
    return 0;
  }
  if (config.mind_palace?.get) {
    const stash = getStash(palace, config.mind_palace.get);
    if (!stash) {
      process.stderr.write(`mdg: no such stash: ${config.mind_palace.get}\n`);
      return 4;
    }
    const { items: pagedNodes, pagination } = paginate(stash.nodes, {
      page: config.page,
      pageSize: config.page_size,
      all: config.all,
    });
    const pagedStash: Stash = { ...stash, nodes: pagedNodes };
    process.stdout.write(formatPalaceGet(pagedStash, palacePath, config.color, pagination));
    process.stdout.write("\n");
    return 0;
  }
  if (config.mind_palace?.drop) {
    const ok = dropStash(palace, config.mind_palace.drop);
    if (!ok) {
      process.stderr.write(`mdg: no such stash: ${config.mind_palace.drop}\n`);
      return 4;
    }
    savePalace(palacePath, palace);
    process.stderr.write(`mdg: dropped stash "${config.mind_palace.drop}"\n`);
    return 0;
  }
  if (config.mind_palace?.link) {
    try {
      const rel = addRelation(palace, config.mind_palace.link.from, config.mind_palace.link.to, config.mind_palace.link.type, config.mind_palace.link.note);
      savePalace(palacePath, palace);
      process.stdout.write(formatRelationResult("linked", config.mind_palace.link, rel));
      return 0;
    } catch (err) {
      process.stderr.write(`mdg: ${(err as Error).message}\n`);
      return 4;
    }
  }
  if (config.mind_palace?.unlink) {
    try {
      removeRelation(palace, config.mind_palace.unlink.from, config.mind_palace.unlink.to);
      savePalace(palacePath, palace);
      process.stdout.write(`<mdg unlink from="${config.mind_palace.unlink.from}" to="${config.mind_palace.unlink.to}"/>\n`);
      return 0;
    } catch (err) {
      process.stderr.write(`mdg: ${(err as Error).message}\n`);
      return 4;
    }
  }
  if (config.mind_palace?.related) {
    const related = getRelated(palace, config.mind_palace.related);
    process.stdout.write(formatRelated(related, config.mind_palace.related));
    return 0;
  }
  if (config.mind_palace?.graph) {
    const graph = traversalGraph(palace, config.mind_palace.graph.name, config.mind_palace.graph.depth);
    process.stdout.write(formatGraph(graph, config.mind_palace.graph.name, config.mind_palace.graph.depth));
    return 0;
  }

  // 3. From this point on we need a search to run.
  if (!config.pattern) {
    process.stderr.write("mdg: a pattern is required for searches and --mp-stash/--mp-from/--mp-compose.\n");
    return 2;
  }

  // 4. If --mp-from / --mp-compose / --mp-except / --mp-intersect,
  // derive source list from the palace.
  const mp = config.mind_palace;
  if (mp?.from || mp?.compose || mp?.except || mp?.intersect) {
    try {
      let palaceSources: Source[];
      if (mp.from) {
        palaceSources = composeToSources(palace, [mp.from]);
      } else if (mp.compose) {
        palaceSources = composeToSources(palace, mp.compose);
      } else if (mp.except) {
        palaceSources = exceptToSources(palace, mp.except.base, mp.except.exclude);
      } else {
        palaceSources = intersectToSources(palace, mp.intersect!);
      }
      for (const s of palaceSources) {
        config.inputs.unshift({ type: "path", path: s.id });
      }
    } catch (err) {
      process.stderr.write(`mdg: ${(err as Error).message}\n`);
      return 4;
    }
  }

  // 5. Resolve inputs.
  const resolved = await resolveInputs(config.inputs);

  // 5b. Wide-record auto-tune. If the user didn't pass explicit
  // --before/--after and --no-auto-tune was not set, sample line
  // lengths from the resolved file sources. If the median is over the
  // wide-record threshold (typical of JSONL events), shrink before/after
  // to 0 so each node is just the matched line, not its neighbors.
  let beforeTokens = config.before_tokens;
  let afterTokens = config.after_tokens;
  let autoTuneApplied = false;
  if (config.auto_tune_eligible) {
    const fileIds: string[] = [];
    for (const rs of resolved) {
      if (rs.source.type === "file") fileIds.push(rs.source.id);
    }
    const median = sampleMedianLineLength(fileIds);
    if (median > WIDE_RECORD_MEDIAN_THRESHOLD) {
      beforeTokens = 0;
      afterTokens = 0;
      autoTuneApplied = true;
    }
  }

  // 6. Run the search.
  const t0 = Date.now();
  const allNodes: Node[] = [];
  const sourcesSeen = new Set<string>();
  // Per-line dedup when auto-tune fires. On wide-record corpora,
  // multiple matches within one line would otherwise emit one node per
  // match, each carrying the full (huge) line as match_text. We keep
  // the first node per (source, line) and drop duplicates.
  const seenLines = autoTuneApplied ? new Set<string>() : null;

  for (const rs of resolved) {
    try {
      const effectivePattern = config.fuzzy
        ? fuzzyTransform(config.pattern!)
        : config.pattern!;
      for await (const match of runRg(
        effectivePattern,
        rs.source,
        rs.content,
        config.rg_options,
      )) {
        if (allNodes.length >= config.max_nodes) break;
        if (seenLines) {
          const key = `${rs.source.id}:${match.line}`;
          if (seenLines.has(key)) continue;
          seenLines.add(key);
        }
        const content = loadSourceContent(rs.source, rs.content);
        const node = buildNode(match, content, {
          beforeTokens,
          afterTokens,
          clipChars: config.clip_chars,
        });
        allNodes.push(node);
        sourcesSeen.add(rs.source.id);
        if (allNodes.length >= config.max_nodes) break;
      }
    } catch (err) {
      if (err instanceof RgNotFoundError) {
        process.stderr.write(`mdg: ${err.message}\n`);
        return 3;
      }
      if (err instanceof RgError) {
        process.stderr.write(`mdg: ${err.message}\n`);
        continue;
      }
      throw err;
    }
    if (allNodes.length >= config.max_nodes) break;
  }

  // 6b. Optional ordering by source file mtime.
  if (config.sort === "recent" || config.sort === "oldest") {
    const { statSync } = await import("node:fs");
    const mtimes = new Map<string, number>();
    for (const n of allNodes) {
      const id = n.source.id;
      if (mtimes.has(id)) continue;
      if (n.source.type === "file") {
        try { mtimes.set(id, statSync(id).mtimeMs); } catch { mtimes.set(id, 0); }
      } else {
        mtimes.set(id, config.sort === "recent" ? -Infinity : Infinity);
      }
    }
    const dir = config.sort === "recent" ? -1 : 1;
    allNodes.sort((a, b) => {
      const ma = mtimes.get(a.source.id) ?? 0;
      const mb = mtimes.get(b.source.id) ?? 0;
      if (ma !== mb) return dir * (ma - mb);
      return (a.match_line ?? 0) - (b.match_line ?? 0);
    });
  }

  // 6c. Apply window-decay curve before total-budget enforcement.
  if (config.window_curve && config.window_curve !== "flat") {
    applyWindowCurve(allNodes, config.window_curve, beforeTokens, afterTokens);
  }

  // 7. Apply total token budget.
  const { nodes: budgetedNodes, truncated } = applyTotalBudget(
    allNodes,
    config.max_tokens,
    config.strategy,
  );

  // 8. Assign IDs.
  budgetedNodes.forEach((n, i) => { n.id = i + 1; });

  // 9. Apply pagination if requested. This slices the nodes AFTER
  // budgeting so the LLM sees consistent total_tokens / total_nodes
  // and can plan its pagination strategy from the metadata.
  const { items: pagedNodes, pagination } = paginate(budgetedNodes, {
    page: config.page,
    pageSize: config.page_size,
    all: config.all,
  });
  // Re-assign IDs for the paged view so they're 1..N within the page.
  pagedNodes.forEach((n, i) => { n.id = i + 1; });

  // 10. Build result with status, so LLMs can branch on outcome without
  //     parsing unstructured text.
  const resultSources = new Set(budgetedNodes.map((n) => n.source.id));
  const totalTokensResult = budgetedNodes.reduce((s, n) => s + n.tokens, 0);
  const pageTokensResult = pagedNodes.reduce((s, n) => s + n.tokens, 0);
  const status: Result["status"] =
    budgetedNodes.length === 0 ? "no_matches" :
    truncated ? "truncated" : "ok";

  const result: Result = {
    pattern: config.pattern!,
    effort: config.effort,
    strategy: config.strategy,
    status,
    total_nodes: budgetedNodes.length,
    total_tokens: totalTokensResult,
    page_tokens: pageTokensResult,
    sources_count: resultSources.size,
    truncated,
    nodes: pagedNodes,
    duration_ms: Date.now() - t0,
    before_tokens: beforeTokens,
    after_tokens: afterTokens,
    auto_tune_applied: autoTuneApplied || undefined,
    max_nodes: config.max_nodes,
    max_tokens: config.max_tokens,
    pagination,
  };

  // 10. If --mp-stash, save the result to the palace (BEFORE emitting,
  // so any error aborts cleanly without polluting the palace).
  let stashedAction: "created" | "replaced" | "merged" | null = null;
  if (config.mind_palace?.stash) {
    const stashSpec = config.mind_palace.stash;
    const { action } = addStash(
      palace,
      stashSpec.name,
      stashSpec.note,
      budgetedNodes,
      {
        pattern: config.pattern!,
        effort: config.effort,
        sources_count: resultSources.size,
      },
      [...resultSources],
      stashSpec.tags,
      { replace: stashSpec.replace, locations: config.mp_stash_locations, ttl: config.mind_palace?.ttl },
    );
    savePalace(palacePath, palace);
    stashedAction = action;
  }

  // 11. Format + emit.
  process.stdout.write(format(result, config.format, config.color));
  process.stdout.write("\n");

  // 12. Emit a side-channel confirmation for stashing so the LLM
  // harness can observe what happened without parsing the result body.
  if (stashedAction) {
    const s = config.mind_palace!.stash!;
    process.stderr.write(
      `mdg: ${stashedAction} stash "${s.name}" (${budgetedNodes.length} nodes, ${result.total_tokens} tokens) at ${palacePath}\n`,
    );
  }

  return budgetedNodes.length === 0 ? 1 : 0;
}

/** Format a relation result. */
function formatRelationResult(
  action: string,
  link: { from: string; to: string; type: string; note: string },
  rel: { type: string; note: string; created_at: string },
): string {
  return `<mdg relation action=${action} from="${link.from}" to="${link.to}" type="${rel.type}">
  ${link.from} --(${rel.type})--> ${link.to}
  ${rel.note ? `note: ${rel.note}\n` : ""}created: ${rel.created_at}
</mdg relation>\n`;
}

function formatRelated(
  related: Array<{ stash: { name: string; note: string; tags: string[] }; direction: "outbound" | "inbound"; relation: { type: string; note: string } }>,
  center: string,
): string {
  if (related.length === 0) {
    return `<mdg related name="${center}">No relationships found.</mdg related>\n`;
  }
  const out: string[] = [];
  out.push(`<mdg related name="${center}" count="${related.length}">`);
  for (const r of related) {
    const dir = r.direction === "outbound" ? `--> ${r.stash.name}` : `${r.stash.name} -->`;
    out.push(`  ${dir}  [${r.relation.type}]${r.relation.note ? ` "${r.relation.note}"` : ""}`);
  }
  out.push("</mdg related>");
  return out.join("\n");
}

function formatGraph(
  graph: Array<{ stash: { name: string; note: string }; depth: number; direction: "outbound" | "inbound"; via: string; relation: { type: string; note: string } }>,
  root: string,
  maxDepth: number,
): string {
  if (graph.length === 0) {
    return `<mdg graph name="${root}">No relationships found.</mdg graph>\n`;
  }
  const out: string[] = [];
  out.push(`<mdg graph name="${root}" nodes="${graph.length}" max_depth="${maxDepth}">`);
  for (const g of graph) {
    const indent = "  ".repeat(g.depth);
    const dir = g.direction === "outbound" ? "-->" : "<--";
    out.push(`${indent}[depth ${g.depth}] ${g.via} ${dir} ${g.stash.name}  [${g.relation.type}]${g.relation.note ? ` "${g.relation.note}"` : ""}`);
  }
  out.push("</mdg graph>");
  return out.join("\n");
}
function formatPruneResult(r: { removed: number; names: string[]; dry_run: boolean }): string {
  const tag = r.dry_run ? " (DRY RUN — nothing was deleted)" : "";
  if (r.removed === 0) {
    return `<mdg prune result removed=0>No stashes matched the prune criteria.${tag}</mdg prune>\n`;
  }
  const names = r.names.map((n) => `  - ${n}`).join("\n");
  return `<mdg prune result removed=${r.removed} dry_run=${r.dry_run}>\nRemoved stashes (${r.removed}):\n${names}\n${tag}\n</mdg prune>\n`;
}
async function resolveInputs(
  inputs: ResolvedConfig["inputs"],
  stdinContent?: string | null,
): Promise<ResolvedSource[]> {
  const out: ResolvedSource[] = [];
  const pathInputs = inputs.filter((i): i is { type: "path"; path: string } => i.type === "path");
  if (pathInputs.length > 0) {
    const specs = pathInputs.map((p) => p.path);
    const files = await resolvePathSpecs(specs, stdinContent);
    for (const f of files) {
      out.push({
        source: { id: f, type: "file" },
        content: null,
      });
    }
  }
  const content = stdinContent ?? await getStdin();
  for (const input of inputs) {
    if (input.type === "command") {
      const cmdContent = await captureCommand(input.command);
      const src: Source = { id: `cmd:${input.command}`, type: "command", label: `$ ${input.command}` };
      out.push({ source: src, content: cmdContent });
    } else if (input.type === "url") {
      const urlContent = await captureUrl(input.url);
      out.push({ source: { id: input.url, type: "url" }, content: urlContent });
    } else if (input.type === "stdin") {
      out.push({ source: { id: "stdin", type: "stdin" }, content });
    }
  }
  return out;
}

main().then(
  (code) => process.exit(code),
  (err) => {
    process.stderr.write(`mdg: unexpected error: ${(err as Error).stack ?? err}\n`);
    process.exit(99);
  },
);
