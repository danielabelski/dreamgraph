// architect-v2/providers/transports/openai-responses-adapter.ts
// Milestone 2 (v10.0.0 cutover) — Real OpenAI Responses API adapter.
//
// STRICT ISOLATION (ADR-140): no import from v1.
//
// Wire facts (OpenAI Responses API):
//   - POST {baseUrl}/responses
//   - Body fields: { model, input:[...], tools?:[...], reasoning?:{effort,summary},
//                    text?:{verbosity}, max_output_tokens?, store?:false, stream? }
//   - Each `input` item is one of:
//       { type:'message', role, content:[ { type:'input_text'|'input_image'|
//                                            'output_text', text? } ] }
//       { type:'function_call', call_id, name, arguments }
//       { type:'function_call_output', call_id, output }
//   - Non-stream response carries `output:[{type:'message', content:[
//       {type:'output_text', text}, ...]}, {type:'function_call', call_id,
//       name, arguments}, ...]`.
//   - SSE event types we care about (each `data:` is a JSON envelope with
//     `type` discriminator):
//       response.output_text.delta             { delta }
//       response.reasoning_summary_text.delta  { delta }
//       response.output_item.done              { item: { type, ... } }
//       response.completed                     { response:{ usage } }
//       response.failed                        { error }
//
// v2 calls Responses API in stateless mode (`store:false`) with the full
// message history every turn. We do NOT round-trip encrypted_content; the
// orchestrator's pass-by-pass design rebuilds context per pass.

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
import type { ModelDescriptor, ReasoningEffort } from "../profile";
import {
  mapHttpError,
  mapNetworkError,
  readSseLines,
  safeJsonParse,
  serializeWithBudget,
} from "../_transport";

const DEFAULT_BASE_URL = "https://api.openai.com/v1";

interface ResponsesNonStreamResponse {
  output_text?: string;
  output?: Array<Record<string, unknown>>;
  usage?: { input_tokens?: number; output_tokens?: number };
  status?: string;
  incomplete_details?: { reason?: string };
}

export class OpenAIResponsesAdapter implements ProviderAdapter {
  readonly providerId = "openai" as const;
  readonly model: ModelDescriptor;
  private readonly config: ProviderConfig;

  constructor(model: ModelDescriptor, config: ProviderConfig) {
    this.model = model;
    this.config = config;
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
      res = await fetch(`${this.baseUrl()}/responses`, {
        method: "POST",
        headers: this.headers(),
        body: serialized,
        signal: request.abortSignal,
      });
    } catch (err) {
      throw mapNetworkError(err, this.providerId, this.model.id);
    }
    if (!res.ok) throw await mapHttpError(res, this.providerId, this.model.id);

    const data = (await res.json()) as ResponsesNonStreamResponse;
    const text = extractOutputText(data);
    const toolCalls = extractToolCalls(data);
    const usage: UsageReport = {
      inputTokens: data.usage?.input_tokens,
      outputTokens: data.usage?.output_tokens,
    };
    let finishReason: FinishReason = "stop";
    if (toolCalls.length > 0) finishReason = "tool_calls";
    else if (data.incomplete_details?.reason === "max_output_tokens") finishReason = "length";

    return { text, toolCalls, usage, finishReason };
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
      res = await fetch(`${this.baseUrl()}/responses`, {
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

    let usage: UsageReport | undefined;
    let finishReason: FinishReason = "stop";
    let sawToolCall = false;

    try {
      for await (const frame of readSseLines(res)) {
        if (!frame.data) continue;
        const evt = safeJsonParse<{
          type?: string;
          delta?: string;
          item?: Record<string, unknown>;
          response?: { usage?: { input_tokens?: number; output_tokens?: number } };
          error?: { message?: string };
        }>(frame.data);
        if (!evt?.type) continue;

        switch (evt.type) {
          case "response.output_text.delta":
            if (typeof evt.delta === "string") yield { kind: "text", delta: evt.delta };
            break;
          case "response.reasoning_summary_text.delta":
            if (typeof evt.delta === "string") yield { kind: "reasoning", delta: evt.delta };
            break;
          case "response.output_item.done": {
            const item = evt.item;
            if (item && item.type === "function_call") {
              const call: ToolCall = {
                id: String((item as { call_id?: string }).call_id ?? ""),
                name: String((item as { name?: string }).name ?? ""),
                argumentsJson: String((item as { arguments?: string }).arguments ?? "{}"),
              };
              if (safeJsonParse(call.argumentsJson) === undefined) {
                yield {
                  kind: "error",
                  error: new ProviderError({
                    kind: "tool_call_malformed",
                    providerId: this.providerId,
                    modelId: this.model.id,
                    message: `Tool call ${call.name} (id=${call.id}) emitted invalid JSON arguments`,
                    providerRaw: call.argumentsJson,
                  }),
                };
                return;
              }
              sawToolCall = true;
              yield { kind: "tool_call", call };
            }
            break;
          }
          case "response.completed": {
            if (evt.response?.usage) {
              usage = {
                inputTokens: evt.response.usage.input_tokens,
                outputTokens: evt.response.usage.output_tokens,
              };
              yield { kind: "usage", usage };
            }
            finishReason = sawToolCall ? "tool_calls" : "stop";
            yield { kind: "done", finishReason };
            return;
          }
          case "response.failed": {
            yield {
              kind: "error",
              error: new ProviderError({
                kind: "transport",
                providerId: this.providerId,
                modelId: this.model.id,
                message: `OpenAI Responses API failure: ${evt.error?.message ?? "unknown"}`,
                providerRaw: evt,
              }),
            };
            return;
          }
          default:
            break;
        }
      }
      yield { kind: "done", finishReason: sawToolCall ? "tool_calls" : finishReason };
    } catch (err) {
      yield { kind: "error", error: mapNetworkError(err, this.providerId, this.model.id) };
    }
  }

  // -------------------------------------------------------------------------

  private buildRequestBody(request: ChatRequest, stream: boolean): Record<string, unknown> {
    const input = translateMessagesToResponsesInput(request.messages);
    const body: Record<string, unknown> = {
      model: this.model.id,
      input,
      store: false,
      max_output_tokens: Math.min(
        request.maxOutputTokens ?? this.model.capabilities.maxOutputTokens,
        this.model.capabilities.maxOutputTokens,
      ),
    };
    if (stream) body.stream = true;

    const reasoning = this.model.capabilities.reasoning;
    if (reasoning.supported) {
      const effort = clampEffort(request.reasoningEffort, reasoning.effortLevels, reasoning.defaultEffort);
      body.reasoning = { effort: openaiEffort(effort), summary: "auto" };
    }

    if (request.tools && request.tools.length > 0) {
      body.tools = request.tools.map((t) => translateToolToResponses(t));
      if (request.toolChoice) body.tool_choice = translateToolChoiceToResponses(request.toolChoice);
    }
    return body;
  }

  private headers(): Record<string, string> {
    if (!this.config.apiKey || this.config.apiKey.length === 0) {
      throw new ProviderError({
        kind: "auth",
        providerId: this.providerId,
        modelId: this.model.id,
        message: "OpenAI API key not configured",
      });
    }
    return {
      "Content-Type": "application/json",
      Authorization: `Bearer ${this.config.apiKey}`,
    };
  }

  private baseUrl(): string {
    return (this.config.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function translateMessagesToResponsesInput(messages: readonly ChatMessage[]): Array<Record<string, unknown>> {
  const items: Array<Record<string, unknown>> = [];
  for (const m of messages) {
    if (m.role === "tool") {
      items.push({
        type: "function_call_output",
        call_id: m.toolCallId ?? "",
        output: m.content,
      });
      continue;
    }
    if (m.role === "assistant" && m.toolCalls && m.toolCalls.length > 0) {
      if (m.content && m.content.length > 0) {
        items.push({
          type: "message",
          role: "assistant",
          content: [{ type: "output_text", text: m.content }],
        });
      }
      for (const tc of m.toolCalls) {
        items.push({
          type: "function_call",
          call_id: tc.id,
          name: tc.name,
          arguments: tc.argumentsJson || "{}",
        });
      }
      continue;
    }
    const partKind = m.role === "assistant" ? "output_text" : "input_text";
    items.push({
      type: "message",
      role: m.role,
      content: [{ type: partKind, text: m.content }],
    });
  }
  return items;
}

function translateToolToResponses(t: ToolDefinition): Record<string, unknown> {
  return {
    type: "function",
    name: t.name,
    description: t.description,
    parameters: t.inputSchema,
  };
}

function translateToolChoiceToResponses(
  choice: NonNullable<ChatRequest["toolChoice"]>,
): unknown {
  if (choice === "auto" || choice === "none" || choice === "required") return choice;
  return { type: "function", name: choice.name };
}

function extractOutputText(data: ResponsesNonStreamResponse): string {
  if (typeof data.output_text === "string" && data.output_text.length > 0) return data.output_text;
  const parts: string[] = [];
  for (const item of data.output ?? []) {
    if ((item as { type?: string }).type !== "message") continue;
    const content = (item as { content?: Array<{ type?: string; text?: string }> }).content ?? [];
    for (const block of content) {
      if (block.type === "output_text" && typeof block.text === "string") parts.push(block.text);
    }
  }
  return parts.join("");
}

function extractToolCalls(data: ResponsesNonStreamResponse): ToolCall[] {
  const calls: ToolCall[] = [];
  for (const item of data.output ?? []) {
    if ((item as { type?: string }).type !== "function_call") continue;
    const it = item as { call_id?: string; name?: string; arguments?: string };
    calls.push({
      id: String(it.call_id ?? ""),
      name: String(it.name ?? ""),
      argumentsJson: String(it.arguments ?? "{}"),
    });
  }
  return calls;
}

function clampEffort(
  requested: ReasoningEffort | undefined,
  allowed: readonly ReasoningEffort[],
  fallback: ReasoningEffort | undefined,
): ReasoningEffort {
  if (requested && allowed.includes(requested)) return requested;
  if (fallback && allowed.includes(fallback)) return fallback;
  return allowed[allowed.length - 1] ?? "high";
}

function openaiEffort(level: ReasoningEffort): string {
  // OpenAI Responses API accepts: minimal | low | medium | high.
  // v2's xhigh / max collapse to 'high' on the wire (ADR-148 wire mapping).
  switch (level) {
    case "low":
      return "low";
    case "medium":
      return "medium";
    case "high":
    case "xhigh":
    case "max":
      return "high";
  }
}
