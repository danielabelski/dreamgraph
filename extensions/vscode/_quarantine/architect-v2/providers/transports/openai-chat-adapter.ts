// architect-v2/providers/transports/openai-chat-adapter.ts
// Milestone 2 (v10.0.0 cutover) — Real OpenAI Chat Completions adapter.
//
// STRICT ISOLATION (ADR-140): no import from v1.
//
// Wire facts (OpenAI Chat Completions):
//   - POST  {baseUrl}/chat/completions
//   - Headers: Authorization: Bearer <key>, Content-Type: application/json
//   - SSE frames carry { choices:[ { delta:{ content?, tool_calls?:[...] },
//                                    finish_reason? } ], usage? }
//   - Frame `data: [DONE]` terminates the stream.
//   - Tool calls stream as partial JSON in `delta.tool_calls[i].function.arguments`
//     and MUST be reassembled per-index across frames.

import {
  ProviderError,
  type ChatMessage,
  type ChatRequest,
  type ChatResponse,
  type ProviderAdapter,
  type ProviderConfig,
  type StreamEvent,
  type ToolCall,
  type ToolDefinition,
  type UsageReport,
  type FinishReason,
} from "../adapter";
import type { ModelDescriptor } from "../profile";
import {
  mapHttpError,
  mapNetworkError,
  readSseLines,
  safeJsonParse,
  serializeWithBudget,
} from "../_transport";

interface OpenAINonStreamResponse {
  choices?: Array<{
    message?: {
      content?: string | null;
      tool_calls?: Array<{
        id: string;
        function: { name: string; arguments: string };
      }>;
    };
    finish_reason?: string;
  }>;
  usage?: { prompt_tokens?: number; completion_tokens?: number };
}

interface OpenAIStreamFrame {
  choices?: Array<{
    delta?: {
      content?: string;
      tool_calls?: Array<{
        index?: number;
        id?: string;
        function?: { name?: string; arguments?: string };
      }>;
    };
    finish_reason?: string | null;
  }>;
  usage?: { prompt_tokens?: number; completion_tokens?: number };
}

export class OpenAIChatAdapter implements ProviderAdapter {
  readonly providerId = "openai" as const;
  readonly model: ModelDescriptor;
  protected readonly config: ProviderConfig;
  protected readonly defaultBaseUrl: string;
  protected readonly authHeaderRequired: boolean;

  constructor(
    model: ModelDescriptor,
    config: ProviderConfig,
    options?: { defaultBaseUrl?: string; authHeaderRequired?: boolean },
  ) {
    this.model = model;
    this.config = config;
    this.defaultBaseUrl = options?.defaultBaseUrl ?? "https://api.openai.com/v1";
    this.authHeaderRequired = options?.authHeaderRequired ?? true;
  }

  async callWithTools(request: ChatRequest): Promise<ChatResponse> {
    const body = this.buildRequestBody(request, /* stream */ false);
    const serialized = serializeWithBudget(
      this.providerId,
      this.model.id,
      body,
      this.config.requestSizeLimitBytes,
    );

    let res: Response;
    try {
      res = await fetch(`${this.baseUrl()}/chat/completions`, {
        method: "POST",
        headers: this.headers(),
        body: serialized,
        signal: request.abortSignal,
      });
    } catch (err) {
      throw mapNetworkError(err, this.providerId, this.model.id);
    }
    if (!res.ok) throw await mapHttpError(res, this.providerId, this.model.id);

    const data = (await res.json()) as OpenAINonStreamResponse;
    const choice = data.choices?.[0];
    const text = choice?.message?.content ?? "";
    const toolCalls: ToolCall[] = (choice?.message?.tool_calls ?? []).map((tc) => ({
      id: tc.id,
      name: tc.function.name,
      argumentsJson: tc.function.arguments ?? "{}",
    }));
    return {
      text,
      toolCalls,
      usage: {
        inputTokens: data.usage?.prompt_tokens,
        outputTokens: data.usage?.completion_tokens,
      },
      finishReason: mapFinishReason(choice?.finish_reason, toolCalls.length > 0),
    };
  }

  async *stream(request: ChatRequest): AsyncIterable<StreamEvent> {
    const body = this.buildRequestBody(request, /* stream */ true);
    const serialized = serializeWithBudget(
      this.providerId,
      this.model.id,
      body,
      this.config.requestSizeLimitBytes,
    );

    let res: Response;
    try {
      res = await fetch(`${this.baseUrl()}/chat/completions`, {
        method: "POST",
        headers: { ...this.headers(), Accept: "text/event-stream" },
        body: serialized,
        signal: request.abortSignal,
      });
    } catch (err) {
      yield { kind: "error", error: mapNetworkError(err, this.providerId, this.model.id) };
      return;
    }
    if (!res.ok) {
      yield { kind: "error", error: await mapHttpError(res, this.providerId, this.model.id) };
      return;
    }

    const toolCallBuffers = new Map<number, { id: string; name: string; argsBuf: string }>();
    let finishReason: FinishReason = "stop";
    let usage: UsageReport | undefined;

    try {
      for await (const frame of readSseLines(res)) {
        if (!frame.data || frame.data === "[DONE]") {
          if (frame.data === "[DONE]") break;
          continue;
        }
        const evt = safeJsonParse<OpenAIStreamFrame>(frame.data);
        if (!evt) continue;

        const choice = evt.choices?.[0];
        if (choice?.delta?.content) {
          yield { kind: "text", delta: choice.delta.content };
        }
        if (choice?.delta?.tool_calls) {
          for (const part of choice.delta.tool_calls) {
            const idx = part.index ?? 0;
            let buf = toolCallBuffers.get(idx);
            if (!buf) {
              buf = { id: part.id ?? "", name: part.function?.name ?? "", argsBuf: "" };
              toolCallBuffers.set(idx, buf);
            }
            if (part.id) buf.id = part.id;
            if (part.function?.name) buf.name = part.function.name;
            if (part.function?.arguments) buf.argsBuf += part.function.arguments;
          }
        }
        if (choice?.finish_reason) {
          finishReason = mapFinishReason(choice.finish_reason, toolCallBuffers.size > 0);
        }
        if (evt.usage) {
          usage = {
            inputTokens: evt.usage.prompt_tokens,
            outputTokens: evt.usage.completion_tokens,
          };
        }
      }

      // Flush any reassembled tool calls.
      for (const [, buf] of toolCallBuffers) {
        const argumentsJson = buf.argsBuf.length > 0 ? buf.argsBuf : "{}";
        if (safeJsonParse(argumentsJson) === undefined) {
          yield {
            kind: "error",
            error: new ProviderError({
              kind: "tool_call_malformed",
              providerId: this.providerId,
              modelId: this.model.id,
              message: `Tool call ${buf.name} (id=${buf.id}) emitted invalid JSON arguments`,
              providerRaw: argumentsJson,
            }),
          };
          return;
        }
        yield {
          kind: "tool_call",
          call: { id: buf.id, name: buf.name, argumentsJson },
        };
      }
      if (usage) yield { kind: "usage", usage };
      yield { kind: "done", finishReason };
    } catch (err) {
      yield { kind: "error", error: mapNetworkError(err, this.providerId, this.model.id) };
    }
  }

  // -------------------------------------------------------------------------

  protected buildRequestBody(request: ChatRequest, stream: boolean): Record<string, unknown> {
    const messages = request.messages.map((m) => translateMessageToOpenAI(m));
    const body: Record<string, unknown> = {
      model: this.model.id,
      messages,
      max_completion_tokens: Math.min(
        request.maxOutputTokens ?? this.model.capabilities.maxOutputTokens,
        this.model.capabilities.maxOutputTokens,
      ),
    };
    if (stream) {
      body.stream = true;
      body.stream_options = { include_usage: true };
    }
    if (request.tools && request.tools.length > 0) {
      body.tools = request.tools.map((t) => translateToolToOpenAI(t));
      if (request.toolChoice) body.tool_choice = translateToolChoiceToOpenAI(request.toolChoice);
    }
    return body;
  }

  protected headers(): Record<string, string> {
    const h: Record<string, string> = { "Content-Type": "application/json" };
    if (this.authHeaderRequired) {
      if (!this.config.apiKey || this.config.apiKey.length === 0) {
        throw new ProviderError({
          kind: "auth",
          providerId: this.providerId,
          modelId: this.model.id,
          message: `${this.providerId} API key not configured`,
        });
      }
      h.Authorization = `Bearer ${this.config.apiKey}`;
    } else if (this.config.apiKey && this.config.apiKey.length > 0) {
      // Local providers may still accept (and ignore) the header; pass it
      // through if the user supplied one, since some proxies enforce it.
      h.Authorization = `Bearer ${this.config.apiKey}`;
    }
    return h;
  }

  protected baseUrl(): string {
    return (this.config.baseUrl ?? this.defaultBaseUrl).replace(/\/+$/, "");
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function translateMessageToOpenAI(m: ChatMessage): Record<string, unknown> {
  if (m.role === "tool") {
    return {
      role: "tool",
      tool_call_id: m.toolCallId ?? "",
      content: m.content,
    };
  }
  if (m.role === "assistant" && m.toolCalls && m.toolCalls.length > 0) {
    return {
      role: "assistant",
      content: m.content || null,
      tool_calls: m.toolCalls.map((tc) => ({
        id: tc.id,
        type: "function",
        function: { name: tc.name, arguments: tc.argumentsJson || "{}" },
      })),
    };
  }
  return { role: m.role, content: m.content };
}

function translateToolToOpenAI(t: ToolDefinition): Record<string, unknown> {
  return {
    type: "function",
    function: {
      name: t.name,
      description: t.description,
      parameters: t.inputSchema,
    },
  };
}

function translateToolChoiceToOpenAI(
  choice: NonNullable<ChatRequest["toolChoice"]>,
): unknown {
  if (choice === "auto" || choice === "none" || choice === "required") return choice;
  return { type: "function", function: { name: choice.name } };
}

function mapFinishReason(raw: string | null | undefined, hasToolCalls: boolean): FinishReason {
  switch (raw) {
    case "stop":
      return hasToolCalls ? "tool_calls" : "stop";
    case "length":
      return "length";
    case "tool_calls":
    case "function_call":
      return "tool_calls";
    case "content_filter":
      return "content_filter";
    case null:
    case undefined:
    case "":
      return hasToolCalls ? "tool_calls" : "stop";
    default:
      return "stop";
  }
}
