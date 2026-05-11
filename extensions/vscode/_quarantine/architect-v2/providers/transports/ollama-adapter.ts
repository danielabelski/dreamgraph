// architect-v2/providers/transports/ollama-adapter.ts
// Milestone 2 (v10.0.0 cutover) — Ollama adapter.
//
// STRICT ISOLATION (ADR-140): no import from v1.
//
// Wire facts (Ollama):
//   - POST {baseUrl}/api/chat
//     Body: { model, messages:[{role,content,tool_calls?}], stream?:bool,
//             tools?:[ { type:'function', function:{ name, description, parameters } } ],
//             options?:{ num_predict?, num_ctx? } }
//     Streaming response: NDJSON; each line is
//       { model, created_at, message:{role,content,tool_calls?},
//         done:bool, done_reason?, prompt_eval_count?, eval_count? }
//   - GET  {baseUrl}/api/tags  → { models:[{name, size?, details?{...}}] }
// Default baseUrl is http://localhost:11434.

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
  readNdjsonLines,
  safeJsonParse,
  serializeWithBudget,
} from "../_transport";

export const OLLAMA_DEFAULT_BASE_URL = "http://localhost:11434";

interface OllamaChatLine {
  message?: {
    role?: string;
    content?: string;
    tool_calls?: Array<{
      function?: { name?: string; arguments?: unknown };
    }>;
  };
  done?: boolean;
  done_reason?: string;
  prompt_eval_count?: number;
  eval_count?: number;
}

export class OllamaAdapter implements ProviderAdapter {
  readonly providerId = "ollama" as const;
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
      res = await fetch(`${this.baseUrl()}/api/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: serialized,
        signal: request.abortSignal,
      });
    } catch (err) {
      throw mapNetworkError(err, this.providerId, this.model.id);
    }
    if (!res.ok) throw await mapHttpError(res, this.providerId, this.model.id);

    const data = (await res.json()) as OllamaChatLine;
    const text = data.message?.content ?? "";
    const toolCalls = mapOllamaToolCalls(data.message?.tool_calls);
    return {
      text,
      toolCalls,
      usage: {
        inputTokens: data.prompt_eval_count,
        outputTokens: data.eval_count,
      },
      finishReason: mapDoneReason(data.done_reason, toolCalls.length > 0),
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
      res = await fetch(`${this.baseUrl()}/api/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
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

    try {
      for await (const line of readNdjsonLines(res)) {
        const evt = safeJsonParse<OllamaChatLine>(line);
        if (!evt) continue;
        if (typeof evt.message?.content === "string" && evt.message.content.length > 0) {
          yield { kind: "text", delta: evt.message.content };
        }
        const toolCalls = mapOllamaToolCalls(evt.message?.tool_calls);
        for (const call of toolCalls) {
          if (safeJsonParse(call.argumentsJson) === undefined) {
            yield {
              kind: "error",
              error: new ProviderError({
                kind: "tool_call_malformed",
                providerId: this.providerId,
                modelId: this.model.id,
                message: `Tool call ${call.name} emitted invalid JSON arguments`,
                providerRaw: call.argumentsJson,
              }),
            };
            return;
          }
          yield { kind: "tool_call", call };
        }
        if (evt.done) {
          if (typeof evt.prompt_eval_count === "number" || typeof evt.eval_count === "number") {
            usage = {
              inputTokens: evt.prompt_eval_count,
              outputTokens: evt.eval_count,
            };
            yield { kind: "usage", usage };
          }
          finishReason = mapDoneReason(evt.done_reason, toolCalls.length > 0);
          yield { kind: "done", finishReason };
          return;
        }
      }
      yield { kind: "done", finishReason };
    } catch (err) {
      yield { kind: "error", error: mapNetworkError(err, this.providerId, this.model.id) };
    }
  }

  // -------------------------------------------------------------------------

  private buildRequestBody(request: ChatRequest, stream: boolean): Record<string, unknown> {
    const messages = request.messages.map((m) => translateMessageToOllama(m));
    const body: Record<string, unknown> = {
      model: this.model.id,
      messages,
      stream,
      options: {
        num_predict: Math.min(
          request.maxOutputTokens ?? this.model.capabilities.maxOutputTokens,
          this.model.capabilities.maxOutputTokens,
        ),
      },
    };
    if (request.tools && request.tools.length > 0) {
      body.tools = request.tools.map((t) => translateToolToOllama(t));
    }
    return body;
  }

  private baseUrl(): string {
    return (this.config.baseUrl ?? OLLAMA_DEFAULT_BASE_URL).replace(/\/+$/, "");
  }
}

// ---------------------------------------------------------------------------
// Discovery: GET /api/tags
// ---------------------------------------------------------------------------

interface OllamaTag {
  name: string;
  details?: { parameter_size?: string; family?: string };
}

export async function discoverOllamaModels(
  config: ProviderConfig,
  fallbackModels: readonly ModelDescriptor[],
  defaults: { capabilitiesTemplate: ModelDescriptor; defaultContextWindow: number },
): Promise<ModelDescriptor[]> {
  const baseUrl = (config.baseUrl ?? OLLAMA_DEFAULT_BASE_URL).replace(/\/+$/, "");
  let res: Response;
  try {
    res = await fetch(`${baseUrl}/api/tags`, {
      method: "GET",
      headers: { Accept: "application/json" },
    });
  } catch {
    return fallbackModels.slice();
  }
  if (!res.ok) return fallbackModels.slice();

  const json = (await res.json().catch(() => undefined)) as
    | { models?: OllamaTag[] }
    | undefined;
  const tags = json?.models;
  if (!Array.isArray(tags) || tags.length === 0) return fallbackModels.slice();

  return tags
    .filter((t) => typeof t.name === "string" && t.name.length > 0)
    .map((t) => ({
      id: t.name,
      displayName: t.name,
      contextWindow: defaults.defaultContextWindow,
      capabilities: defaults.capabilitiesTemplate.capabilities,
    }));
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function translateMessageToOllama(m: ChatMessage): Record<string, unknown> {
  if (m.role === "tool") {
    return {
      role: "tool",
      content: m.content,
    };
  }
  if (m.role === "assistant" && m.toolCalls && m.toolCalls.length > 0) {
    return {
      role: "assistant",
      content: m.content || "",
      tool_calls: m.toolCalls.map((tc) => ({
        function: {
          name: tc.name,
          arguments: safeJsonParse(tc.argumentsJson) ?? {},
        },
      })),
    };
  }
  return { role: m.role, content: m.content };
}

function translateToolToOllama(t: ToolDefinition): Record<string, unknown> {
  return {
    type: "function",
    function: {
      name: t.name,
      description: t.description,
      parameters: t.inputSchema,
    },
  };
}

function mapOllamaToolCalls(
  raw: Array<{ function?: { name?: string; arguments?: unknown } }> | undefined,
): ToolCall[] {
  if (!raw || raw.length === 0) return [];
  return raw
    .map((r, i) => {
      const name = r.function?.name ?? "";
      const args = r.function?.arguments;
      const argsJson = typeof args === "string" ? args : JSON.stringify(args ?? {});
      // Ollama doesn't return ids; synthesize a stable per-turn one so
      // downstream tool_result messages can correlate.
      return { id: `ollama-${i}`, name, argumentsJson: argsJson };
    })
    .filter((c) => c.name.length > 0);
}

function mapDoneReason(raw: string | undefined, hasToolCalls: boolean): FinishReason {
  switch (raw) {
    case "stop":
      return hasToolCalls ? "tool_calls" : "stop";
    case "length":
      return "length";
    default:
      return hasToolCalls ? "tool_calls" : "stop";
  }
}
