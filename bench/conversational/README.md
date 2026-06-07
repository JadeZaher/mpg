# Conversational benchmark — Claude project memory archive

## What this measures

Real long-form conversational memory: 879 events of past Claude Code
sessions in this very project's archive (`~/.claude/projects/<project>/*.jsonl`).
The question we're answering: when an agent wants to recall something
discussed in a past conversation, which retrieval substrate works best?

## Substrates compared

| Substrate | Why include it |
| :--- | :--- |
| **mdg** | The system under test. Token-budgeted, node-windowed regex. |
| **ripgrep** (raw) | The fastest plain regex baseline. Returns whole lines — no context windowing, no token budget. |
| **PowerShell `Select-String`** | What a Windows user does by default if they don't have rg. Line-oriented. |
| **vector embeddings** (`Xenova/all-MiniLM-L6-v2`) | Semantic baseline. Top-k cosine over per-line documents. |

## Corpus

`~/.claude/projects/C--Users-atooz-Programming-ai-utils-memory-markdowngraphcli/*.jsonl`

Each JSONL line is one transcript event (user prompt, assistant
response, tool call, tool result, hook event, etc). Content lives
inside `.message.content` or `.content`. This is **exactly** the kind
of corpus an agent would have to recall against: structured but noisy,
nested JSON wrapping natural language.

This is the worst case for line-oriented grep tools because matches are
buried in JSON noise, and the best case for mdg because its
token-windowed node returns trimmed, readable context.

## Ground-truth queries

Hand-labeled in `queries.ts`. Each query has:

- `pattern` — regex fed to grep / mdg
- `prompt` — semantic phrasing for the embedding model
- `expected_uuids[]` — UUIDs of transcript events that are the right
  answer set, identified by inspection

The events we hand-label are non-secret (all in this session, all
already on disk in the user's archive — no new exposure).

## Metrics

| Metric | Definition |
| :--- | :--- |
| `recall` | `\|expected ∩ returned\| / \|expected\|` |
| `precision` | `\|expected ∩ returned\| / \|returned\|` |
| `F1` | Harmonic mean. |
| `tokens` | Approximate token cost of the returned context (the bytes an agent would have to pay to consume the answer). |
| `ms` | Wall-clock. |

Token cost is the load-bearing axis: vector top-k and raw grep can
both hit 100% recall, but the agent has to **read** the result, and
that reads is what costs.

## What we are NOT testing

- **Concurrency** (one query at a time).
- **Index freshness** (corpus is frozen for the run).
- **Streaming costs** (rg is reading the JSONL fresh every time; mdg
  too; the embedding index is built once up front and cached in
  memory).
- **Recall on never-discussed topics** (we'd just get noise from all
  substrates).

The macro benchmark (`bench/macro/`) is where actual agent task lift
gets measured. This bench is the "given perfect knowledge of what the
agent wants, which substrate gives it the cheapest answer?" question.
