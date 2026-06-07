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
  composeToSources,
  exceptToSources,
  intersectToSources,
  defaultPalacePath,
  dropStash,
  getStash,
  listStashes,
  loadPalace,
  savePalace,
} from "./mind-palace.js";
import { applyTotalBudget, buildNode, loadSourceContent } from "./nodes.js";
import { runRg, RgError, RgNotFoundError } from "./rg.js";
import {
  captureCommand,
  getStdin,
  captureUrl,
  resolvePathSpecs,
  type ResolvedSource,
} from "./sources.js";
import { parseArgs, resolveConfig, HelpRequestedError, VersionRequestedError } from "./cli.js";
import type { Node, ResolvedConfig, Result, Source } from "./types.js";
import type { Stash } from "./mind-palace.js";

const VERSION = "0.1.0";

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

  // 6. Run the search.
  const t0 = Date.now();
  const allNodes: Node[] = [];
  const sourcesSeen = new Set<string>();

  for (const rs of resolved) {
    try {
      for await (const match of runRg(
        config.pattern!,
        rs.source,
        rs.content,
        config.rg_options,
      )) {
        if (allNodes.length >= config.max_nodes) break;
        const content = loadSourceContent(rs.source, rs.content);
        const node = buildNode(match, content, {
          beforeTokens: config.before_tokens,
          afterTokens: config.after_tokens,
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
    before_tokens: config.before_tokens,
    after_tokens: config.after_tokens,
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
      { replace: stashSpec.replace, locations: config.mp_stash_locations },
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

/** Resolve SourceInputs to concrete (source, content) pairs. */
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
