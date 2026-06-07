/**
 * Core agent tool loop for the macro benchmark.
 *
 * Drives a messages.create loop with the Anthropic API:
 *   - Appends tool_result for every tool_use block the model returns.
 *   - Stops when the model returns no tool_use (pure text), or when a
 *     budget cap is hit (maxTurns / maxInputTokens).
 *   - Reports cumulative token usage and turn count via onProgress.
 */

import type {
  AnthropicClient,
  MessageParam,
  Tool,
  ToolInput,
  ContentBlock,
  ToolUseBlock,
  TextBlock,
  ToolResultBlockParam,
} from "./client.js";

// ─── Types ───────────────────────────────────────────────────────────────────

export interface LoopOptions {
  client: AnthropicClient;
  modelId: string;
  tools: Tool[];
  dispatch: Map<string, (input: ToolInput) => string>;
  systemPrompt?: string;
  taskPrompt: string;
  maxTurns: number;
  maxInputTokens: number;
  onProgress?: (p: { input: number; output: number; turn: number }) => void;
  /**
   * Sleep N milliseconds between turns (after onProgress, before next
   * messages.create). Keeps the loop under the Anthropic per-minute
   * rate limits during bench runs. Default 0.
   */
  interTurnDelayMs?: number;
  /**
   * Maximum number of retries on a rate-limit (429) or transient error.
   * Backoff doubles each time starting from 2s. Default 5.
   */
  maxRetries?: number;
}

export type HitCap = "turns" | "input_tokens" | "none";

export interface LoopResult {
  finalText: string;
  inputTokens: number;
  outputTokens: number;
  toolCalls: number;
  turns: number;
  hitCap: HitCap;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function isToolUseBlock(b: ContentBlock): b is ToolUseBlock {
  return b.type === "tool_use";
}

function isTextBlock(b: ContentBlock): b is TextBlock {
  return b.type === "text";
}

// ─── Main loop ────────────────────────────────────────────────────────────────

function sleep(ms: number): Promise<void> {
  return new Promise((res) => setTimeout(res, ms));
}

/**
 * Detect rate-limit / transient errors that should trigger backoff.
 * Anthropic surfaces 429 as APIError with status === 429; 529 is the
 * "overloaded" signal. Network resets surface as ECONNRESET. All
 * three are worth retrying with exponential backoff.
 */
function isRetryable(err: unknown): boolean {
  const msg = (err as Error)?.message ?? "";
  const status = (err as { status?: number })?.status;
  if (status === 429 || status === 529 || status === 503) return true;
  if (/rate.?limit|overload|ECONNRESET|ETIMEDOUT|ECONNRESET|temporar/i.test(msg)) return true;
  return false;
}

export async function runLoop(opts: LoopOptions): Promise<LoopResult> {
  const {
    client,
    modelId,
    tools,
    dispatch,
    taskPrompt,
    maxTurns,
    maxInputTokens,
    onProgress,
    systemPrompt,
    interTurnDelayMs = 0,
    maxRetries = 5,
  } = opts;

  // Accumulate conversation history.
  const messages: MessageParam[] = [{ role: "user", content: taskPrompt }];

  let inputTokens = 0;
  let outputTokens = 0;
  let toolCalls = 0;
  let turns = 0;
  let finalText = "";
  let hitCap: HitCap = "none";

  // eslint-disable-next-line no-constant-condition
  while (true) {
    // Check input token budget before each turn.
    if (inputTokens >= maxInputTokens) {
      hitCap = "input_tokens";
      finalText = `[stopped: input_tokens cap (${maxInputTokens}) reached before turn ${turns + 1}]`;
      break;
    }

    // Check turn budget.
    if (turns >= maxTurns) {
      hitCap = "turns";
      finalText = `[stopped: turn cap (${maxTurns}) reached]`;
      break;
    }

    // Call the API.
    const params: Parameters<typeof client.messages.create>[0] = {
      model: modelId,
      max_tokens: 4096,
      tools,
      messages,
      ...(systemPrompt ? { system: systemPrompt } : {}),
    };

    let response: Awaited<ReturnType<typeof client.messages.create>>;
    let attempt = 0;
    let backoffMs = 2000;
    while (true) {
      try {
        response = await client.messages.create(params);
        break;
      } catch (err) {
        if (isRetryable(err) && attempt < maxRetries) {
          attempt++;
          const wait = backoffMs;
          backoffMs *= 2;
          process.stderr.write(
            `  [rate-limit retry ${attempt}/${maxRetries}] sleeping ${wait}ms after: ${(err as Error).message}\n`,
          );
          await sleep(wait);
          continue;
        }
        finalText = `[error] API call failed: ${(err as Error).message}`;
        hitCap = "none";
        return { finalText, inputTokens, outputTokens, toolCalls, turns, hitCap };
      }
    }

    turns++;
    inputTokens += response.usage.input_tokens;
    outputTokens += response.usage.output_tokens;

    onProgress?.({ input: inputTokens, output: outputTokens, turn: turns });

    // Inter-turn throttle to stay under per-minute rate limits.
    if (interTurnDelayMs > 0) {
      await sleep(interTurnDelayMs);
    }

    // Collect text blocks for potential final answer.
    const textBlocks = response.content.filter(isTextBlock);
    const toolUseBlocks = response.content.filter(isToolUseBlock);

    // Record the assistant message.
    messages.push({ role: "assistant", content: response.content });

    // If no tool calls, we're done.
    if (toolUseBlocks.length === 0) {
      finalText = textBlocks.map((b) => b.text).join("\n").trim();
      hitCap = "none";
      break;
    }

    // Execute tools and build tool_result message.
    const toolResults: ToolResultBlockParam[] = [];
    for (const block of toolUseBlocks) {
      toolCalls++;
      const handler = dispatch.get(block.name);
      let resultContent: string;
      if (!handler) {
        resultContent = `[error] unknown tool: ${block.name}`;
      } else {
        try {
          resultContent = handler(block.input as ToolInput);
        } catch (err) {
          resultContent = `[error] tool '${block.name}' threw: ${(err as Error).message}`;
        }
      }
      toolResults.push({
        type: "tool_result",
        tool_use_id: block.id,
        content: resultContent,
      });
    }

    messages.push({ role: "user", content: toolResults });

    // Check stop reason — if it was max_tokens, stop to avoid infinite loops
    // on a model that never produces a stop token.
    if (response.stop_reason === "max_tokens") {
      finalText =
        textBlocks.map((b) => b.text).join("\n").trim() ||
        "[stopped: model hit max_tokens]";
      hitCap = "none";
      break;
    }
  }

  return { finalText, inputTokens, outputTokens, toolCalls, turns, hitCap };
}
