/**
 * OpenAI-format tool loop (used by OpenRouter).
 *
 * Mirrors loop.ts (the Anthropic-format one) on inputs and outputs so
 * the rest of the bench harness doesn't branch. Same RunOptions shape,
 * same LoopResult, same onProgress callback. The only differences are
 * the SDK and the tool-format translation:
 *
 *   Anthropic tools          ↔  OpenAI tools (chat.completions)
 *   - {name, description,        - {type:"function", function:{name,
 *      input_schema}                description, parameters}}
 *   - assistant content[]        - assistant content + tool_calls[]
 *      tool_use blocks
 *   - user content[]             - {role:"tool", tool_call_id, content}
 *      tool_result blocks
 *
 * Rate-limit handling: same exponential-backoff retry as loop.ts.
 */

import type {
  OpenAIClient,
  ChatCompletionTool,
  ChatCompletionMessageParam,
  ChatCompletionMessageToolCall,
} from "./openrouter-client.js";
import type { Tool, ToolInput } from "./client.js";

export interface OpenAILoopOptions {
  client: OpenAIClient;
  modelId: string;
  tools: Tool[]; // Anthropic-format input; we translate inside.
  dispatch: Map<string, (input: ToolInput) => string>;
  systemPrompt?: string;
  taskPrompt: string;
  maxTurns: number;
  maxInputTokens: number;
  onProgress?: (p: { input: number; output: number; turn: number }) => void;
  interTurnDelayMs?: number;
  maxRetries?: number;
}

export type HitCap = "turns" | "input_tokens" | "none";

export interface OpenAILoopResult {
  finalText: string;
  inputTokens: number;
  outputTokens: number;
  toolCalls: number;
  turns: number;
  hitCap: HitCap;
}

function sleep(ms: number): Promise<void> {
  return new Promise((res) => setTimeout(res, ms));
}

function isRetryable(err: unknown): boolean {
  const msg = (err as Error)?.message ?? "";
  const name = (err as Error)?.name ?? "";
  const status = (err as { status?: number })?.status;
  if (status === 429 || status === 529 || status === 503 || status === 504) return true;
  // OpenAI SDK surfaces request timeouts as APIConnectionTimeoutError /
  // AbortError. DeepSeek occasionally hangs for >3 min then 504s.
  if (/timeout|AbortError|APIConnectionTimeout/i.test(name)) return true;
  if (/rate.?limit|overload|ECONNRESET|ETIMEDOUT|EAI_AGAIN|temporar|timeout/i.test(msg)) return true;
  return false;
}

/** Translate Anthropic tool shape → OpenAI chat.completions tool shape. */
function anthropicToolsToOpenAI(tools: Tool[]): ChatCompletionTool[] {
  return tools.map((t) => ({
    type: "function" as const,
    function: {
      name: t.name,
      description: t.description,
      parameters: t.input_schema as Record<string, unknown>,
    },
  }));
}

export async function runLoopOpenAI(opts: OpenAILoopOptions): Promise<OpenAILoopResult> {
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

  const messages: ChatCompletionMessageParam[] = [];
  if (systemPrompt) messages.push({ role: "system", content: systemPrompt });
  messages.push({ role: "user", content: taskPrompt });

  const openaiTools = anthropicToolsToOpenAI(tools);

  let inputTokens = 0;
  let outputTokens = 0;
  let toolCalls = 0;
  let turns = 0;
  let finalText = "";
  let hitCap: HitCap = "none";

  // eslint-disable-next-line no-constant-condition
  while (true) {
    if (inputTokens >= maxInputTokens) {
      hitCap = "input_tokens";
      finalText = `[stopped: input_tokens cap (${maxInputTokens}) reached before turn ${turns + 1}]`;
      break;
    }
    if (turns >= maxTurns) {
      hitCap = "turns";
      finalText = `[stopped: turn cap (${maxTurns}) reached]`;
      break;
    }

    let response: Awaited<ReturnType<typeof client.chat.completions.create>>;
    let attempt = 0;
    let backoffMs = 2000;
    while (true) {
      try {
        response = await client.chat.completions.create({
          model: modelId,
          messages,
          tools: openaiTools,
          tool_choice: "auto",
          max_tokens: 4096,
        });
        break;
      } catch (err) {
        if (isRetryable(err) && attempt < maxRetries) {
          attempt++;
          const wait = backoffMs;
          backoffMs *= 2;
          process.stderr.write(
            `  [openrouter rate-limit retry ${attempt}/${maxRetries}] sleeping ${wait}ms after: ${(err as Error).message}\n`,
          );
          await sleep(wait);
          continue;
        }
        finalText = `[error] OpenRouter call failed: ${(err as Error).message}`;
        return { finalText, inputTokens, outputTokens, toolCalls, turns, hitCap };
      }
    }

    turns++;
    inputTokens += response.usage?.prompt_tokens ?? 0;
    outputTokens += response.usage?.completion_tokens ?? 0;

    onProgress?.({ input: inputTokens, output: outputTokens, turn: turns });

    if (interTurnDelayMs > 0) await sleep(interTurnDelayMs);

    const choice = response.choices?.[0];
    if (!choice) {
      finalText = "[error] OpenRouter returned no choices";
      break;
    }
    const msg = choice.message;
    const text = (msg.content ?? "").trim();
    const calls: ChatCompletionMessageToolCall[] = msg.tool_calls ?? [];

    // Append the assistant message (mirroring whatever the model sent).
    messages.push({
      role: "assistant",
      content: msg.content ?? "",
      tool_calls: calls.length > 0 ? calls : undefined,
    });

    if (calls.length === 0) {
      finalText = text;
      break;
    }

    // Execute every tool call. Append one tool message per call.
    for (const call of calls) {
      toolCalls++;
      const fnName = call.function?.name ?? "";
      let parsed: ToolInput = {} as ToolInput;
      try {
        parsed = JSON.parse(call.function?.arguments ?? "{}") as ToolInput;
      } catch {
        parsed = {} as ToolInput;
      }
      const handler = dispatch.get(fnName);
      let resultContent: string;
      if (!handler) {
        resultContent = `[error] unknown tool: ${fnName}`;
      } else {
        try {
          resultContent = handler(parsed);
        } catch (err) {
          resultContent = `[error] tool '${fnName}' threw: ${(err as Error).message}`;
        }
      }
      messages.push({
        role: "tool",
        tool_call_id: call.id,
        content: resultContent,
      });
    }

    if (choice.finish_reason === "length") {
      finalText = text || "[stopped: model hit max_tokens]";
      break;
    }
  }

  return { finalText, inputTokens, outputTokens, toolCalls, turns, hitCap };
}
