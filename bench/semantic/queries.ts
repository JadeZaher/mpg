/**
 * Queries for the semantic-recall benchmark.
 *
 * KEY DISTINCTION from bench/conversational:
 *
 *   conversational: all substrates get the SAME pattern. Ground truth
 *   is whatever rg finds. Regex substrates win by construction.
 *
 *   semantic: substrates receive DIFFERENT inputs.
 *     - regex substrates (rg, PowerShell, mpg) get `rg_keyword` — a
 *       single distinctive literal that exists in the corpus.
 *     - embedding gets the paraphrased `prompt` — words that don't
 *       appear verbatim in the relevant files.
 *   Ground truth = set of files that contain the rg_keyword. The
 *   question we're asking: can embeddings find the right files from
 *   a query that doesn't share vocabulary with them?
 */

export interface SemanticQuerySpec {
  label: string;
  /** Paraphrased prompt — words DO NOT appear verbatim in target files. Embeddings receive this. */
  prompt: string;
  /** Single distinctive literal — exists in target files. Regex substrates receive this. */
  rg_keyword: string;
  /** Free-form note for the human reading results. */
  notes?: string;
}

export const QUERIES: SemanticQuerySpec[] = [
  {
    label: "controller managing user identities (avatars)",
    prompt: "the HTTP controller responsible for creating, reading, updating and deleting user persona records",
    rg_keyword: "AvatarController",
    notes: "Embed should find avatar-api files from CRUD vocabulary; rg substrates only have the literal class name.",
  },
  {
    label: "ambient request context across providers",
    prompt: "the dependency-injected object that carries the current request's provider configuration through the call stack",
    rg_keyword: "ProviderContext",
    notes: "Embed should match files that describe context propagation patterns.",
  },
  {
    label: "bearer-token endpoint protection",
    prompt: "endpoints that verify cryptographically signed authorization tokens on each request",
    rg_keyword: "JWT Bearer",
    notes: "Multiple tracks discuss authentication; embed must surface ones using the JWT Bearer scheme.",
  },
  {
    label: "on-chain network integration",
    prompt: "where the design discusses connecting to and reading from distributed ledger networks",
    rg_keyword: "blockchain",
    notes: "Paraphrase uses 'distributed ledger' instead of 'blockchain'.",
  },
  {
    label: "request throttling",
    prompt: "limits on how many calls a tenant may issue per unit time",
    rg_keyword: "rate.limit",
    notes: "Paraphrase uses 'throttling' / 'limits' instead of the literal 'rate limit'.",
  },
];
