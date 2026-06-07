/**
 * Queries for the conversational benchmark.
 *
 * Each query has a regex `pattern` and a semantic `prompt`. The
 * ground-truth answer set is derived AT RUN TIME by literal grep on
 * the (frozen) corpus snapshot: rg's matches define the canonical
 * answer set.
 *
 * This makes rg the baseline against which everything else is
 * measured (rg gets 100% recall by definition). The interesting
 * questions become:
 *   - Does mdg cost fewer tokens to surface the same answer?
 *   - Does PowerShell match rg on a Windows host?
 *   - Does the embedding substrate recover hits when queried with
 *     a different (semantic) phrasing than the regex literal?
 *
 * The prompts are intentionally **not** verbatim restatements of the
 * pattern — they use surrounding vocabulary the model is likely to
 * have seen near the topic, the way an agent would phrase a recall.
 */

export interface QuerySpec {
  label: string;
  pattern: string;
  prompt: string;
}

export const QUERIES: QuerySpec[] = [
  {
    label: "expandGlobs Windows backslash bug",
    pattern: "expandGlobs",
    prompt: "the Windows path bug where fs.glob treats backslash as an escape",
  },
  {
    label: "registering the MCP server with Claude Code",
    pattern: "claude mcp add",
    prompt: "registering the mdg MCP server with Claude Code at user scope",
  },
  {
    label: "npm publish flow for v0.2.1",
    pattern: "npm publish",
    prompt: "publishing the v0.2.1 bug-fix to the npm registry",
  },
  {
    label: "adding the transformers.js embedding library",
    pattern: "Xenova",
    prompt: "installing the Xenova transformers library for local embeddings",
  },
  {
    label: "writeResult helper definition",
    pattern: "writeResult",
    prompt: "the helper that writes benchmark result JSON files under bench/results/",
  },
  {
    label: "embedBatch helper",
    pattern: "embedBatch",
    prompt: "the batch embedding helper that processes texts sequentially",
  },
];
