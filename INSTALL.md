# mdg — Installation & Agent Integration Guide

mdg works with **any** coding agent. The integration path depends on how
the agent executes tools:

| Agent | Integration path | Difficulty |
| :--- | :--- | :--- |
| **Claude Desktop** | MCP server | Easy |
| **Claude API** | `claudeTools` import | Easy |
| **Gemini API / Studio** | `geminiTools` import | Easy |
| **Pi Agent** | SKILL.md + CLI | Easy |
| **Cline** (VS Code) | MCP server | Easy |
| **Windsurf** | MCP server | Easy |
| **Cursor** | Shell command or MCP | Medium |
| **Aider** | `/run` command | Easy |
| **Continue.dev** | MCP server | Easy |
| **Any agent that can shell out** | `npm install -g mdg-cli` | Trivial |

---

## Universal install (prerequisite for all agents)

```bash
# Requires Node 20+ and ripgrep
# Install ripgrep: https://github.com/BurntSushi/ripgrep#installation

npm install -g mdg-cli
# or from source:
git clone https://github.com/JadeZaher/mdg.git
cd mdg && npm install && npm run build && npm link

# Verify:
mdg --version
mdg --help
```

---

## Claude Desktop (MCP)

The easiest path. mdg ships an MCP server.

**1. Build the MCP server:**

```bash
cd path/to/mdg
npm run build
```

**2. Add to Claude Desktop's `mcp.json`:**

```json
{
  "mcpServers": {
    "mdg": {
      "command": "node",
      "args": [
        "path/to/mdg/dist/mcp-server.js"
      ]
    }
  }
}
```

On Windows, the config is at:
- `%APPDATA%\Claude\mcp.json`

On macOS:
- `~/Library/Application Support/Claude/mcp.json`

**3. Restart Claude Desktop.** You'll see 5 new tools:
`mdg_search`, `mdg_stash`, `mdg_list_stashes`, `mdg_get_stash`, `mdg_drop_stash`.

**4. Load the skill prompt** (optional but recommended):
Copy the content of `skills/mdg-context/SKILL.md` into your project's
Claude custom instructions or paste it at the start of a session. This
gives Claude the decision tree for effort levels, mind palace patterns,
and pagination.

---

## Claude API (tool_use)

Import the pre-built tool definitions:

```ts
import { claudeTools, search, stash, listStashes, getStash, dropStash } from "mdg";

// Register tools with Claude
const response = await anthropic.messages.create({
  model: "claude-sonnet-4-20250514",
  tools: [...claudeTools],
  // ... rest of your message
});

// Handle tool_use blocks:
if (block.type === "tool_use") {
  switch (block.name) {
    case "mdg_search":
      const result = await search(block.input);
      // Return result to Claude as tool_result
      break;
    case "mdg_list_stashes":
      const stashes = listStashes();
      break;
    // ... etc
  }
}
```

The `claudeTools` array is already shaped for Claude's API (each entry
has `type: "function"` and `function: { name, description, parameters }`).

---

## Gemini API / Google AI Studio

Import the Gemini-compatible definitions:

```ts
import { geminiTools, search, stash, listStashes } from "mdg";

const model = genAI.getGenerativeModel({
  model: "gemini-2.5-pro",
  tools: [{ functionDeclarations: geminiTools }],
});

const chat = model.startChat();
const result = await chat.sendMessage("Find TODOs in src/");
```

---

## Pi Agent

Pi has first-class support via a skill definition.

**1. Copy the skill:**

```bash
cp skills/mdg-context/SKILL.md ~/.pi/agent/skills/mdg-context/SKILL.md
```

**2. Ensure mdg is on PATH:**

```bash
npm link  # from the mdg repo
# or: npm install -g mdg-cli
```

**3. The skill auto-loads** when Pi is in a project where codebase
exploration is needed. Pi invokes `mdg` via the CLI with the guidance
from SKILL.md.

**4. Composes with other Pi skills:**
- `extension-orchestrator` (Pi-Horizon): mdg is a Grounding-phase tool
- `conductor-context`: use mdg to find task-ID references
- `subagent scout`: mdg complements scout for structured retrieval

---

## Cline (VS Code)

Cline supports MCP servers. Same setup as Claude Desktop:

**1. Build the MCP server** (see Claude Desktop section above).

**2. Add to Cline's MCP config:**

In Cline settings → MCP Servers, add:

```json
{
  "mdg": {
    "command": "node",
    "args": ["path/to/mdg/dist/mcp-server.js"]
  }
}
```

---

## Windsurf

Windsurf supports MCP servers. Same as Claude Desktop/Cline.

---

## Cursor

Cursor doesn't natively support custom tools or MCP, but there are two
approaches:

**Option A: Shell command in Composer**

In Cursor's Composer, use the terminal directly:

```
> mdg "TODO" --in src/ --effort quick --format json
```

The JSON output can be read directly by Cursor. Add this to your
`.cursorrules`:

```
When investigating the codebase, use the `mdg` CLI to search for
patterns with token-budgeted context. Example:
  mdg "pattern" --in src/ --effort quick --format json
```

**Option B: MCP bridge**

If you have an MCP-to-Cursor bridge (e.g., `cursor-mcp-bridge`),
point it at the mdg MCP server same as Claude Desktop.

---

## Aider

Aider supports `/run` for shell commands:

```
/run mdg "TODO" --in src/ --effort quick --format json
```

Add to your `.aider.conf.yml`:

```yaml
read: ["mdg_search.sh"]
```

Or create a small wrapper:

```bash
# save as mdg_search.sh
#!/bin/bash
mdg "$1" --in "${2:-.}" --effort "${3:-normal}" --format json
```

Then: `/run ./mdg_search.sh "TODO" src/ quick`

---

## Continue.dev

Supports MCP servers. Same setup as Claude Desktop/Cline.

---

## GitHub Copilot

Copilot's agent mode supports terminal commands. Use:

```
@terminal mdg "TODO" --in src/ --effort quick --format json
```

Copilot doesn't support custom tool registration, so you're limited to
pasting mdg's JSON output into the chat.

---

## Generic / any agent (shell-out)

If your agent can run shell commands, just use mdg on the CLI:

```bash
# Quick recon
mdg "auth|login" --in . --effort quick --format json

# Deep dive
mdg "session" --in src/ --effort deep --format json

# Stash for later
mdg "TODO" --in src/ --mp-stash my-todos "My TODO findings" --mp-tag review

# Compose stashes
mdg "TODO" --mp-compose stash-a stash-b --format json
```

All output formats (`--format llm|markdown|json|text`) are designed to
be consumed directly by an LLM.

---

## MCP server (for Claude Desktop, Cline, Windsurf, Continue.dev)

The MCP server exposes these tools:

| Tool | Description |
| :--- | :--- |
| `mdg_search` | Search files, command output, URLs for a regex pattern |
| `mdg_stash` | Save a result to the mind palace |
| `mdg_list_stashes` | List all stashes (filterable by tag) |
| `mdg_get_stash` | Show full contents of one stash |
| `mdg_drop_stash` | Remove a stash from the palace |

The server reads JSON-RPC from stdin and writes to stdout — no network
ports, no configuration beyond the `command` and `args` in the MCP config.

---

## Quick verification for any agent

```bash
# After installing, verify the agent can find mdg:
which mdg         # should show the path
mdg --version     # should print a current version (e.g. "mdg 0.2.4")
mdg --ls          # should list files in the current directory

# Quick search test:
echo "// TODO: test" > /tmp/mdg-verify.ts
mdg "TODO" --in /tmp/mdg-verify.ts --format json | grep '"status"'
# Should show: "status": "ok"
rm /tmp/mdg-verify.ts
```
