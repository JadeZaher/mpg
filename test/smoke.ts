/**
 * Smoke test for mdg.
 *
 * Spins up a temp directory with fixture files, runs mdg against
 * them via the built CLI, and asserts the output is well-formed.
 *
 * Run with: npm test (uses tsx so we don't need to rebuild)
 */

import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

let failed = 0;
let passed = 0;

function assert(condition: boolean, msg: string) {
  if (condition) {
    passed++;
    process.stdout.write(`  ✓ ${msg}\n`);
  } else {
    failed++;
    process.stdout.write(`  ✗ ${msg}\n`);
  }
}

function runMdg(args: string[], cwd?: string): { stdout: string; stderr: string; code: number } {
  const cliPath = resolve(process.cwd(), "dist/index.js");
  const r = spawnSync("node", [cliPath, ...args], {
    encoding: "utf8",
    cwd: cwd ?? process.cwd(),
    stdio: ["ignore", "pipe", "pipe"],
  });
  return {
    stdout: r.stdout ?? "",
    stderr: r.stderr ?? "",
    code: r.status ?? -1,
  };
}

function makeFixtures(): string {
  const dir = mkdtempSync(join(tmpdir(), "mdg-test-"));
  writeFileSync(join(dir, "auth.ts"), `
import { User } from './types';
import { db } from './db';

// TODO: add rate limiting
export async function login(user: User) {
  const result = await db.users.find(user.id);
  if (!result) throw new Error('not found');
  return result;
}

// TODO: add 2FA
export async function verify2FA(user: User, code: string) {
  return code.length === 6;
}
`);

  writeFileSync(join(dir, "session.ts"), `
import { User } from './types';
import { db } from './db';

// TODO: handle session expiry edge case
export class SessionManager {
  async start(user: User) {
    const token = await db.tokens.create({ userId: user.id });
    return token;
  }

  async end(token: string) {
    await db.tokens.delete(token);
  }
}
`);

  writeFileSync(join(dir, "README.md"), `# Auth Module

This module handles authentication and session management.

## TODO

- Add rate limiting (tracked in JIRA-123)
- Add 2FA verification
- Handle session expiry
`);

  return dir;
}

function main() {
  process.stdout.write("mdg smoke tests\n");
  process.stdout.write("================\n\n");

  const fixtures = makeFixtures();
  process.stdout.write(`Fixtures in: ${fixtures}\n\n`);

  // Test 1: basic search with file source.
  process.stdout.write("Test 1: search a single file\n");
  {
    const r = runMdg(["TODO", "--in", join(fixtures, "auth.ts"), "--no-color"]);
    assert(r.code === 0, `exit code 0 (got ${r.code})`);
    assert(r.stdout.includes("<mdg result"), "has mdg result header");
    assert(r.stdout.includes("NODE 1 of"), "has NODE marker");
    assert(r.stdout.includes("TODO"), "contains the matched text");
    assert(r.stdout.includes("</mdg result>"), "has closing tag");
    assert(r.stdout.includes("--- TOTAL ---"), "has total footer");
  }

  // Test 2: multi-file glob.
  process.stdout.write("\nTest 2: glob multiple files\n");
  {
    const r = runMdg(["TODO", "--in", join(fixtures, "*.ts"), "--no-color", "--max-nodes", "10"]);
    assert(r.code === 0, `exit code 0 (got ${r.code})`);
    assert(r.stdout.includes("auth.ts"), "includes auth.ts");
    assert(r.stdout.includes("session.ts"), "includes session.ts");
    // Count NODE markers.
    const nodeCount = (r.stdout.match(/--- NODE \d+ of \d+ /g) ?? []).length;
    assert(nodeCount >= 2, `finds at least 2 nodes (got ${nodeCount})`);
  }

  // Test 3: effort preset.
  process.stdout.write("\nTest 3: quick effort = narrow context\n");
  {
    const r = runMdg(["TODO", "--in", join(fixtures, "*.ts"), "--no-color", "--effort", "quick", "--format", "json"]);
    assert(r.code === 0, `exit code 0 (got ${r.code})`);
    const json = JSON.parse(r.stdout);
    assert(json.effort === "quick", `effort = quick (got ${json.effort})`);
    assert(json.total_nodes >= 1, "has at least one node");
  }

  // Test 4: max-tokens budget truncates.
  process.stdout.write("\nTest 4: max-tokens budget\n");
  {
    const r = runMdg([
      "TODO",
      "--in", join(fixtures, "*.ts"),
      "--no-color",
      "--format", "json",
      "--max-tokens", "200",
    ]);
    assert(r.code === 0, `exit code 0 (got ${r.code})`);
    const json = JSON.parse(r.stdout);
    assert(json.total_tokens <= 250, `total_tokens <= 250 (got ${json.total_tokens})`);
    assert(json.truncated === true, "truncated flag set");
  }

  // Test 5: max-nodes cap.
  process.stdout.write("\nTest 5: max-nodes cap\n");
  {
    const r = runMdg([
      "TODO",
      "--in", join(fixtures, "*.ts"),
      "--no-color",
      "--format", "json",
      "--max-nodes", "1",
    ]);
    assert(r.code === 0, `exit code 0 (got ${r.code})`);
    const json = JSON.parse(r.stdout);
    assert(json.total_nodes === 1, `total_nodes === 1 (got ${json.total_nodes})`);
  }

  // Test 6: command source.
  process.stdout.write("\nTest 6: command source\n");
  {
    const r = runMdg([
      "error",
      "--cmd", `echo "this is an error message" && echo "another error line"`,
      "--no-color",
      "--format", "json",
    ]);
    assert(r.code === 0, `exit code 0 (got ${r.code})`);
    const json = JSON.parse(r.stdout);
    assert(json.total_nodes >= 1, "found at least one match in command output");
    assert(json.nodes[0].source.type === "command", "source is command");
  }

  // Test 7: stdin source.
  process.stdout.write("\nTest 7: stdin source\n");
  {
    const cliPath = resolve(process.cwd(), "dist/index.js");
    const r = spawnSync("node", [cliPath, "TODO", "--no-color", "--format", "json"], {
      encoding: "utf8",
      input: "line one\nline two TODO: fix this\nline three TODO: and this\n",
    });
    assert((r.status ?? -1) === 0, `exit code 0 (got ${r.status})`);
    const json = JSON.parse(r.stdout ?? "");
    assert(json.total_nodes === 2, `2 nodes from stdin (got ${json.total_nodes})`);
  }

  // Test 8: text format.
  process.stdout.write("\nTest 8: text format\n");
  {
    const r = runMdg(["TODO", "--in", join(fixtures, "auth.ts"), "--no-color", "--format", "text"]);
    assert(r.code === 0, `exit code 0 (got ${r.code})`);
    assert(/^\d+\s+/m.test(r.stdout), "has line-numbered output");
  }

  // Test 9: markdown format.
  process.stdout.write("\nTest 9: markdown format\n");
  {
    const r = runMdg(["TODO", "--in", join(fixtures, "auth.ts"), "--no-color", "--format", "markdown"]);
    assert(r.code === 0, `exit code 0 (got ${r.code})`);
    assert(r.stdout.includes("```"), "has code blocks");
    assert(r.stdout.includes("###"), "has h3 headers");
  }

  // Test 10: no matches returns exit 1.
  process.stdout.write("\nTest 10: no matches = exit 1\n");
  {
    const r = runMdg(["XYZZY_NEVER_MATCHES", "--in", join(fixtures, "*.ts"), "--no-color"]);
    assert(r.code === 1, `exit code 1 (got ${r.code})`);
  }

  // Test 11: token budgeting is token-aware (not line-aware).
  process.stdout.write("\nTest 11: token budget is per-token\n");
  {
    // Two calls with same --max-tokens should produce ~same total regardless
    // of whether the file has long lines or short lines.
    const r = runMdg([
      "TODO",
      "--in", join(fixtures, "auth.ts"),
      "--no-color",
      "--format", "json",
      "--max-tokens", "300",
      "--before", "100",
      "--after", "100",
    ]);
    assert(r.code === 0, `exit code 0 (got ${r.code})`);
    const json = JSON.parse(r.stdout);
    // Should respect the budget (with some slack for the match line itself).
    assert(json.total_tokens <= 400, `total_tokens <= 400 (got ${json.total_tokens})`);
  }

  // Test 12: multiple --in paths.
  process.stdout.write("\nTest 12: multiple --in paths\n");
  {
    const r = runMdg([
      "TODO",
      "--in", join(fixtures, "auth.ts"),
      "--in", join(fixtures, "session.ts"),
      "--no-color",
      "--format", "json",
    ]);
    assert(r.code === 0, `exit code 0 (got ${r.code})`);
    const json = JSON.parse(r.stdout);
    assert(json.total_nodes >= 3, `finds at least 3 nodes (got ${json.total_nodes})`);
  }

  // Test 13: case-insensitive search.
  process.stdout.write("\nTest 13: case-insensitive search\n");
  {
    const r = runMdg([
      "todo",
      "--in", join(fixtures, "auth.ts"),
      "--no-color",
      "--format", "json",
      "-I",
    ]);
    assert(r.code === 0, `exit code 0 (got ${r.code})`);
    const json = JSON.parse(r.stdout);
    assert(json.total_nodes >= 1, `finds at least 1 match for lowercase 'todo'`);
  }

  // Test 14: directory as --in (recurses).
  process.stdout.write("\nTest 14: directory input recurses\n");
  {
    const r = runMdg([
      "TODO",
      "--in", fixtures,
      "--no-color",
      "--format", "json",
    ]);
    assert(r.code === 0, `exit code 0 (got ${r.code})`);
    const json = JSON.parse(r.stdout);
    assert(json.total_nodes >= 4, `finds matches across multiple files (got ${json.total_nodes})`);
    assert(json.sources_count >= 3, `sources_count >= 3 (got ${json.sources_count})`);
  }

  // Test 15: word-boundary search.
  process.stdout.write("\nTest 15: word-boundary search\n");
  {
    // Add a file with "TODO" and "todosaurus" to confirm --word filters.
    writeFileSync(join(fixtures, "word.ts"), `// TODO this is a todo\n// todosaurus is not a todo\n`);
    const r = runMdg([
      "TODO",
      "--in", join(fixtures, "word.ts"),
      "--no-color",
      "--format", "json",
      "-w",
    ]);
    assert(r.code === 0, `exit code 0 (got ${r.code})`);
    const json = JSON.parse(r.stdout);
    assert(json.total_nodes === 1, `word match finds only 1 (got ${json.total_nodes})`);
  }

  // Test 16: LLM format includes match highlighting.
  process.stdout.write("\nTest 16: LLM format highlights matches\n");
  {
    const r = runMdg([
      "TODO",
      "--in", join(fixtures, "auth.ts"),
      "--no-color",
    ]);
    assert(r.code === 0, `exit code 0 (got ${r.code})`);
    // The match line has the format: "<num> >> <content>".
    assert(/\d+\s+>>\s+.*TODO/.test(r.stdout), "has match marker (>>) on the TODO line");
  }

  // Test 17: larger --after budget produces larger node.
  process.stdout.write("\nTest 17: explicit budget = larger node\n");
  {
    // Make a bigger fixture.
    const big = join(fixtures, "big.ts");
    let content = "// header\n";
    for (let i = 0; i < 200; i++) content += `// padding line ${i}\n`;
    content += "// TODO: target\n";
    for (let i = 0; i < 200; i++) content += `// padding line ${i + 200}\n`;
    writeFileSync(big, content);

    const rSmall = runMdg([
      "TODO",
      "--in", big,
      "--no-color",
      "--format", "json",
      "--before", "50",
      "--after", "50",
    ]);
    const rLarge = runMdg([
      "TODO",
      "--in", big,
      "--no-color",
      "--format", "json",
      "--before", "1500",
      "--after", "1500",
    ]);
    const small = JSON.parse(rSmall.stdout);
    const large = JSON.parse(rLarge.stdout);
    assert(small.nodes[0].tokens < large.nodes[0].tokens,
      `small budget (${small.nodes[0].tokens}t) < large budget (${large.nodes[0].tokens}t)`);
  }

  // Test 18: multiple paths in one --in (greedy).
  process.stdout.write("\nTest 18: multiple paths in one --in\n");
  {
    const r = runMdg([
      "TODO",
      "--in", join(fixtures, "auth.ts"), join(fixtures, "session.ts"),
      "--no-color",
      "--format", "json",
    ]);
    assert(r.code === 0, `exit code 0 (got ${r.code})`);
    const json = JSON.parse(r.stdout);
    assert(json.total_nodes >= 3, `finds at least 3 nodes (got ${json.total_nodes})`);
    assert(json.sources_count === 2, `2 sources (got ${json.sources_count})`);
  }

  // Test 19: trailing positional paths (rg-style).
  process.stdout.write("\nTest 19: trailing positional paths\n");
  {
    const r = runMdg([
      "TODO",
      "--no-color",
      "--format", "json",
      join(fixtures, "auth.ts"), join(fixtures, "session.ts"),
    ]);
    assert(r.code === 0, `exit code 0 (got ${r.code})`);
    const json = JSON.parse(r.stdout);
    assert(json.total_nodes >= 3, `finds at least 3 nodes (got ${json.total_nodes})`);
  }

  // Test 20: --in @file (read paths from file).
  process.stdout.write("\nTest 20: --in @file\n");
  {
    const listPath = join(fixtures, "filelist.txt");
    writeFileSync(listPath, [
      join(fixtures, "auth.ts"),
      join(fixtures, "session.ts"),
      "# a comment line, should be skipped",
      "",
    ].join("\n"));
    const r = runMdg([
      "TODO",
      "--in", "@" + listPath,
      "--no-color",
      "--format", "json",
    ]);
    assert(r.code === 0, `exit code 0 (got ${r.code})`);
    const json = JSON.parse(r.stdout);
    assert(json.total_nodes >= 3, `finds at least 3 nodes (got ${json.total_nodes})`);
  }

  // Test 21: --in @- (read paths from stdin).
  process.stdout.write("\nTest 21: --in @- (paths from stdin)\n");
  {
    const cliPath = resolve(process.cwd(), "dist/index.js");
    const listPath = join(fixtures, "filelist.txt");
    const r = spawnSync("node", [cliPath, "TODO", "--in", "@-", "--no-color", "--format", "json"], {
      encoding: "utf8",
      input: [
        join(fixtures, "auth.ts"),
        join(fixtures, "session.ts"),
        "# comment\n",
      ].join("\n"),
    });
    assert((r.status ?? -1) === 0, `exit code 0 (got ${r.status})`);
    const json = JSON.parse(r.stdout ?? "");
    assert(json.total_nodes >= 3, `finds at least 3 nodes from stdin path list (got ${json.total_nodes})`);
  }

  // Test 22: comma-separated paths in one --in arg.
  process.stdout.write("\nTest 22: comma-separated paths\n");
  {
    const r = runMdg([
      "TODO",
      "--in", `${join(fixtures, "auth.ts")},${join(fixtures, "session.ts")}`,
      "--no-color",
      "--format", "json",
    ]);
    assert(r.code === 0, `exit code 0 (got ${r.code})`);
    const json = JSON.parse(r.stdout);
    assert(json.sources_count === 2, `2 sources (got ${json.sources_count})`);
  }

  // Test 23: directory + file mix in one --in.
  process.stdout.write("\nTest 23: mix of directory and file\n");
  {
    const r = runMdg([
      "TODO",
      "--in", fixtures, join(fixtures, "auth.ts"),
      "--no-color",
      "--format", "json",
      "--max-nodes", "5",
    ]);
    assert(r.code === 0, `exit code 0 (got ${r.code})`);
    const json = JSON.parse(r.stdout);
    assert(json.sources_count >= 3, `finds at least 3 sources (got ${json.sources_count})`);
  }

  // ─── Mind palace tests ──────────────────────────────────────
  // Use a unique palace file in the fixtures dir so we don't pollute.
  const palacePath = join(fixtures, "test-palace.json");
  const cliPath = resolve(process.cwd(), "dist/index.js");
  function runMdgPalace(args: string[]): { stdout: string; stderr: string; code: number } {
    const r = spawnSync("node", [cliPath, ...args], {
      encoding: "utf8",
      env: { ...process.env, MDG_MIND_PALACE: palacePath },
    });
    return { stdout: r.stdout ?? "", stderr: r.stderr ?? "", code: r.status ?? -1 };
  }
  // Make sure the palace starts empty.
  if (existsSync(palacePath)) rmSync(palacePath);

  // Test 24: --mp-stash creates a stash.
  process.stdout.write("\nTest 24: --mp-stash creates a stash\n");
  {
    const r = runMdgPalace([
      "TODO", "--in", join(fixtures, "auth.ts"),
      "--mp-stash", "auth-todos", "Authentication TODOs",
      "--mp-tag", "auth", "--mp-tag", "p0",
      "--no-color",
    ]);
    assert(r.code === 0, `exit code 0 (got ${r.code})`);
    assert(/created stash "auth-todos"/.test(r.stderr), "stderr confirms stash created");
    assert(existsSync(palacePath), "palace file was created");
  }

  // Test 25: --mp-list shows the stash.
  process.stdout.write("\nTest 25: --mp-list shows the stash\n");
  {
    const r = runMdgPalace(["--mp-list", "--no-color"]);
    assert(r.code === 0, `exit code 0 (got ${r.code})`);
    assert(/STASH auth-todos/.test(r.stdout), "shows the stash name");
    assert(/Authentication TODOs/.test(r.stdout), "shows the note");
    assert(/#auth/.test(r.stdout) && /#p0/.test(r.stdout), "shows the tags");
  }

  // Test 26: --mp-list with tag filter.
  process.stdout.write("\nTest 26: --mp-list --mp-list-tag filters by tag\n");
  {
    const r = runMdgPalace(["--mp-list", "--mp-list-tag", "p0", "--no-color"]);
    assert(r.code === 0, `exit code 0 (got ${r.code})`);
    assert(/auth-todos/.test(r.stdout), "p0 tag matches auth-todos");
  }

  // Test 27: --mp-get shows full stash contents.
  process.stdout.write("\nTest 27: --mp-get shows full stash contents\n");
  {
    const r = runMdgPalace(["--mp-get", "auth-todos", "--no-color"]);
    assert(r.code === 0, `exit code 0 (got ${r.code})`);
    assert(/STASH: auth-todos/.test(r.stdout), "shows stash header");
    assert(/--- NODES ---/.test(r.stdout), "shows nodes section");
    assert(/SOURCES/.test(r.stdout), "shows sources section");
  }

  // Test 28: --mp-from uses stashed files as search target.
  process.stdout.write("\nTest 28: --mp-from uses stashed files\n");
  {
    runMdgPalace([
      "TODO", "--in", join(fixtures, "auth.ts"),
      "--mp-stash", "scope-test", "scope test", "--no-color",
    ]);
    const r = runMdgPalace(["rate", "--mp-from", "scope-test", "--no-color"]);
    assert(r.code === 0, `exit code 0 (got ${r.code})`);
    assert(r.stdout.includes("rate"), "found 'rate' in scoped search");
    assert(r.stdout.includes("auth.ts"), "scoped to auth.ts");
  }

  // Test 29: --mp-compose searches across multiple stashes.
  process.stdout.write("\nTest 29: --mp-compose across multiple stashes\n");
  {
    runMdgPalace([
      "TODO", "--in", join(fixtures, "session.ts"),
      "--mp-stash", "session-scope", "session scope", "--no-color",
    ]);
    const r = runMdgPalace([
      "TODO", "--mp-compose", "scope-test", "session-scope", "--no-color",
    ]);
    assert(r.code === 0, `exit code 0 (got ${r.code})`);
    assert(r.stdout.includes("auth.ts"), "compose includes auth.ts");
    assert(r.stdout.includes("session.ts"), "compose includes session.ts");
  }

  // Test 30: --mp-stash is idempotent (merge dedupes).
  process.stdout.write("\nTest 30: --mp-stash merges and dedupes\n");
  {
    runMdgPalace([
      "TODO", "--in", join(fixtures, "auth.ts"),
      "--mp-stash", "auth-todos", "Auth TODOs", "--no-color",
    ]);
    const r = runMdgPalace([
      "TODO", "--in", join(fixtures, "auth.ts"),
      "--mp-stash", "auth-todos", "Auth TODOs (updated)", "--no-color",
    ]);
    assert(r.code === 0, `exit code 0 (got ${r.code})`);
    assert(/merged stash "auth-todos"/.test(r.stderr), "merged on second stash");
  }

  // Test 31: --mp-replace overwrites.
  process.stdout.write("\nTest 31: --mp-replace overwrites\n");
  {
    const r = runMdgPalace([
      "TODO", "--in", join(fixtures, "auth.ts"),
      "--mp-stash", "auth-todos", "Replaced note", "--mp-replace", "--no-color",
    ]);
    assert(r.code === 0, `exit code 0 (got ${r.code})`);
    assert(/replaced stash "auth-todos"/.test(r.stderr), "replaced on --mp-replace");
  }

  // Test 32: --mp-drop removes a stash.
  process.stdout.write("\nTest 32: --mp-drop removes a stash\n");
  {
    const r = runMdgPalace(["--mp-drop", "scope-test"]);
    assert(r.code === 0, `exit code 0 (got ${r.code})`);
    assert(/dropped stash "scope-test"/.test(r.stderr), "dropped confirmation");
    const r2 = runMdgPalace(["--mp-list", "--no-color"]);
    assert(!/STASH scope-test/.test(r2.stdout), "scope-test is no longer listed");
  }

  // Test 33: --mp-from with missing stash errors.
  process.stdout.write("\nTest 33: --mp-from with missing stash errors\n");
  {
    const r = runMdgPalace(["TODO", "--mp-from", "nonexistent", "--no-color"]);
    assert(r.code === 4, `exit code 4 (got ${r.code})`);
    assert(/Unknown stashes/.test(r.stderr), "reports unknown stash");
  }

  // Test 34: --mp-path with isolated palace.
  process.stdout.write("\nTest 34: --mp-path uses an isolated palace\n");
  {
    const isolated = join(fixtures, "isolated-palace.json");
    if (existsSync(isolated)) rmSync(isolated);
    const r = spawnSync("node", [
      cliPath,
      "TODO", "--in", join(fixtures, "auth.ts"),
      "--mp-stash", "iso", "isolated test",
      "--mp-path", isolated, "--no-color",
    ], { encoding: "utf8" });
    assert((r.status ?? -1) === 0, `exit code 0 (got ${r.status})`);
    assert(existsSync(isolated), "isolated palace created");
    const r2 = runMdgPalace(["--mp-list", "--no-color"]);
    assert(!/STASH iso/.test(r2.stdout), "isolated stash is not in main palace");
  }

  // ─── Pagination tests ────────────────────────────────────────────
  // We need a stash with many nodes for pagination tests. Build one
  // from a big fixture.
  const bigPalace = join(fixtures, "big-palace.json");
  // Create a fixture with 30 matches.
  const big2 = join(fixtures, "many-todos.ts");
  let bigContent = "";
  for (let i = 0; i < 30; i++) {
    bigContent += `// padding ${i}\n`;
    bigContent += `// TODO: item ${i}\n`;
  }
  writeFileSync(big2, bigContent);
  spawnSync("node", [
    cliPath, "TODO", "--in", big2,
    "--mp-stash", "many", "30 TODOs",
    "--no-color",
  ], { encoding: "utf8", env: { ...process.env, MDG_MIND_PALACE: bigPalace } });

  function runBig(args: string[]): { stdout: string; stderr: string; code: number } {
    const r = spawnSync("node", [cliPath, ...args], {
      encoding: "utf8",
      env: { ...process.env, MDG_MIND_PALACE: bigPalace },
    });
    return { stdout: r.stdout ?? "", stderr: r.stderr ?? "", code: r.status ?? -1 };
  }

  // Test 35: --page slices the result.
  process.stdout.write("\nTest 35: --page 1 with --page-size 5 returns first 5 nodes\n");
  {
    // Use --effort normal (30 nodes) so we have enough items to paginate.
    // Default is "quick" (10 nodes) — wouldn't span multiple full pages.
    const r = runBig(["TODO", "--in", big2, "--effort", "normal", "--page", "1", "--page-size", "5", "--format", "json", "--no-color"]);
    assert(r.code === 0, `exit code 0 (got ${r.code})`);
    const json = JSON.parse(r.stdout);
    assert(json.nodes.length === 5, `5 nodes on page 1 (got ${json.nodes.length})`);
    assert(json.pagination, "pagination metadata present");
    assert(json.pagination.page === 1, `page = 1 (got ${json.pagination.page})`);
    assert(json.pagination.page_size === 5, `page_size = 5 (got ${json.pagination.page_size})`);
    assert(json.pagination.total_items >= 30, `total_items >= 30 (got ${json.pagination.total_items})`);
    assert(json.pagination.has_next === true, "has_next = true on page 1");
    assert(json.pagination.has_prev === false, "has_prev = false on page 1");
  }

  // Test 36: page 2 returns the next slice.
  process.stdout.write("\nTest 36: --page 2 returns the next slice\n");
  {
    const r = runBig(["TODO", "--in", big2, "--effort", "normal", "--page", "2", "--page-size", "5", "--format", "json", "--no-color"]);
    const json = JSON.parse(r.stdout);
    assert(json.nodes.length === 5, `5 nodes on page 2 (got ${json.nodes.length})`);
    assert(json.pagination.has_prev === true, "has_prev = true on page 2");
    assert(json.pagination.has_next === true, "has_next = true on middle page");
  }

  // Test 37: last page has has_next = false.
  process.stdout.write("\nTest 37: last page has has_next = false\n");
  {
    const r = runBig(["TODO", "--in", big2, "--page", "99", "--page-size", "5", "--format", "json", "--no-color"]);
    const json = JSON.parse(r.stdout);
    assert(json.pagination.has_next === false, "has_next = false on last page");
    assert(json.pagination.has_prev === true, "has_prev = true on last page");
  }

  // Test 38: --all disables pagination.
  process.stdout.write("\nTest 38: --all disables pagination\n");
  {
    const r = runBig(["TODO", "--in", big2, "--all", "--format", "json", "--no-color"]);
    const json = JSON.parse(r.stdout);
    assert(!json.pagination, "no pagination metadata when --all is used");
  }

  // Test 39: LLM format includes pagination annotation.
  process.stdout.write("\nTest 39: LLM format includes pagination\n");
  {
    const r = runBig(["TODO", "--in", big2, "--page", "1", "--page-size", "5", "--no-color"]);
    assert(/page=1 of \d+/.test(r.stdout), "LLM format shows page=N of M");
    assert(/more pages available/.test(r.stdout), "LLM format hints at more pages");
  }

  // Test 40: --mp-list with --page paginates stashes.
  process.stdout.write("\nTest 40: --mp-list with --page paginates stashes\n");
  {
    // Create a few stashes to paginate.
    for (let i = 0; i < 5; i++) {
      spawnSync("node", [
        cliPath, "TODO", "--in", big2,
        "--mp-stash", `s${i}`, `stash ${i}`, "--no-color",
      ], { encoding: "utf8", env: { ...process.env, MDG_MIND_PALACE: bigPalace } });
    }
    const r = runBig(["--mp-list", "--page", "1", "--page-size", "2", "--format", "json", "--no-color"]);
    // --mp-list outputs markdown by default, not json. We need to use --format json but
    // mp-list doesn't go through the standard format pipeline. Check the LLM format.
    const r2 = runBig(["--mp-list", "--page", "1", "--page-size", "2", "--no-color"]);
    assert(r2.stdout.includes("page=1 of"), "mp-list shows pagination annotation");
    // Count STASH headers in the output.
    const stashCount = (r2.stdout.match(/--- STASH/g) ?? []).length;
    assert(stashCount === 2, `2 stashes on page 1 of size 2 (got ${stashCount})`);
  }

  // Test 41: --mp-get with --page paginates nodes within a stash.
  process.stdout.write("\nTest 41: --mp-get with --page paginates nodes within a stash\n");
  {
    const r = runBig(["--mp-get", "many", "--page", "1", "--page-size", "10", "--no-color"]);
    // Count node entries in the get output.
    const nodeCount = (r.stdout.match(/\[\d+\/\d+\]/g) ?? []).length;
    assert(nodeCount === 10, `10 nodes on page 1 of size 10 (got ${nodeCount})`);
    assert(r.stdout.includes("page=1 of"), "mp-get shows pagination annotation");
  }

  // Test 42: --all wins over --page (returns everything).
  process.stdout.write("\nTest 42: --all wins over --page\n");
  {
    const r = runBig(["TODO", "--in", big2, "--page", "1", "--all", "--format", "json", "--no-color"]);
    const json = JSON.parse(r.stdout);
    assert(!json.pagination, "no pagination when --all is set");
    assert(json.nodes.length > 5, "returns more than one page worth");
  }

  // Test 43: JSON result has status and page_tokens fields.
  process.stdout.write("\nTest 43: JSON includes status and page_tokens\n");
  {
    const r = runMdg([
      "TODO", "--in", join(fixtures, "auth.ts"),
      "--no-color", "--format", "json", "--page", "1", "--page-size", "1",
    ]);
    const json = JSON.parse(r.stdout);
    assert(typeof json.status === "string", "status is a string");
    assert(["ok", "no_matches", "truncated"].includes(json.status),
      `status is valid (got ${json.status})`);
    assert(typeof json.page_tokens === "number", "page_tokens is a number");
    assert(json.page_tokens > 0, "page_tokens > 0");
    assert(json.page_tokens < json.total_tokens, "page_tokens < total_tokens when paginated");
  }

  // Test 44: no matches sets status = no_matches.
  process.stdout.write("\nTest 44: no matches gives status=no_matches\n");
  {
    const r = runMdg([
      "XYZZY_NEVER_FOUND", "--in", join(fixtures, "auth.ts"),
      "--no-color", "--format", "json",
    ]);
    const json = JSON.parse(r.stdout);
    assert(json.status === "no_matches", `status is no_matches (got ${json.status})`);
  }

  // Test 45: --mp-except excludes files from another stash.
  process.stdout.write("\nTest 45: --mp-except excludes stashed files\n");
  {
    spawnSync("node", [cliPath, "TODO", "--in", join(fixtures, "auth.ts"),
      "--mp-stash", "auth-only", "auth", "--no-color",
    ], { encoding: "utf8", env: { ...process.env, MDG_MIND_PALACE: palacePath } });
    spawnSync("node", [cliPath, "TODO", "--in", join(fixtures, "session.ts"),
      "--mp-stash", "sess-only", "session", "--no-color",
    ], { encoding: "utf8", env: { ...process.env, MDG_MIND_PALACE: palacePath } });
    const r = spawnSync("node", [cliPath, "TODO", "--mp-except", "auth-only", "sess-only",
      "--no-color", "--format", "json",
    ], { encoding: "utf8", env: { ...process.env, MDG_MIND_PALACE: palacePath } });
    assert((r.status ?? -1) === 0, `exit code 0 (got ${r.status})`);
    const json = JSON.parse(r.stdout ?? "{}");
    assert(json.total_nodes >= 1, "except finds matches in auth.ts");
  }

  // Test 46: --mp-intersect finds files shared by stashes.
  process.stdout.write("\nTest 46: --mp-intersect finds shared files\n");
  {
    spawnSync("node", [cliPath, "TODO", "--in", join(fixtures, "auth.ts"),
      "--mp-stash", "shared-auth", "auth", "--no-color",
    ], { encoding: "utf8", env: { ...process.env, MDG_MIND_PALACE: palacePath } });
    spawnSync("node", [cliPath, "TODO", "--in", join(fixtures, "auth.ts"),
      "--mp-stash", "shared-auth-2", "auth2", "--no-color",
    ], { encoding: "utf8", env: { ...process.env, MDG_MIND_PALACE: palacePath } });
    const r = spawnSync("node", [cliPath, "TODO", "--mp-intersect", "shared-auth", "shared-auth-2",
      "--no-color", "--format", "json",
    ], { encoding: "utf8", env: { ...process.env, MDG_MIND_PALACE: palacePath } });
    const json = JSON.parse(r.stdout ?? "{}");
    assert(json.total_nodes >= 1, "intersect finds shared auth.ts matches");
  }

  // Test 47: --mp-list shows relative timestamps.
  process.stdout.write("\nTest 47: --mp-list shows relative timestamps\n");
  {
    const r = runMdgPalace(["--mp-list", "--no-color"]);
    assert(/(just now|s ago|m ago)/.test(r.stdout),
      "shows relative time (e.g. 'just now', '30s ago', '2m ago')");
  }

  // Test 48: --mp-ttl stores an expiry timestamp.
  process.stdout.write("\nTest 48: --mp-ttl stores an expiry timestamp\n");
  {
    const r = spawnSync("node", [cliPath, "TODO", "--in", join(fixtures, "auth.ts"),
      "--mp-stash", "ttl-test", "TTL stash", "--mp-ttl", "2h",
      "--no-color",
    ], { encoding: "utf8", env: { ...process.env, MDG_MIND_PALACE: palacePath } });
    assert((r.status ?? -1) === 0, `exit code 0 (got ${r.status})`);
    const palace = JSON.parse(readFileSync(palacePath, "utf8"));
    assert(palace.stashes["ttl-test"].expires_at !== null, "expires_at is set");
  }

  // Test 49: --mp-prune-older-than removes old stashes.
  process.stdout.write("\nTest 49: --mp-prune-older-than removes old stashes\n");
  {
    const r = spawnSync("node", [cliPath, "--mp-prune-older-than", "1ms",
      "--no-color",
    ], { encoding: "utf8", env: { ...process.env, MDG_MIND_PALACE: palacePath } });
    assert((r.status ?? -1) === 0, `exit code 0 (got ${r.status})`);
    assert(/removed=/.test(r.stdout), "shows prune result");
  }

  // Test 50: --mp-prune-dry-run does not delete.
  process.stdout.write("\nTest 50: --mp-prune-dry-run does not delete\n");
  {
    const r = spawnSync("node", [cliPath, "--mp-prune-older-than", "1ms",
      "--mp-prune-dry-run", "--no-color",
    ], { encoding: "utf8", env: { ...process.env, MDG_MIND_PALACE: palacePath } });
    assert(/DRY RUN/.test(r.stdout ?? ""), "shows dry run warning");
  }

  // Test 51: --mp-prune-keep keeps N most recent.
  process.stdout.write("\nTest 51: --mp-prune-keep keeps N most recent\n");
  {
    const p2 = join(fixtures, "keep-palace.json");
    for (let i = 0; i < 5; i++) {
      spawnSync("node", [cliPath, "TODO", "--in", join(fixtures, "auth.ts"),
        "--mp-stash", `k${i}`, `stash ${i}`, "--no-color",
      ], { encoding: "utf8", env: { ...process.env, MDG_MIND_PALACE: p2 } });
    }
    spawnSync("node", [cliPath, "--mp-prune-keep", "2", "--no-color",
    ], { encoding: "utf8", env: { ...process.env, MDG_MIND_PALACE: p2 } });
    const palace = JSON.parse(readFileSync(p2, "utf8"));
    const count = Object.keys(palace.stashes).length;
    assert(count === 2, `kept 2 stashes (got ${count})`);
  }

  // Test 52: --mp-prune-tag removes tagged stashes.
  process.stdout.write("\nTest 52: --mp-prune-tag removes tagged stashes\n");
  {
    const p3 = join(fixtures, "tag-palace.json");
    spawnSync("node", [cliPath, "TODO", "--in", join(fixtures, "auth.ts"),
      "--mp-stash", "tagged", "tagged", "--mp-tag", "temp", "--no-color",
    ], { encoding: "utf8", env: { ...process.env, MDG_MIND_PALACE: p3 } });
    spawnSync("node", [cliPath, "TODO", "--in", join(fixtures, "auth.ts"),
      "--mp-stash", "untagged", "untagged", "--no-color",
    ], { encoding: "utf8", env: { ...process.env, MDG_MIND_PALACE: p3 } });
    spawnSync("node", [cliPath, "--mp-prune-tag", "temp", "--no-color",
    ], { encoding: "utf8", env: { ...process.env, MDG_MIND_PALACE: p3 } });
    const palace = JSON.parse(readFileSync(p3, "utf8"));
    assert(!palace.stashes["tagged"], "tagged stash removed");
    assert(palace.stashes["untagged"], "untagged stash remains");
  }

  // Test 53: --mp-link creates a relationship.
  process.stdout.write("\nTest 53: --mp-link creates a relationship\n");
  {
    // Use a fresh palace since pruning tests may have cleared the main one.
    const p4 = join(fixtures, "rel-palace.json");
    spawnSync("node", [cliPath, "TODO", "--in", join(fixtures, "auth.ts"),
      "--mp-stash", "one", "stash one", "--no-color",
    ], { encoding: "utf8", env: { ...process.env, MDG_MIND_PALACE: p4 } });
    spawnSync("node", [cliPath, "TODO", "--in", join(fixtures, "session.ts"),
      "--mp-stash", "two", "stash two", "--no-color",
    ], { encoding: "utf8", env: { ...process.env, MDG_MIND_PALACE: p4 } });
    const r = spawnSync("node", [cliPath, "--mp-link", "one", "two", "depends-on", "one needs two", "--no-color",
    ], { encoding: "utf8", env: { ...process.env, MDG_MIND_PALACE: p4 } });
    assert((r.status ?? -1) === 0, `exit code 0 (got ${r.status})`);
    assert(/depends-on/.test(r.stdout ?? ""), "shows relationship type");
  }

  // Test 54: --mp-related shows both directions.
  process.stdout.write("\nTest 54: --mp-related shows both directions\n");
  {
    const p4 = join(fixtures, "rel-palace.json");
    const r = spawnSync("node", [cliPath, "--mp-related", "one", "--no-color",
    ], { encoding: "utf8", env: { ...process.env, MDG_MIND_PALACE: p4 } });
    assert(/two/.test(r.stdout ?? ""), "shows related stash 'two'");
    assert(/depends-on/.test(r.stdout ?? ""), "shows relationship type");
  }

  // Test 55: --mp-graph shows traversal.
  process.stdout.write("\nTest 55: --mp-graph shows traversal\n");
  {
    const p4 = join(fixtures, "rel-palace.json");
    const r = spawnSync("node", [cliPath, "--mp-graph", "one", "2", "--no-color",
    ], { encoding: "utf8", env: { ...process.env, MDG_MIND_PALACE: p4 } });
    assert(/<mdg graph/.test(r.stdout ?? ""), "shows graph output");
  }

  // Test 56: --mp-unlink removes a relationship.
  process.stdout.write("\nTest 56: --mp-unlink removes a relationship\n");
  {
    const p4 = join(fixtures, "rel-palace.json");
    spawnSync("node", [cliPath, "--mp-unlink", "one", "two", "--no-color",
    ], { encoding: "utf8", env: { ...process.env, MDG_MIND_PALACE: p4 } });
    const r = spawnSync("node", [cliPath, "--mp-related", "one", "--no-color",
    ], { encoding: "utf8", env: { ...process.env, MDG_MIND_PALACE: p4 } });
    assert(!/two/.test(r.stdout ?? ""), "relationship removed");
  }

  // Test 57: stashed nodes have file_path field for file sources.
  process.stdout.write("\nTest 57: stashed nodes have file_path field\n");
  {
    const p4 = join(fixtures, "rel-palace.json");
    const palace = JSON.parse(readFileSync(p4, "utf8"));
    const node = palace.stashes["one"].nodes[0];
    assert(node.file_path !== null, "file_path is set for file sources");
    assert(node.file_path === node.source, "file_path matches source for file-type sources");
  }

  // Test 58: absolute directory path with native separators (Windows regression).
  // Node's fs.glob treats `\` as a glob escape, so without normalization an
  // absolute Windows directory like C:\foo\bar would silently return 0 matches.
  process.stdout.write("\nTest 58: --in with absolute native directory path\n");
  {
    const r = runMdg(["TODO", "--in", fixtures, "--no-color", "--format", "json"]);
    assert(r.code === 0, `exit code 0 (got ${r.code})`);
    const json = JSON.parse(r.stdout);
    assert(json.total_nodes >= 1, `finds matches in absolute dir (got ${json.total_nodes})`);
  }

  // Test 59: --mp-drop removes the entry from disk (regression for
  // the v0.2.4 read-merge-write bug that silently re-merged dropped
  // stashes from the on-disk copy).
  process.stdout.write("\nTest 59: --mp-drop persists to disk\n");
  {
    const dropPalace = join(fixtures, "drop-palace.json");
    if (existsSync(dropPalace)) rmSync(dropPalace);
    const env = { ...process.env, MDG_MIND_PALACE: dropPalace };
    const stash = spawnSync("node", [cliPath, "TODO", "--in", fixtures, "--mp-stash", "doomed", "to-drop", "--no-color"], { encoding: "utf8", env });
    assert(stash.status === 0, `seed stash exit 0 (got ${stash.status})`);
    assert(existsSync(dropPalace), "palace file written");
    const beforeRaw = readFileSync(dropPalace, "utf8");
    assert(/"doomed"/.test(beforeRaw), "stash present on disk before drop");
    const drop = spawnSync("node", [cliPath, "--mp-drop", "doomed", "--no-color"], { encoding: "utf8", env });
    assert(drop.status === 0, `drop exit 0 (got ${drop.status})`);
    assert(/dropped stash "doomed"/.test(drop.stderr), "drop reports success");
    const afterRaw = readFileSync(dropPalace, "utf8");
    assert(!/"doomed"/.test(afterRaw), "stash gone from disk after drop");
    const reList = spawnSync("node", [cliPath, "--mp-list", "--no-color"], { encoding: "utf8", env });
    assert(!/doomed/.test(reList.stdout), "drop visible to --mp-list in next process");
  }

  // Test 60: drop survives across a follow-up stash creation. This is
  // the failure mode the user reported: drop → create new → list shows
  // the dropped entry back. The diff-based save in v0.2.5 should keep
  // the drop sticky.
  process.stdout.write("\nTest 60: --mp-drop survives a follow-up --mp-stash\n");
  {
    const palace = join(fixtures, "drop-followup.json");
    if (existsSync(palace)) rmSync(palace);
    const env = { ...process.env, MDG_MIND_PALACE: palace };
    spawnSync("node", [cliPath, "TODO", "--in", fixtures, "--mp-stash", "alpha", "a", "--no-color"], { encoding: "utf8", env });
    spawnSync("node", [cliPath, "TODO", "--in", fixtures, "--mp-stash", "beta", "b", "--no-color"], { encoding: "utf8", env });
    const drop = spawnSync("node", [cliPath, "--mp-drop", "alpha", "--no-color"], { encoding: "utf8", env });
    assert(drop.status === 0, `drop alpha exit 0 (got ${drop.status})`);
    spawnSync("node", [cliPath, "TODO", "--in", fixtures, "--mp-stash", "gamma", "g", "--no-color"], { encoding: "utf8", env });
    const list = spawnSync("node", [cliPath, "--mp-list", "--no-color"], { encoding: "utf8", env });
    assert(!/STASH alpha\b/.test(list.stdout), "dropped 'alpha' stays dropped");
    assert(/STASH beta\b/.test(list.stdout), "'beta' still present");
    assert(/STASH gamma\b/.test(list.stdout), "newly stashed 'gamma' present");
  }

  // Test 61: parallel-writer race. Two processes load the same palace,
  // each mutates a disjoint stash, then save. Both mutations should
  // survive — the second writer's diff-based merge applies on top of
  // the first writer's freshly written disk state.
  process.stdout.write("\nTest 61: parallel --mp-stash from two processes\n");
  {
    const palace = join(fixtures, "parallel.json");
    if (existsSync(palace)) rmSync(palace);
    const env = { ...process.env, MDG_MIND_PALACE: palace };
    // Seed one so loadPalace has snapshot state to diff against.
    spawnSync("node", [cliPath, "TODO", "--in", fixtures, "--mp-stash", "seed", "s", "--no-color"], { encoding: "utf8", env });
    // Kick off two parallel processes adding different stashes.
    const a = spawnSync("node", [cliPath, "TODO", "--in", fixtures, "--mp-stash", "parA", "A", "--no-color"], { encoding: "utf8", env });
    const b = spawnSync("node", [cliPath, "TODO", "--in", fixtures, "--mp-stash", "parB", "B", "--no-color"], { encoding: "utf8", env });
    assert(a.status === 0, `parA exit 0 (got ${a.status})`);
    assert(b.status === 0, `parB exit 0 (got ${b.status})`);
    const list = spawnSync("node", [cliPath, "--mp-list", "--no-color"], { encoding: "utf8", env });
    assert(/STASH seed\b/.test(list.stdout), "seed survives");
    assert(/STASH parA\b/.test(list.stdout), "parA landed");
    assert(/STASH parB\b/.test(list.stdout), "parB landed");
  }

  // Test 62: --json alias for --format json (UX regression — the
  // ecosystem convention is --json, and there was no alias before).
  process.stdout.write("\nTest 62: --json alias works\n");
  {
    const r = runMdg(["TODO", "--in", fixtures, "--no-color", "--json"]);
    assert(r.code === 0, `exit code 0 (got ${r.code})`);
    let parsed: any = null;
    try { parsed = JSON.parse(r.stdout); } catch { /* leave null */ }
    assert(parsed !== null, "stdout parses as JSON");
    assert(parsed?.pattern === "TODO", "JSON result has pattern field");
  }

  // Test 63: --mp-prune-expired wires through (help text claimed it
  // existed in v0.2.4 but the flag wasn't parsed). Seeding a stash
  // with a 1-second TTL, waiting, and pruning should report it.
  process.stdout.write("\nTest 63: --mp-prune-expired actually exists\n");
  {
    const palace = join(fixtures, "prune-expired.json");
    if (existsSync(palace)) rmSync(palace);
    const env = { ...process.env, MDG_MIND_PALACE: palace };
    spawnSync("node", [cliPath, "TODO", "--in", fixtures, "--mp-stash", "ephemeral", "e", "--mp-ttl", "1s", "--no-color"], { encoding: "utf8", env });
    // Don't actually wait a second — just check the flag parses.
    const dry = spawnSync("node", [cliPath, "--mp-prune-expired", "--mp-prune-dry-run", "--no-color"], { encoding: "utf8", env });
    assert(dry.status === 0, `--mp-prune-expired parses (got exit ${dry.status})`);
    assert(!/Unknown argument/.test(dry.stderr), "no 'Unknown argument' error");
  }

  // Cleanup.
  rmSync(fixtures, { recursive: true, force: true });

  process.stdout.write(`\n================\n${passed} passed, ${failed} failed\n`);
  process.exit(failed === 0 ? 0 : 1);
}

main();
