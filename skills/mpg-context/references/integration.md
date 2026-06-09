# mpg Integration Paths

mpg works through three different surfaces. Pick the one that matches
how your agent calls tools.

| Path | Best for | Cost |
| :--- | :--- | :--- |
| **MCP server** | Claude Desktop, Claude Code, Cline, Windsurf, Continue.dev | One-time config; auto-discovery of tools |
| **CLI shell-out** | Any agent that can `Bash`/`exec` | One-time `npm install -g`; no tool registration |
| **Programmatic import** | Custom Anthropic / Google SDK agents | TS/JS import; full type safety |

## MCP server

mpg ships an MCP server that exposes the five core tools over stdio.
No network ports, no extra config beyond the launch command.

```json
{
  "mcpServers": {
    "mpg": {
      "command": "node",
      "args": ["<path-to-global-install>/dist/mcp-server.js"]
    }
  }
}
```

For Claude Code, register via the CLI (recommended, user scope makes it
available across all projects):

```bash
claude mcp add --scope user mpg -- node "<global-install>/dist/mcp-server.js"
```

The exposed tools are `mpg_search`, `mpg_stash`, `mpg_list_stashes`,
`mpg_get_stash`, `mpg_drop_stash`. The wider mind-palace surface
(relationships, prune, intersect, etc.) is **not** available through
MCP today — drop to CLI for those.

## CLI shell-out

Any agent that can run a shell command can use mpg directly:

```bash
mpg "TODO" --in src/ --effort quick --format json
```

The `--format json` output is designed for machine consumption: it
includes `status`, `nodes[]`, `pagination`, `total_nodes`, etc. — feed
it back into the agent as the tool result.

When to prefer CLI over MCP:

- You need a flag that isn't exposed as an MCP tool (relationships,
  prune, intersect, except, TTL).
- You're chaining mpg with other shell tools (e.g.
  `mpg "errors" --cmd "git log -100" --mp-stash recent`).
- You want a quick recon and the MCP roundtrip is overkill.

When to prefer MCP over CLI:

- You want the tool name visible to the model in its tool list (helps
  with tool selection).
- You're running in a host that doesn't auto-allow `mpg` in Bash
  permissions (MCP bypasses Bash permission prompts).

## Programmatic import

For TS/Node agents that embed mpg directly:

```ts
import {
  search,
  stash,
  listStashes,
  getStash,
  dropStash,
  claudeTools,
  geminiTools,
} from "mpg-cli";

// Run a search
const result = await search({
  pattern: "TODO",
  in: ["src/"],
  effort: "quick",
  page: 1,
  pageSize: 5,
});

// Stash it for later composition
await stash(result, {
  name: "auth-todos",
  note: "Auth TODOs to review",
  tags: ["auth", "p0"],
});

// Register with Anthropic SDK
const response = await anthropic.messages.create({
  model: "claude-sonnet-4-6",
  tools: [...claudeTools],
  // ...
});

// Or Google SDK
const model = genAI.getGenerativeModel({
  model: "gemini-2.5-pro",
  tools: [{ functionDeclarations: geminiTools }],
});
```

Pre-built tool schemas are exported as `claudeTools` and `geminiTools`.
Each entry is shaped for its respective provider — no manual schema
authoring needed.

## Quick decision

```
Claude Desktop / Code / Cline / Windsurf / Continue?  → MCP
Custom Anthropic / Google SDK agent in TS/Node?       → import
Pi agent, Aider, Cursor, shell-only agent?            → CLI
Need relationships / prune / intersect right now?     → CLI (even from inside an MCP host)
```
