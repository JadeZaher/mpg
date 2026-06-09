/**
 * Typo-tolerance queries.
 *
 * Each query has a correct literal AND a deliberate typo (drop-char,
 * adjacent-swap, or single-letter substitution). Substrates:
 *   - rg                    receives the typo'd pattern as-is. Expected: 0% recall.
 *   - mpg                   receives typo'd pattern, no fuzzy. Expected: 0%.
 *   - mpg --fuzzy           receives typo'd pattern, fuzzy on. Expected: ~rg-correct-recall.
 *   - embed                 receives the typo'd pattern as a prompt. Per-file embeddings.
 *
 * Ground truth = files where the CORRECT pattern matches via rg. The
 * typo'd-input substrates are scored against the same ground truth.
 */

export interface TypoQuery {
  label: string;
  /** Correct literal (used to derive ground truth). */
  correct: string;
  /** Typo'd version (fed to all substrates). */
  typo: string;
  notes?: string;
}

export const QUERIES: TypoQuery[] = [
  {
    label: "AvatarController (drop-char)",
    correct: "AvatarController",
    typo: "AvatrController",
    notes: "Dropped 'a' from middle. Common single-char typo.",
  },
  {
    label: "ProviderContext (adjacent-swap)",
    correct: "ProviderContext",
    typo: "ProvderiContext",
    notes: "Swapped 'er' to 're'.",
  },
  {
    label: "JWT Bearer (single-letter sub)",
    correct: "JWT Bearer",
    typo: "JWT Beaer",
    notes: "Dropped one 'r' from Bearer.",
  },
  {
    label: "blockchain (drop-char)",
    correct: "blockchain",
    typo: "blockchan",
    notes: "Dropped 'i'.",
  },
  {
    label: "ProviderContext (single-char insert)",
    correct: "ProviderContext",
    typo: "ProviderdContext",
    notes: "Extra 'd' inserted.",
  },
];
