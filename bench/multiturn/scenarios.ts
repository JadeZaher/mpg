/**
 * bench/multiturn/scenarios.ts
 *
 * Multi-turn scenario definitions for the multi-turn memory bench.
 *
 * A scenario is a SEQUENCE of related queries where later turns build on
 * findings from earlier turns.  The bench tests whether mpg's mind-palace
 * stashing lets the treatment arm carry knowledge cheaply across turns
 * instead of re-searching from scratch.
 *
 * Each turn carries:
 *   prompt   — the question for that turn (Q1, Q2, …)
 *   expected — OR-groups of substrings; a turn passes if every group has
 *              at least one match in the corresponding answer section.
 *
 * Corpus: FractalEngine workspace at
 *   C:/Users/atooz/Programming/fractalengine-workspace/fractalengine
 */

export const FRACTAL_ROOT =
  "C:/Users/atooz/Programming/fractalengine-workspace/fractalengine";

export interface TurnSpec {
  prompt: string;
  /**
   * Substring OR-groups.  Every group must match (AND across groups).
   * Within a group, any one phrase is sufficient (OR).
   */
  expected: Array<string[]>;
}

export interface ScenarioSpec {
  id: string;
  label: string;
  /** Ordered turns — later turns may depend on earlier findings. */
  turns: TurnSpec[];
  /** Free-form note for the human reading results. */
  rationale?: string;
}

/**
 * S1 — Bloom Stage deep dive.
 *
 * Turn 1 asks for the entity hierarchy (high-level spec detail).
 * Turn 2 asks which Rust crate implements the renderer side (cross-file).
 * Turn 3 asks for the specific Rust function in that crate that loads assets.
 * Turn 4 asks what camera type the bloom_stage track replaces.
 *
 * Stashing "bloom entity hierarchy" in turn 1 lets turn 4 (which also touches
 * the bloom spec) reuse that stash instead of re-reading the spec file.
 * Stashing "fe-renderer" in turn 2 lets turn 3 scope its search cheaply.
 */
export const S1: ScenarioSpec = {
  id: "S1-bloom-then-renderer",
  label: "investigate bloom_stage hierarchy then trace its renderer impl",
  turns: [
    {
      prompt:
        `In the FractalEngine codebase at ${FRACTAL_ROOT}, look at the ` +
        `bloom_stage_20260322 conductor track spec. ` +
        `What entity hierarchy does it propose? Name every level in order.`,
      expected: [
        ["Fractal"],
        ["Node"],
        ["Petal"],
        ["Room"],
        ["Model"],
        ["BrowserInteraction"],
      ],
    },
    {
      prompt:
        `Still in ${FRACTAL_ROOT}: which Rust crate (workspace member) ` +
        `implements the renderer side — i.e. contains the asset loader and ` +
        `GLTF ingestion for FractalEngine? Give just the crate name.`,
      expected: [["fe-renderer"]],
    },
    {
      prompt:
        `In that Rust crate, what is the exact name of the public function ` +
        `that loads an asset into Bevy by asset_id? Give just the function name.`,
      expected: [["load_to_bevy"]],
    },
    {
      prompt:
        `According to the bloom_stage_20260322 spec, what camera type does ` +
        `the track replace (i.e. what camera existed before the track)?`,
      expected: [["Camera2d", "Camera2D"]],
    },
  ],
  rationale:
    "Across-turn reuse: turn 2 answer ('fe-renderer') is needed to answer turn 3. " +
    "Turn 1 stash of the bloom spec can be reused for turn 4 without re-reading the file.",
};

/**
 * S2 — Drag-and-drop placement + its prerequisite tracks.
 *
 * Turn 1 asks for the two prerequisite tracks that drag_drop_placement depends on.
 * Turn 2 asks what the maximum file size limit is in the ingestion pipeline.
 * Turn 3 asks what hashing algorithm is used for content addressing.
 * Turn 4 asks which source file implements the ingestion logic (GltfIngester).
 *
 * Stashing drag_drop spec in turn 1 enables cheap answers for turns 2-3 from
 * the same background section, avoiding repeated file reads.
 */
export const S2: ScenarioSpec = {
  id: "S2-drag-drop-prerequisites",
  label: "drag_drop_placement prereqs, size limit, hash scheme, ingester source",
  turns: [
    {
      prompt:
        `In ${FRACTAL_ROOT}, look at the drag_drop_placement_20260402 ` +
        `conductor track spec. What are the two prerequisite tracks it ` +
        `explicitly depends on? Give their full track directory names.`,
      expected: [
        ["bloom_stage_20260322"],
        ["petal_seed_20260322"],
      ],
    },
    {
      prompt:
        `From the same drag_drop_placement_20260402 spec (or the referenced ` +
        `ingestion code), what is the maximum file size limit enforced by the ` +
        `GLB ingestion pipeline? Give the number and unit.`,
      expected: [["256", "MB", "256 MB", "256MB"]],
    },
    {
      prompt:
        `What content-addressing hash algorithm does the FractalEngine asset ` +
        `pipeline use? Give just the algorithm name.`,
      expected: [["BLAKE3"]],
    },
    {
      prompt:
        `In ${FRACTAL_ROOT}, which specific source file (relative path from ` +
        `the workspace root) contains the GltfIngester implementation?`,
      expected: [["ingester.rs", "fe-renderer/src/ingester.rs"]],
    },
  ],
  rationale:
    "Turn 1 establishes prereqs from the spec Background section. " +
    "Stashing that section lets turns 2-3 pull size limit and hash name without re-reading. " +
    "Turn 4 confirms the code file — reachable from the stash or a quick grep.",
};

/**
 * S3 — Mycelium P2P architecture cross-crate trace.
 *
 * Turn 1 asks what the mycelium_live_20260322 spec says the network thread
 * is supposed to do (swarm bootstrap / discovery).
 * Turn 2 asks which source file in fe-network actually spawns the network thread.
 * Turn 3 asks what Tokio runtime flavor is used in that spawn function.
 * Turn 4 asks which two iroh crates (iroh-*) are listed as Cargo workspace
 *   deps in the p2p_mycelium spec background section.
 *
 * Stashing the mycelium_live spec in turn 1 gives context for turn 3
 * (runtime flavor is in the spawn description). Stashing fe-network/src/lib.rs
 * content in turn 2 enables turn 3 without re-reading the file.
 */
export const S3: ScenarioSpec = {
  id: "S3-mycelium-p2p-trace",
  label: "mycelium_live swarm intent, source file, runtime flavor, iroh deps",
  turns: [
    {
      prompt:
        `In ${FRACTAL_ROOT}, look at the mycelium_live_20260322 conductor ` +
        `track spec. According to FR-1 (Swarm Initialization), what protocol ` +
        `address format should the swarm listen on? Give the address string.`,
      expected: [["/ip4/0.0.0.0/udp/0/quic-v1", "QUIC", "quic"]],
    },
    {
      prompt:
        `In the FractalEngine workspace at ${FRACTAL_ROOT}, which specific ` +
        `source file contains the spawn_network_thread function? ` +
        `Give the path relative to the workspace root.`,
      expected: [["fe-network/src/lib.rs"]],
    },
    {
      prompt:
        `In that spawn_network_thread function, what Tokio runtime builder ` +
        `flavor is used — multi-thread or current_thread? ` +
        `Give just the flavor name.`,
      expected: [["current_thread"]],
    },
    {
      prompt:
        `According to the p2p_mycelium_20260405 spec background section, ` +
        `name at least two of the iroh-* crates listed as existing workspace ` +
        `dependencies (e.g. "iroh-blobs 0.35").`,
      expected: [
        ["iroh-blobs"],
        ["iroh-docs", "iroh-gossip"],
      ],
    },
  ],
  rationale:
    "Turn 2 identifies the file; stashing its content lets turn 3 answer the " +
    "runtime flavor without re-reading. Turn 4 reaches into a different spec — " +
    "an agent that stashed the p2p_mycelium spec background section in turn 1 " +
    "(if it scanned ahead) will answer turn 4 cheaply.",
};

export const SCENARIOS: ScenarioSpec[] = [S1, S2, S3];

/** Substring match scorer for a single turn's expected groups. */
export function scoreTurn(
  answerSection: string,
  expected: Array<string[]>,
): { passed: boolean; matched: number; total: number } {
  const lower = answerSection.toLowerCase();
  let matched = 0;
  for (const group of expected) {
    if (group.some((phrase) => lower.includes(phrase.toLowerCase()))) {
      matched++;
    }
  }
  return { passed: matched === expected.length, matched, total: expected.length };
}
