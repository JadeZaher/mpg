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
    try {
      response = await client.messages.create(params);
    } catch (err) {
      // Surface API errors as the final text so the driver can record them.
      finalText = `[error] API call failed: ${(err as Error).message}`;
      hitCap = "none";
      break;
    }

    turns++;
    inputTokens += response.usage.input_tokens;
    outputTokens += response.usage.output_tokens;

    onProgress?.({ input: inputTokens, output: outputTokens, turn: turns });

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
