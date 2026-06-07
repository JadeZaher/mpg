/**
 * Queries for the memory-corpus benchmark.
 *
 * Corpus: oasis-sleek conductor tracks (markdown specs + plans, JSON
 * metadata). Patterns are chosen to exist verbatim in the corpus so
 * recall is a well-defined number.
 *
 * Each query has a regex `pattern` (fed to regex substrates) and a
 * semantic `prompt` (fed to the embedding substrate). Ground truth is
 * derived AT RUN TIME by `rg <pattern> <corpus_root>` — rg's matches
 * define the canonical answer set, so rg gets 100% recall by definition
 * and the interesting axes become token cost, precision, and how well
 * embedding recovers literal hits when given a different phrasing.
 */

export interface QuerySpec {
  label: string;
  pattern: string;
  prompt: string;
}

export const QUERIES: QuerySpec[] = [
  {
    label: "AvatarController endpoints",
    pattern: "AvatarController",
    prompt: "the controller that handles avatar registration, authentication, and CRUD endpoints",
  },
  {
    label: "ProviderContext usage",
    pattern: "ProviderContext",
    prompt: "the unified context object passed to provider-aware handlers across the codebase",
  },
  {
    label: "JWT Bearer authentication",
    pattern: "JWT Bearer",
    prompt: "how endpoints authenticate via signed bearer tokens",
  },
  {
    label: "blockchain provider docs",
    pattern: "blockchain",
    prompt: "anywhere the design discusses on-chain or distributed-ledger provider integration",
  },
  {
    label: "rate limiting design",
    pattern: "rate.limit",
    prompt: "where the architecture talks about request throttling or per-tenant limits",
  },
  {
    label: "test coverage / strategy",
    pattern: "test.*coverage|coverage.*test",
    prompt: "where the docs lay out a testing strategy or coverage target",
  },
];
