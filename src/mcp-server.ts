#!/usr/bin/env node
/**
 * Minimal MCP server for mdg.
 *
 * Exposes mdg as an MCP-compatible tool server. Drop this into
 * Claude Desktop, Cline, Windsurf, or any MCP client.
 *
 * Tools: mdg_search, mdg_stash, mdg_list_stashes, mdg_get_stash,
 *        mdg_drop_stash, mdg_discover (--ls)
 *
 * Usage:
 *   node mcp-server.js
 *   # or from the repo root:
 *   npx tsx mcp-server.ts
 *
 * Configuration (Claude Desktop mcp.json):
 *   {
 *     "mdg": {
 *       "command": "node",
 *       "args": ["path/to/mcp-server.js"]
 *     }
 *   }
 */

import { search, stash, listStashes, getStash, dropStash } from "./api.js";

// Re-use the tool definitions from api.ts for MCP tool listing.
import { claudeTools } from "./api.js";

// ─── Minimal MCP JSON-RPC loop ──────────────────────────────────────

interface JsonRpcRequest {
  jsonrpc: "2.0";
  id?: number | string;
  method: string;
  params?: Record<string, unknown>;
}

interface JsonRpcResponse {
  jsonrpc: "2.0";
  id?: number | string;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

const log = (...args: unknown[]) => process.stderr.write(`[mdg-mcp] ${args.join(" ")}\n`);

async function handleRequest(req: JsonRpcRequest): Promise<JsonRpcResponse> {
  switch (req.method) {
    case "initialize":
      return {
        jsonrpc: "2.0",
        id: req.id,
        result: {
          protocolVersion: "2024-11-05",
          capabilities: { tools: {} },
          serverInfo: { name: "mdg", version: "0.2.0" },
        },
      };

    case "notifications/initialized":
      return { jsonrpc: "2.0", result: {} };

    case "tools/list":
      return {
        jsonrpc: "2.0",
        id: req.id,
        result: { tools: claudeTools.map((t) => t.function) },
      };

    case "tools/call": {
      const params = req.params as { name: string; arguments?: Record<string, unknown> };
      if (!params) {
        return { jsonrpc: "2.0", id: req.id, error: { code: -32602, message: "Missing params" } };
      }
      try {
        const result = await callTool(params.name, params.arguments ?? {});
        return {
          jsonrpc: "2.0",
          id: req.id,
          result: { content: [{ type: "text", text: result }] },
        };
      } catch (err) {
        return {
          jsonrpc: "2.0",
          id: req.id,
          error: { code: -32000, message: (err as Error).message },
        };
      }
    }

    default:
      return { jsonrpc: "2.0", id: req.id, error: { code: -32601, message: `Unknown method: ${req.method}` } };
  }
}

async function callTool(name: string, args: Record<string, unknown>): Promise<string> {
  log(`tool call: ${name}`, JSON.stringify(args).slice(0, 200));

  switch (name) {
    case "mdg_search": {
      const result = await search({
        pattern: args.pattern as string,
        in: args.in as string[] | undefined,
        cmd: args.cmd as string | undefined,
        url: args.url as string | undefined,
        before: args.before as number | undefined,
        after: args.after as number | undefined,
        maxNodes: args.max_nodes as number | undefined,
        maxTokens: args.max_tokens as number | undefined,
        effort: args.effort as "quick" | "normal" | "deep" | "auto" | undefined,
        strategy: args.strategy as "fill" | "deep" | undefined,
        from: args.from as string | undefined,
        compose: args.compose as string[] | undefined,
        page: args.page as number | undefined,
        pageSize: args.page_size as number | undefined,
      });
      return JSON.stringify(result, null, 2);
    }

    case "mdg_stash": {
      // Run a search and stash the result in one call.
      if (!args.pattern) throw new Error("mdg_stash requires a pattern to search for.");
      const searchResult = await search({
        pattern: args.pattern as string,
        in: args.in as string[] | undefined,
        before: args.before as number | undefined,
        after: args.after as number | undefined,
        maxNodes: args.max_nodes as number | undefined,
        effort: args.effort as "quick" | "normal" | "deep" | "auto" | undefined,
      });
      const stashResult = await stash(searchResult, {
        name: args.name as string,
        note: (args.note as string) ?? "",
        tags: args.tags as string[] | undefined,
        replace: args.replace as boolean | undefined,
        palacePath: args.palace_path as string | undefined,
      });
      return JSON.stringify({ search: { total_nodes: searchResult.total_nodes, total_tokens: searchResult.total_tokens }, stash: stashResult }, null, 2);
    }

    case "mdg_list_stashes": {
      const result = listStashes(
        args.palace_path as string | undefined,
        args.tag_filter as string[] | undefined,
      );
      return JSON.stringify(result.map((s) => ({
        name: s.name,
        note: s.note,
        tags: s.tags,
        nodes_count: s.nodes.length,
        sources_count: s.sources.length,
        relations_count: s.relations.length,
        updated_at: s.updated_at,
        expires_at: s.expires_at,
      })), null, 2);
    }

    case "mdg_get_stash": {
      const result = getStash(
        args.name as string,
        args.palace_path as string | undefined,
      );
      if (!result) throw new Error(`No such stash: ${args.name}`);
      return JSON.stringify(result, null, 2);
    }

    case "mdg_drop_stash": {
      const ok = dropStash(
        args.name as string,
        args.palace_path as string | undefined,
      );
      return JSON.stringify({ dropped: ok, name: args.name });
    }

    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

// ─── Read JSON-RPC from stdin, write to stdout ──────────────────────

let buffer = "";

process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk: string) => {
  buffer += chunk;
  // Process complete JSON-RPC messages (separated by newlines)
  const lines = buffer.split("\n");
  buffer = lines.pop()!;
  for (const line of lines) {
    if (!line.trim()) continue;
    handleMessage(line);
  }
});

process.stdin.on("end", () => {
  if (buffer.trim()) handleMessage(buffer);
});

async function handleMessage(line: string) {
  let req: JsonRpcRequest;
  try {
    req = JSON.parse(line);
  } catch {
    log("invalid JSON:", line.slice(0, 100));
    return;
  }
  const resp = await handleRequest(req);
  process.stdout.write(JSON.stringify(resp) + "\n");
}

log("MCP server started. Waiting for requests on stdin...");
