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

## Node subprocess wrapper (Windows-safe spawn)

This path is for agent extensions that wrap mpg as a child process from
Node (Pi extension, custom MCP wrapper, agent runner). It is **not** the
same as "CLI shell-out" — the difference is whether a shell is in the
loop. A shell hides the cross-platform shim correctly; `child_process.spawn`
does not.

Why this section exists: on Windows the npm-installed `mpg` is a `.cmd`
shim. `spawn("mpg", args)` fails with `EINVAL` (Node can't exec a
`.cmd`); `spawn("mpg", args, { shell: true })` lets cmd.exe mangle
argv on shell metacharacters. The canonical observed failure mode:
`'--stdin' is not recognized as an internal or external command`
followed by `mpg: Unknown argument: --git`.

The fix is to spawn `node` directly on mpg's resolved JS entry:

```ts
import { spawn } from "node:child_process";
import { entryPath } from "mind-palace-graph/entry";

const proc = spawn(process.execPath, [
  entryPath, "TODO", "--in", "src/", "--json",
], { stdio: ["ignore", "pipe", "pipe"] });
```

`process.execPath` is the running Node binary. No `.cmd`, no shell, no
argv mangling. Works identically on macOS, Linux, Windows.

If you can't import (e.g. you are in a non-Node host that still spawns
mpg as a subprocess), use the CLI equivalent:

```bash
mpg --print-entry
# /usr/local/lib/node_modules/mind-palace-graph/dist/index.js
```

Then `spawn` your Node interpreter on the printed path.

For regexes with shell metacharacters or untrusted input, write the
pattern to a temp file and pass `--pattern-file <path>` instead of the
positional argument. The pattern then never crosses argv:

```ts
import { writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "mpg-"));
const patternFile = join(dir, "p");
writeFileSync(patternFile, exoticRegex);

spawn(process.execPath, [
  entryPath, "--pattern-file", patternFile, "--in", "src/", "--json",
]);
```

A single trailing `\n` or `\r\n` is stripped. `--pattern-file` is
mutually exclusive with the positional pattern.

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
} from "mind-palace-graph";

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
Pi extension / custom Node subprocess wrapper?        → subprocess wrapper (spawn node on entryPath)
Aider, Cursor, shell-only agent, bash one-liners?     → CLI
Need relationships / prune / intersect right now?     → CLI (even from inside an MCP host)
```

The CLI and the subprocess wrapper look the same on POSIX. The split
matters on Windows: a shell can run the `.cmd` shim correctly; a raw
`spawn` cannot. If your code does the spawning, you're on the subprocess
path even if you think of it as "CLI".
