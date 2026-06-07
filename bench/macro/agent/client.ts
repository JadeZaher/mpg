/**
 * Anthropic SDK client factory for the macro benchmark agent harness.
 *
 * Uses a dynamic import so tsx doesn't blow up if the SDK isn't installed
 * at parse time. The caller is responsible for catching the resulting
 * rejection and surfacing a useful error.
 */

// Re-export the SDK types we need so the rest of the harness stays clean.
export type AnthropicClient = import("@anthropic-ai/sdk").default;
export type MessageParam = import("@anthropic-ai/sdk").MessageParam;
export type Tool = import("@anthropic-ai/sdk").Tool;
export type Message = import("@anthropic-ai/sdk").Message;
export type ContentBlock = import("@anthropic-ai/sdk").ContentBlock;
export type ToolUseBlock = import("@anthropic-ai/sdk").ToolUseBlock;
export type TextBlock = import("@anthropic-ai/sdk").TextBlock;
export type ToolResultBlockParam = import("@anthropic-ai/sdk").ToolResultBlockParam;

let _client: AnthropicClient | null = null;

/**
 * Returns a singleton Anthropic client.
 * Throws if ANTHROPIC_API_KEY is not set.
 * Throws (with a helpful message) if the SDK isn't installed.
 */
export async function getClient(): Promise<AnthropicClient> {
  if (_client) return _client;

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    throw new Error("ANTHROPIC_API_KEY not set");
  }

  let Anthropic: typeof import("@anthropic-ai/sdk").default;
  try {
    // Dynamic import so tsx can parse this file even when the SDK is absent.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    Anthropic = ((await import("@anthropic-ai/sdk")) as any).default;
  } catch {
    throw new Error(
      "Could not load @anthropic-ai/sdk — run: npm install --save-dev @anthropic-ai/sdk",
    );
  }

  _client = new Anthropic({ apiKey });
  return _client;
}
