/**
 * OpenAI-format client pointed at OpenRouter.
 *
 * OpenRouter exposes an OpenAI-compatible /v1 surface for every model
 * it routes to (including Anthropic, DeepSeek, Qwen, MiniMax, etc.),
 * so a single OpenAI SDK client can drive all of them. We use this to
 * sidestep the Anthropic org rate limit when running multiple benches
 * in parallel — DeepSeek V4 Pro via OpenRouter is cheap, has 1M ctx,
 * and isn't constrained by our Anthropic quota.
 *
 * Key resolution order:
 *   1. OPENROUTER_API_KEY env var
 *   2. ~/.pi/agent/models.json -> providers.openrouter-free.apiKey
 *      (the user's pi-agent credential store; explicitly opt-in)
 *
 * Calling code should treat the absence of a key as a "skip" condition.
 */

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export type OpenAIClient = import("openai").default;
export type ChatCompletionTool = import("openai/resources/chat/completions").ChatCompletionTool;
export type ChatCompletionMessageParam = import("openai/resources/chat/completions").ChatCompletionMessageParam;
export type ChatCompletion = import("openai/resources/chat/completions").ChatCompletion;
export type ChatCompletionMessageToolCall = import("openai/resources/chat/completions").ChatCompletionMessageToolCall;

const PI_MODELS_JSON = join(homedir(), ".pi", "agent", "models.json");

interface PiProviderEntry {
  baseUrl: string;
  apiKey: string;
  api?: string;
}

function piAgentOpenRouterKey(): string | null {
  if (!existsSync(PI_MODELS_JSON)) return null;
  try {
    const text = readFileSync(PI_MODELS_JSON, "utf8");
    const j = JSON.parse(text) as { providers?: Record<string, PiProviderEntry> };
    const entry =
      j.providers?.["openrouter-free"] ??
      j.providers?.["openrouter"];
    if (entry && typeof entry.apiKey === "string" && entry.apiKey.startsWith("sk-or-")) {
      return entry.apiKey;
    }
    return null;
  } catch { return null; }
}

let _client: OpenAIClient | null = null;

export async function getOpenRouterClient(): Promise<OpenAIClient> {
  if (_client) return _client;
  const apiKey =
    process.env.OPENROUTER_API_KEY ?? piAgentOpenRouterKey();
  if (!apiKey) {
    throw new Error(
      "No OpenRouter key found. Set OPENROUTER_API_KEY, or add an openrouter-free entry to ~/.pi/agent/models.json.",
    );
  }
  let OpenAI: typeof import("openai").default;
  try {
    // Dynamic import so tsx can parse this file even when openai is absent.
    OpenAI = ((await import("openai")) as { default: typeof import("openai").default }).default;
  } catch {
    throw new Error(
      "Could not load openai — run: npm install --save-dev openai",
    );
  }
  _client = new OpenAI({
    apiKey,
    baseURL: "https://openrouter.ai/api/v1",
    // 3-minute per-request hard timeout. DeepSeek calls occasionally
    // hang for 5+ min with no error signal — without this, one stuck
    // call freezes the whole bench. The loop's retry-with-backoff
    // catches the timeout and tries again.
    timeout: 3 * 60 * 1000,
    maxRetries: 0, // our outer loop handles retries; don't double-retry
    defaultHeaders: {
      // Optional but polite: lets OpenRouter attribute requests.
      "HTTP-Referer": "https://github.com/JadeZaher/mpg",
      "X-Title": "mpg benchmark",
    },
  });
  return _client;
}

/** Default model when using OpenRouter — cheap, 1M context, tool-use OK. */
export const DEFAULT_OPENROUTER_MODEL = "deepseek/deepseek-v4-pro";
