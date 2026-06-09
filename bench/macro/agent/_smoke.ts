// Run with: MPG_BENCH_PROVIDER=openrouter npx tsx bench/macro/agent/_smoke.ts
// Smoke test: one-turn agent call via OpenRouter + DeepSeek.

import { runAgent } from "./index.js";

async function main() {
  const r = await runAgent({
    arm: "control",
    taskPrompt: "Reply with the literal text: HELLO_FROM_DEEPSEEK and nothing else.",
    maxTurns: 2,
    maxInputTokens: 5000,
  });
  console.log("model:", r.modelId);
  console.log("finalText:", JSON.stringify(r.finalText));
  console.log(`tokens: in=${r.inputTokens} out=${r.outputTokens} turns=${r.turns} ms=${r.ms}`);
}
main().catch((err) => { console.error("FAIL:", err.message); process.exit(1); });
