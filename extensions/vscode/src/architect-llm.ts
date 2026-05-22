/**
 * DreamGraph Architect LLM Provider — Layer 2 (Context Orchestration).
 *
 * Calls the Architect model (Anthropic, OpenAI, or Ollama) with
 * structured prompts assembled from the context orchestration layer.
 */

import * as vscode from "vscode";
import {
  buildOpenAIResponsesRequest,
  extractOpenAIResponsesRawItems,
  extractOpenAIResponsesText,
  extractOpenAIResponsesToolCalls,
  toOpenAIResponsesContent,
  translateRawToOpenAIResponses,
  usesOpenAIResponsesApi,
} from "./openai-responses-adapter";
import {
  applySharedRequestCompaction,
  compactSystemPrompt,
  minifyToolDefinitions,
} from "./request-compaction";
import {
  ARCHITECT_PASS_JSON_SCHEMA,
  ARCHITECT_PASS_SCHEMA_NAME,
} from "./architect-pass-schema.js";
import {
  StrictNarrativeStreamExtractor,
  projectStrictEnvelopeToLegacy,
} from "./architect-pass-projection.js";

export type ArchitectProvider = "anthropic" | "openai" | "ollama" | "lmstudio" | "copilot-cli" | "codex-cli";
export type AnthropicEffort = "low" | "medium" | "high" | "xhigh" | "max";

export interface ArchitectConfig {
  provider: ArchitectProvider;
  model: string;
  baseUrl: string;
  apiKey: string;
}

export type ArchitectContentBlock =
  | { type: "text"; text: string }
  | { type: "image"; mimeType: string; dataBase64: string; fileName?: string };

export type ArchitectTextBlock = { type: "text"; text: string };
export type ArchitectImageBlock = { type: "image"; mimeType: string; dataBase64: string; fileName?: string };
export type ArchitectContent = ArchitectTextBlock | ArchitectImageBlock;

export interface ArchitectMessage {
  role: "system" | "user" | "assistant";
  content: string | ArchitectContent[];
}

export interface ArchitectModelCapabilities {
  textAttachments: boolean;
  imageAttachments: boolean;
}

export interface ArchitectResponse {
  content: string;
  promptTokens: number;
  completionTokens: number;
  durationMs: number;
}

export interface ToolUseRequest {
  id: string;
  name: string;
  input: Record<string, unknown>;
}

export interface ArchitectToolResponse extends ArchitectResponse {
  toolCalls: ToolUseRequest[];
  stopReason: "end_turn" | "tool_use" | "max_tokens" | "stop" | string;
  /** Provider-specific verbatim assistant turn items.
   * For OpenAI Responses API (gpt-5.5/o-series) this is the full `output[]`
   * array including `reasoning` items. The chat panel persists these so the
   * next turn can replay them and preserve stateless reasoning context. */
  providerRawAssistant?: unknown[];
}

export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export interface ToolResultMessage {
  role: "user";
  content: Array<{
    type: "tool_result";
    tool_use_id: string;
    content: string;
    is_error?: boolean;
  }>;
}

export type StreamCallback = (chunk: string) => void;

export const ANTHROPIC_MODELS = [
  "claude-opus-4-7",
  "claude-opus-4-6",
  "claude-sonnet-4-6",
  "claude-haiku-4-5",
];

export const OPENAI_MODELS = [
  "gpt-5.5",
  "gpt-5",
  "gpt-5.4",
  "gpt-4.1",
  "gpt-4.1-mini",
  "gpt-4.1-nano",
  "gpt-4o-mini",
  "o3",
  "o4-mini",
];

// Models the GitHub Copilot CLI accepts on the `--model` flag. The CLI
// is the source of truth and may add/remove entries between releases;
// this list reflects the currently-shipping set the user has access to.
export const COPILOT_CLI_MODELS = [
  "claude-opus-4.7",
  "claude-opus-4.6",
  "gpt-5.5",
  "gpt-5.4",
  "gpt-4o",
  "claude-sonnet-4.6",
  "auto",
];

export const CODEX_CLI_MODELS = [
  "gpt-5.5",
  "gpt-5.4",
  "gpt-5.3-codex",
  "gpt-5.2-codex",
  "gpt-5.2",
  "gpt-5-mini",
  "auto",
];


/* ------------------------------------------------------------------ */
/*  Emergency input-budget brakes                                     */
/* ------------------------------------------------------------------ */
/**
 * Per-section warning threshold (chars). Telemetry only � no requests are
 * rejected client-side. The pressure-aware `BudgetCoordinator` (token economy)
 * is the sole authority on context sizing; provider APIs reject anything that
 * actually overflows their server-side window. We only log here so unusually
 * large sections (system prompt blow-ups, runaway tool histories, etc.) remain
 * visible in the "DreamGraph Context" output channel.
 */
const SECTION_WARN_CHARS = 80_000;

/**
 * Optional sink that receives structured budget summaries.
 * Set by extension activation via `setRequestBudgetSink(inspector.logRequestBudget.bind(inspector))`
 * so output appears in the "DreamGraph Context" output channel.
 * Falls back to console.log/warn if no sink is registered.
 */
type RequestBudgetSink = (summary: {
  callsite: string;
  model: string;
  inputChars: number;
  approxTokens: number;
  sections: Array<{ name: string; chars: number; approxTokens: number }>;
  warn?: boolean;
}) => void;
let _budgetSink: RequestBudgetSink | undefined;
export function setRequestBudgetSink(sink: RequestBudgetSink | undefined): void {
  _budgetSink = sink;
}

function _logRequestBudget(callsite: string, model: string, body: Record<string, unknown>, serialized: string): void {
  // Per-section breakdown: top-level keys + system + per-message char counts.
  const sections: Array<{ name: string; chars: number; approxTokens: number }> = [];
  const push = (name: string, content: unknown): void => {
    const s = typeof content === 'string' ? content : JSON.stringify(content ?? '');
    const chars = s.length;
    sections.push({ name, chars, approxTokens: Math.ceil(chars / 4) });
  };
  if (typeof body.system === 'string') push('system', body.system);
  const messages = (body as { messages?: unknown[] }).messages;
  if (Array.isArray(messages)) {
    messages.forEach((m, i) => {
      const role = (m as { role?: string }).role ?? 'unknown';
      push(`messages[${i}].${role}`, (m as { content?: unknown }).content);
    });
  }
  const tools = (body as { tools?: unknown[] }).tools;
  if (Array.isArray(tools)) push('tools', tools);

  const inputChars = serialized.length;
  const approxTokens = Math.ceil(inputChars / 4);
  const oversizedSections = sections.filter((s) => s.chars > SECTION_WARN_CHARS);
  const warn = oversizedSections.length > 0 || inputChars > 200_000;
  const topSections = sections.sort((a, b) => b.chars - a.chars).slice(0, 10);

  if (_budgetSink) {
    _budgetSink({ callsite, model, inputChars, approxTokens, sections: topSections, warn });
    return;
  }
  // Fallback: console output if no sink registered yet (early activation).
  const summary = { callsite, model, inputChars, approxTokens, sections: topSections };
  if (warn) console.warn('[DreamGraph][llm_input_budget]', JSON.stringify(summary));
  else console.log('[DreamGraph][llm_input_budget]', JSON.stringify({ callsite, model, inputChars, approxTokens }));
}

function _serializeAndLogRequest(callsite: string, model: string, body: Record<string, unknown>): string {
  const serialized = JSON.stringify(body);
  _logRequestBudget(callsite, model, body, serialized);
  return serialized;
}

export class ArchitectLlm implements vscode.Disposable {
  private _config: ArchitectConfig | null = null;
  private _secretStorage: vscode.SecretStorage;

  constructor(secretStorage: vscode.SecretStorage) {
    this._secretStorage = secretStorage;
  }

  get isConfigured(): boolean {
    return this._config !== null && this._config.provider.length > 0;
  }

  get provider(): ArchitectProvider | null {
    return this._config?.provider ?? null;
  }

  get currentConfig(): ArchitectConfig | null {
    return this._config ? { ...this._config } : null;
  }

  /** Apply a config directly in memory (skips settings round-trip). */
  applyConfig(config: ArchitectConfig): void {
    this._config = {
      ...config,
      baseUrl: config.baseUrl || this._defaultBaseUrl(config.provider),
    };
  }

  getModelCapabilities(provider?: ArchitectProvider | null, model?: string | null): ArchitectModelCapabilities {
    const effectiveProvider = provider ?? this._config?.provider ?? null;
    const effectiveModel = (model ?? this._config?.model ?? "").toLowerCase();

    if (!effectiveProvider) {
      return { textAttachments: false, imageAttachments: false };
    }

    switch (effectiveProvider) {
      case "anthropic":
        return { textAttachments: true, imageAttachments: effectiveModel.startsWith("claude") };
      case "openai": {
        const imageCapable =
          effectiveModel.startsWith("gpt-5") ||
          effectiveModel.startsWith("gpt-4.1") ||
          effectiveModel.startsWith("gpt-4o") ||
          effectiveModel.startsWith("o4") ||
          effectiveModel.startsWith("o3");
        return { textAttachments: true, imageAttachments: imageCapable };
      }
      case "ollama":
        return { textAttachments: true, imageAttachments: false };
      case "lmstudio":
        return { textAttachments: true, imageAttachments: false };
      case "copilot-cli":
      case "codex-cli":
        // Native CLI provider ports serialize turns into a single prompt;
        // no binary attachment surface exists.
        return { textAttachments: false, imageAttachments: false };
      default:
        return { textAttachments: false, imageAttachments: false };
    }
  }

  private _getAnthropicEffort(model: string): AnthropicEffort {
    const cfg = vscode.workspace.getConfiguration("dreamgraph.architect");
    const configured = (cfg.get<string>("anthropic.effort") ?? "").trim().toLowerCase();
    const normalized = configured === "xhigh" || configured === "max" || configured === "high" || configured === "medium" || configured === "low"
      ? (configured as AnthropicEffort)
      : undefined;

    if (normalized) {
      if (model.startsWith("claude-opus-4-6") && normalized === "xhigh") {
        return "high";
      }
      return normalized;
    }

    return model.startsWith("claude-opus-4-7") ? "xhigh" : "high";
  }

  private _getAnthropicMaxTokens(model: string): number {
    return model.startsWith("claude-opus-4-7") ? 65536 : 8192;
  }

  private _getAnthropicThinking(model: string): { type: "adaptive"; display?: "summarized" } | undefined {
    if (!model.startsWith("claude-opus-4-7")) {
      return undefined;
    }

    const cfg = vscode.workspace.getConfiguration("dreamgraph.architect");
    const enabled = cfg.get<boolean>("anthropic.adaptiveThinking") ?? true;
    if (!enabled) {
      return undefined;
    }

    const summarized = cfg.get<boolean>("anthropic.showThinkingSummary") ?? true;
    return summarized ? { type: "adaptive", display: "summarized" } : { type: "adaptive" };
  }

  private _buildAnthropicMessagesRequest(
    config: ArchitectConfig,
    messages: unknown[],
    system?: string,
    tools?: ToolDefinition[],
    stream?: boolean,
  ): Record<string, unknown> {
    const compactedSystem = system ? compactSystemPrompt(system) : undefined;
    const compactedTools = tools ? minifyToolDefinitions(tools) : undefined;
    const body: Record<string, unknown> = {
      model: config.model,
      max_tokens: this._getAnthropicMaxTokens(config.model),
      messages,
    };

    if (compactedSystem) {
      body.system = compactedSystem;
    }

    if (stream) {
      body.stream = true;
    }

    if (compactedTools && compactedTools.length > 0) {
      body.tools = compactedTools.map((t) => ({ name: t.name, description: t.description, input_schema: t.inputSchema }));
    }

    if (config.model.startsWith("claude-opus-4-7")) {
      body.output_config = { effort: this._getAnthropicEffort(config.model) };
      const thinking = this._getAnthropicThinking(config.model);
      if (thinking) {
        body.thinking = thinking;
      }
    }

    return body;
  }

  async loadConfig(): Promise<void> {
    const cfg = vscode.workspace.getConfiguration("dreamgraph.architect");
    const provider = (cfg.get<string>("provider") ?? "anthropic") as ArchitectProvider;
    const configuredModel = (cfg.get<string>("model") ?? "").trim();
    const model = configuredModel || this._defaultModel(provider);
    const baseUrl = cfg.get<string>("baseUrl") || this._defaultBaseUrl(provider);

    let apiKey = "";
    if (provider === "lmstudio") {
      // LM Studio ignores the auth header but the OpenAI-compat code path
      // sends `Authorization: Bearer <key>` unconditionally. A literal
      // placeholder avoids "Bearer " (empty) which some setups reject.
      apiKey = "lm-studio";
    } else if (provider && provider !== "ollama" && provider !== "copilot-cli" && provider !== "codex-cli") {
      apiKey = (await this._secretStorage.get(`dreamgraph.apiKey.${provider}`)) ?? "";
    }

    this._config = { provider, model, baseUrl, apiKey };
  }

  async setApiKey(provider: ArchitectProvider, key: string): Promise<void> {
    await this._secretStorage.store(`dreamgraph.apiKey.${provider}`, key);
    if (this._config && this._config.provider === provider) {
      this._config.apiKey = key;
    }
  }

  async getApiKey(provider: ArchitectProvider): Promise<string | undefined> {
    return this._secretStorage.get(`dreamgraph.apiKey.${provider}`);
  }

  async call(messages: ArchitectMessage[], signal?: AbortSignal): Promise<ArchitectResponse> {
    this._ensureConfigured();
    const config = this._config!;
    const start = Date.now();

    switch (config.provider) {
      case "anthropic":
        return this._callAnthropic(config, messages, start, signal);
      case "openai":
      case "lmstudio":
        return this._callOpenAI(config, messages, start, signal);
      case "ollama":
        return this._callOllama(config, messages, start, signal);
      default:
        throw new Error(`Unknown Architect provider: ${config.provider}`);
    }
  }

  async stream(messages: ArchitectMessage[], onChunk: StreamCallback, signal?: AbortSignal): Promise<ArchitectResponse> {
    this._ensureConfigured();
    const config = this._config!;
    const start = Date.now();

    switch (config.provider) {
      case "anthropic":
        return this._streamAnthropic(config, messages, onChunk, start, signal);
      case "openai":
      case "lmstudio":
        return this._streamOpenAI(config, messages, onChunk, start, signal);
      case "ollama":
        return this._streamOllama(config, messages, onChunk, start, signal);
      default:
        throw new Error(`Unknown Architect provider: ${config.provider}`);
    }
  }

  async callWithTools(
    messages: ArchitectMessage[],
    tools: ToolDefinition[],
    rawMessages?: unknown[],
    signal?: AbortSignal,
  ): Promise<ArchitectToolResponse> {
    this._ensureConfigured();
    const config = this._config!;
    const start = Date.now();
    const compactedRequest = applySharedRequestCompaction({
      messages,
      rawMessages,
      tools,
      provider: config.provider,
    });

    switch (config.provider) {
      case "anthropic":
        return this._callAnthropicWithTools(
          config,
          compactedRequest.messages,
          compactedRequest.tools ?? [],
          start,
          compactedRequest.rawMessages,
          signal,
        );
      case "openai":
      case "lmstudio":
        return this._callOpenAIWithTools(
          config,
          compactedRequest.messages,
          compactedRequest.tools ?? [],
          start,
          compactedRequest.rawMessages,
          signal,
        );
      case "ollama": {
        const resp = await this._callOllama(config, compactedRequest.messages, start, signal);
        return { ...resp, toolCalls: [], stopReason: "end_turn" };
      }
      default:
        throw new Error(`Unknown Architect provider: ${config.provider}`);
    }
  }

  private _messageTextContent(content: string | ArchitectContent[]): string {
    if (typeof content === "string") return content;
    return content.filter((block): block is ArchitectTextBlock => block.type === "text").map((block) => block.text).join("\n\n");
  }

  private _toAnthropicContent(content: string | ArchitectContent[]): unknown {
    if (typeof content === "string") return content;
    return content.map((block) => {
      if (block.type === "text") return { type: "text", text: block.text };
      return {
        type: "image",
        source: {
          type: "base64",
          media_type: block.mimeType,
          data: block.dataBase64,
        },
      };
    });
  }

  private _toOpenAIContent(content: string | ArchitectContent[]): unknown {
    if (typeof content === "string") return content;
    return content.map((block) => {
      if (block.type === "text") return { type: "text", text: block.text };
      // OpenAI Chat Completions API uses `image_url` (object form), distinct
      // from the Responses API which uses `input_image` (string form). This
      // serializer is only ever invoked from the chat/completions endpoints
      // — the Responses path runs through `_toOpenAIResponsesContent`.
      return {
        type: "image_url",
        image_url: { url: `data:${block.mimeType};base64,${block.dataBase64}` },
      };
    });
  }

  private _toOllamaContent(content: string | ArchitectContent[]): string {
    return this._messageTextContent(content);
  }

  private _translateRawToOpenAI(raw: unknown[]): unknown[] {
    const out: unknown[] = [];

    for (const msg of raw) {
      const m = msg as Record<string, unknown>;
      const role = m.role as string;
      const content = m.content;

      if (typeof content === "string") {
        out.push({ role, content });
        continue;
      }

      if (!Array.isArray(content)) {
        out.push(msg);
        continue;
      }

      const blocks = content as Array<Record<string, unknown>>;

      if (role === "assistant") {
        const textParts = blocks.filter((b) => b.type === "text").map((b) => b.text as string);
        const toolUseBlocks = blocks.filter((b) => b.type === "tool_use");
        const openaiMsg: Record<string, unknown> = {
          role: "assistant",
          content: textParts.join("") || null,
        };
        if (toolUseBlocks.length > 0) {
          openaiMsg.tool_calls = toolUseBlocks.map((b) => ({
            id: b.id as string,
            type: "function",
            function: {
              name: b.name as string,
              arguments: typeof b.input === "string" ? b.input : JSON.stringify(b.input),
            },
          }));
        }
        out.push(openaiMsg);
      } else if (role === "user") {
        const toolResults = blocks.filter((b) => b.type === "tool_result");
        const nonToolBlocks = blocks.filter((b) => b.type !== "tool_result");
        if (nonToolBlocks.length > 0) {
          const translated = nonToolBlocks.map((b) => {
            if (b.type === "image") {
              // Two equivalent inbound shapes:
              //  (a) Anthropic-style: { source: { type: 'base64', media_type, data } }
              //  (b) Canonical ArchitectImageBlock: { mimeType, dataBase64, fileName? }
              // Both must serialize to OpenAI Chat Completions' image_url object.
              const src = b.source as Record<string, unknown> | undefined;
              if (src && src.type === "base64") {
                return {
                  type: "image_url",
                  image_url: { url: `data:${src.media_type};base64,${src.data}` },
                };
              }
              if (typeof b.mimeType === "string" && typeof b.dataBase64 === "string") {
                return {
                  type: "image_url",
                  image_url: { url: `data:${b.mimeType};base64,${b.dataBase64}` },
                };
              }
            }
            return b;
          });
          out.push({ role: "user", content: translated });
        }
        for (const tr of toolResults) {
          out.push({
            role: "tool",
            tool_call_id: tr.tool_use_id as string,
            content: typeof tr.content === "string" ? tr.content : JSON.stringify(tr.content),
          });
        }
      } else {
        out.push(msg);
      }
    }

    return out;
  }

  private async _callAnthropic(
    config: ArchitectConfig,
    messages: ArchitectMessage[],
    start: number,
    signal?: AbortSignal,
  ): Promise<ArchitectResponse> {
    const { system, userMessages } = this._splitSystem(messages);
    const requestBody = this._buildAnthropicMessagesRequest(
      config,
      userMessages.map((m) => ({ role: m.role, content: this._toAnthropicContent(m.content) })),
      system,
    );

    const res = await fetch(`${config.baseUrl}/messages`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": config.apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: _serializeAndLogRequest('callAnthropic', config.model, requestBody),
      signal,
    });

    if (!res.ok) throw new Error(`Anthropic API error (${res.status}): ${await res.text()}`);

    const data = (await res.json()) as {
      content: Array<{ type: string; text?: string }>;
      usage: { input_tokens: number; output_tokens: number };
    };

    return {
      content: data.content.filter((c) => c.type === "text").map((c) => c.text ?? "").join(""),
      promptTokens: data.usage?.input_tokens ?? 0,
      completionTokens: data.usage?.output_tokens ?? 0,
      durationMs: Date.now() - start,
    };
  }

  private async _callAnthropicWithTools(
    config: ArchitectConfig,
    messages: ArchitectMessage[],
    tools: ToolDefinition[],
    start: number,
    rawMessages?: unknown[],
    signal?: AbortSignal,
  ): Promise<ArchitectToolResponse> {
    const { system } = this._splitSystem(messages);
    const apiMessages = rawMessages
      ? rawMessages
      : messages.filter((m) => m.role !== "system").map((m) => ({ role: m.role, content: this._toAnthropicContent(m.content) }));

    const requestBody = this._buildAnthropicMessagesRequest(config, apiMessages, system, tools);
    const res = await fetch(`${config.baseUrl}/messages`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": config.apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: _serializeAndLogRequest('callAnthropicWithTools', config.model, requestBody),
      signal,
    });

    if (!res.ok) throw new Error(`Anthropic API error (${res.status}): ${await res.text()}`);

    const data = (await res.json()) as {
      content: Array<{ type: string; text?: string; id?: string; name?: string; input?: Record<string, unknown> }>;
      usage: { input_tokens: number; output_tokens: number };
      stop_reason: string;
    };

    return {
      content: data.content.filter((c) => c.type === "text").map((c) => c.text ?? "").join(""),
      promptTokens: data.usage?.input_tokens ?? 0,
      completionTokens: data.usage?.output_tokens ?? 0,
      durationMs: Date.now() - start,
      toolCalls: data.content
        .filter((c) => c.type === "tool_use")
        .map((c) => ({ id: c.id!, name: c.name!, input: c.input ?? {} })),
      stopReason: data.stop_reason ?? "end_turn",
    };
  }

    private _usesOpenAIResponsesApi(model: string): boolean {
    return usesOpenAIResponsesApi(model);
  }

  private _getOpenAIReasoningEffort(): "low" | "medium" | "high" | "xhigh" {
    const cfg = vscode.workspace.getConfiguration("dreamgraph.architect");
    const configured = (cfg.get<string>("openai.reasoningEffort") ?? "").trim().toLowerCase();
    if (configured === "low" || configured === "medium" || configured === "high" || configured === "xhigh") {
      return configured;
    }
    return "medium";
  }

  private _getOpenAITextVerbosity(): "low" | "medium" | "high" {
    const cfg = vscode.workspace.getConfiguration("dreamgraph.architect");
    const configured = (cfg.get<string>("openai.verbosity") ?? "").trim().toLowerCase();
    if (configured === "low" || configured === "medium" || configured === "high") {
      return configured;
    }

    const reportingMode = (cfg.get<string>("reportingMode") ?? "standard").trim().toLowerCase();
    if (reportingMode === "deep" || reportingMode === "forensic") {
      return "medium";
    }
    return "low";
  }

    private _toOpenAIResponsesContent(content: string | ArchitectContent[]): unknown {
    return toOpenAIResponsesContent(content);
  }

    private _translateRawToOpenAIResponses(raw: unknown[]): unknown[] {
    return translateRawToOpenAIResponses(raw);
  }

    private _buildOpenAIResponsesRequest(
    config: ArchitectConfig,
    messages: ArchitectMessage[],
    rawMessages?: unknown[],
    tools?: ToolDefinition[],
  ): Record<string, unknown> {
    return buildOpenAIResponsesRequest(messages, {
      model: config.model,
      reasoningEffort: this._getOpenAIReasoningEffort(),
      textVerbosity: this._getOpenAITextVerbosity(),
      rawMessages,
      tools,
      structuredOutput: this._isStructuredOutputEnabled(config.provider),
    });
  }

  /**
   * Whether to attach the canonical architect-pass JSON schema to outbound
   * requests for the given provider. Today only OpenAI's first-party API
   * (Chat Completions + Responses) is supported \u2014 LM Studio's openai-compat
   * endpoint accepts `response_format` but its model-side enforcement varies
   * by loaded model, so we keep it opt-in via the same setting.
   *
   * Setting: `dreamgraph.architect.structuredOutput` (boolean, default true
   * for `openai`, false otherwise). User can disable to fall back to the
   * legacy fenced-JSON contract if a specific snapshot rejects schemas.
   */
  private _isStructuredOutputEnabled(provider: ArchitectProvider): boolean {
    const cfg = vscode.workspace.getConfiguration("dreamgraph.architect");
    const explicit = cfg.get<boolean>("structuredOutput");
    if (typeof explicit === "boolean") return explicit;
    // Default ON for OpenAI (strict json_schema is grammar-constrained server-side).
    // Default OFF for ollama and lmstudio: schema support exists in recent Ollama
    // (>=0.5) and via OpenAI-compat in LM Studio, but enforcement quality depends
    // on the loaded model, so users opt in. Default OFF for anthropic: forced
    // tool-use is the only API-level enforcement and it conflicts with the
    // agentic tool loop, so we keep Anthropic on its prompt-driven envelope.
    return provider === "openai";
  }

  /**
   * Build the `format` body field for the Ollama /api/chat request. Recent
   * Ollama (>=0.5) accepts a JSON Schema object here and grammar-constrains
   * the response server-side, mirroring OpenAI's strict json_schema mode.
   * Returns an empty object when structured output is disabled — callers
   * spread the result so the field simply doesn't appear on the wire for
   * older Ollama versions that wouldn't recognize it.
   */
  private _ollamaFormatField(provider: ArchitectProvider): Record<string, unknown> {
    if (!this._isStructuredOutputEnabled(provider)) return {};
    return { format: ARCHITECT_PASS_JSON_SCHEMA };
  }

  /**
   * Build the `response_format` body field for OpenAI Chat Completions.
   * Strict json_schema mode is grammar-constrained server-side: the model
   * physically cannot emit text outside the schema. Returns an empty object
   * when structured output is disabled — callers spread the result into the
   * request body so the field simply doesn't appear.
   */
  private _openAIChatResponseFormat(provider: ArchitectProvider): Record<string, unknown> {
    if (!this._isStructuredOutputEnabled(provider)) return {};
    return {
      response_format: {
        type: "json_schema",
        json_schema: {
          name: ARCHITECT_PASS_SCHEMA_NAME,
          schema: ARCHITECT_PASS_JSON_SCHEMA,
          strict: true,
        },
      },
    };
  }

  /**
   * When structured-output mode is on, the wire content is a strict
   * `architect_pass_envelope` JSON object. Project it back to the legacy
   * "prose markdown + fenced ```json envelope" shape so every existing
   * downstream parser (autonomy, summary card, webview body renderer)
   * keeps working without needing to learn the new shape. When projection
   * fails or structured output is off, the original content is returned
   * unchanged.
   */
  private _maybeProjectStructuredContent(config: ArchitectConfig, content: string): string {
    if (!this._isStructuredOutputEnabled(config.provider)) return content;
    const projection = projectStrictEnvelopeToLegacy(content);
    return projection ? projection.legacyContent : content;
  }

    private _extractOpenAIResponsesText(data: {
    output_text?: string;
    output?: Array<Record<string, unknown>>;
  }): string {
    return extractOpenAIResponsesText(data);
  }

    private _extractOpenAIResponsesToolCalls(data: { output?: Array<Record<string, unknown>> }): ToolUseRequest[] {
    return extractOpenAIResponsesToolCalls(data);
  }

  private async _callOpenAIResponses(
    config: ArchitectConfig,
    messages: ArchitectMessage[],
    start: number,
    signal?: AbortSignal,
  ): Promise<ArchitectResponse> {
    const requestBody = this._buildOpenAIResponsesRequest(config, messages);
    const res = await fetch(`${config.baseUrl}/responses`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${config.apiKey}`,
      },
      body: _serializeAndLogRequest('callOpenAIResponses', config.model, requestBody),
      signal,
    });

    if (!res.ok) throw new Error(`OpenAI Responses API error (${res.status}): ${await res.text()}`);

    const data = (await res.json()) as {
      output_text?: string;
      output?: Array<Record<string, unknown>>;
      usage?: { input_tokens?: number; output_tokens?: number };
    };

    return {
      content: this._maybeProjectStructuredContent(config, this._extractOpenAIResponsesText(data)),
      promptTokens: data.usage?.input_tokens ?? 0,
      completionTokens: data.usage?.output_tokens ?? 0,
      durationMs: Date.now() - start,
    };
  }

  private async _callOpenAIResponsesWithTools(
    config: ArchitectConfig,
    messages: ArchitectMessage[],
    tools: ToolDefinition[],
    start: number,
    rawMessages?: unknown[],
    signal?: AbortSignal,
  ): Promise<ArchitectToolResponse> {
    const requestBody = this._buildOpenAIResponsesRequest(config, messages, rawMessages, tools);
    const res = await fetch(`${config.baseUrl}/responses`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${config.apiKey}`,
      },
      body: _serializeAndLogRequest('callOpenAIResponsesWithTools', config.model, requestBody),
      signal,
    });

    if (!res.ok) throw new Error(`OpenAI Responses API error (${res.status}): ${await res.text()}`);

    const data = (await res.json()) as {
      output_text?: string;
      output?: Array<Record<string, unknown>>;
      usage?: { input_tokens?: number; output_tokens?: number };
      status?: string;
      incomplete_details?: { reason?: string };
    };
    const toolCalls = this._extractOpenAIResponsesToolCalls(data);

    return {
      content: this._maybeProjectStructuredContent(config, this._extractOpenAIResponsesText(data)),
      promptTokens: data.usage?.input_tokens ?? 0,
      completionTokens: data.usage?.output_tokens ?? 0,
      durationMs: Date.now() - start,
      toolCalls,
      // Verbatim output[] items (incl. reasoning) for stateless replay.
      providerRawAssistant: extractOpenAIResponsesRawItems(data),
      stopReason: toolCalls.length > 0
        ? "tool_use"
        : data.incomplete_details?.reason === "max_output_tokens"
          ? "max_tokens"
          : data.status ?? "end_turn",
    };
  }

  private async _callOpenAIWithTools(
    config: ArchitectConfig,
    messages: ArchitectMessage[],
    tools: ToolDefinition[],
    start: number,
    rawMessages?: unknown[],
    signal?: AbortSignal,
  ): Promise<ArchitectToolResponse> {
    if (this._usesOpenAIResponsesApi(config.model)) {
      return this._callOpenAIResponsesWithTools(config, messages, tools, start, rawMessages, signal);
    }

    // Trim tool descriptions / strip schema metadata to keep the `tools`
    // section out of the budget hot path. Mirrors the Anthropic and
    // OpenAI Responses paths (both already call `minifyToolDefinitions`).
    const compactedTools = minifyToolDefinitions(tools);
    const openaiTools = compactedTools.map((t) => ({
      type: "function" as const,
      function: { name: t.name, description: t.description, parameters: t.inputSchema },
    }));

    const apiMessages = rawMessages
      ? this._translateRawToOpenAI(rawMessages)
      : messages.map((m) => ({ role: m.role, content: this._toOpenAIContent(m.content) }));

    const { system } = this._splitSystem(messages);
    if (system && !apiMessages.some((m) => (m as Record<string, unknown>).role === "system")) {
      (apiMessages as Array<Record<string, unknown>>).unshift({ role: "system", content: system });
    }

    const res = await fetch(`${config.baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${config.apiKey}`,
      },
      body: _serializeAndLogRequest('callOpenAIWithTools', config.model, {
        model: config.model,
        max_completion_tokens: 16384,
        messages: apiMessages,
        tools: openaiTools,
        ...this._openAIChatResponseFormat(config.provider),
      }),
      signal,
    });

    if (!res.ok) throw new Error(`OpenAI API error (${res.status}): ${await res.text()}`);

    const data = (await res.json()) as {
      choices: Array<{
        message: { content: string | null; tool_calls?: Array<{ id: string; function: { name: string; arguments: string } }> };
        finish_reason: string;
      }>;
      usage: { prompt_tokens: number; completion_tokens: number };
    };

    const choice = data.choices[0];
    return {
      content: this._maybeProjectStructuredContent(config, choice?.message?.content ?? ""),
      promptTokens: data.usage?.prompt_tokens ?? 0,
      completionTokens: data.usage?.completion_tokens ?? 0,
      durationMs: Date.now() - start,
      toolCalls: (choice?.message?.tool_calls ?? []).map((tc) => ({
        id: tc.id,
        name: tc.function.name,
        input: JSON.parse(tc.function.arguments),
      })),
      stopReason: choice?.finish_reason === "tool_calls" ? "tool_use" : (choice?.finish_reason ?? "stop"),
    };
  }

  private async _streamAnthropic(
    config: ArchitectConfig,
    messages: ArchitectMessage[],
    onChunk: StreamCallback,
    start: number,
    signal?: AbortSignal,
  ): Promise<ArchitectResponse> {
    const { system, userMessages } = this._splitSystem(messages);
    const requestBody = this._buildAnthropicMessagesRequest(
      config,
      userMessages.map((m) => ({ role: m.role, content: this._toAnthropicContent(m.content) })),
      system,
      undefined,
      true,
    );

    const res = await fetch(`${config.baseUrl}/messages`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": config.apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: _serializeAndLogRequest('streamAnthropic', config.model, requestBody),
      signal,
    });

    if (!res.ok) throw new Error(`Anthropic API error (${res.status}): ${await res.text()}`);
    return this._readSSEStream(res, onChunk, start, "anthropic");
  }

  private async _callOpenAI(
    config: ArchitectConfig,
    messages: ArchitectMessage[],
    start: number,
    signal?: AbortSignal,
  ): Promise<ArchitectResponse> {
    if (this._usesOpenAIResponsesApi(config.model)) {
      return this._callOpenAIResponses(config, messages, start, signal);
    }

    const res = await fetch(`${config.baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${config.apiKey}`,
      },
      body: _serializeAndLogRequest('callOpenAI', config.model, {
        model: config.model,
        max_completion_tokens: 16384,
        messages: messages.map((m) => ({ role: m.role, content: this._toOpenAIContent(m.content) })),
        ...this._openAIChatResponseFormat(config.provider),
      }),
      signal,
    });

    if (!res.ok) throw new Error(`OpenAI API error (${res.status}): ${await res.text()}`);

    const data = (await res.json()) as {
      choices: Array<{ message: { content: string } }>;
      usage: { prompt_tokens: number; completion_tokens: number };
    };

    const rawContent = data.choices[0]?.message?.content ?? "";
    const projectedContent = this._isStructuredOutputEnabled(config.provider)
      ? (projectStrictEnvelopeToLegacy(rawContent)?.legacyContent ?? rawContent)
      : rawContent;

    return {
      content: projectedContent,
      promptTokens: data.usage?.prompt_tokens ?? 0,
      completionTokens: data.usage?.completion_tokens ?? 0,
      durationMs: Date.now() - start,
    };
  }

  private async _streamOpenAI(
    config: ArchitectConfig,
    messages: ArchitectMessage[],
    onChunk: StreamCallback,
    start: number,
    signal?: AbortSignal,
  ): Promise<ArchitectResponse> {
    const res = await fetch(`${config.baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${config.apiKey}`,
      },
      body: _serializeAndLogRequest('streamOpenAI', config.model, {
        model: config.model,
        max_completion_tokens: 16384,
        stream: true,
        messages: messages.map((m) => ({ role: m.role, content: this._toOpenAIContent(m.content) })),
        ...this._openAIChatResponseFormat(config.provider),
      }),
      signal,
    });

    if (!res.ok) throw new Error(`OpenAI API error (${res.status}): ${await res.text()}`);

    // When strict structured-output is on, the wire content is a single JSON
    // object that begins with `{`. Stream the unescaped `narrative` field to
    // the live UI (so the user sees clean prose, not raw JSON), buffer the
    // rest, and project to the legacy fenced-envelope shape on completion so
    // every downstream parser keeps working untouched.
    if (this._isStructuredOutputEnabled(config.provider)) {
      const extractor = new StrictNarrativeStreamExtractor();
      const wrapped: StreamCallback = (chunk) => {
        const visible = extractor.feed(chunk);
        if (visible) onChunk(visible);
      };
      const raw = await this._readSSEStream(res, wrapped, start, "openai");
      // Replay the full raw text into the extractor so finalize sees
      // everything (the wrapper above only forwarded narrative chars). The
      // SSE reader assembled the full content from deltas; feed any unfed
      // tail by replacing the buffer wholesale via finalize on raw content.
      const projection = projectStrictEnvelopeToLegacy(raw.content);
      return projection ? { ...raw, content: projection.legacyContent } : raw;
    }
    return this._readSSEStream(res, onChunk, start, "openai");
  }


  private async _callOllama(
    config: ArchitectConfig,
    messages: ArchitectMessage[],
    start: number,
    signal?: AbortSignal,
  ): Promise<ArchitectResponse> {
    const res = await fetch(`${config.baseUrl}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: _serializeAndLogRequest('callOllama', config.model, {
        model: config.model,
        messages: messages.map((m) => ({ role: m.role, content: this._toOllamaContent(m.content) })),
        stream: false,
        ...this._ollamaFormatField(config.provider),
      }),
      signal,
    });

    if (!res.ok) throw new Error(`Ollama API error (${res.status}): ${await res.text()}`);

    const data = (await res.json()) as {
      message: { content: string };
      prompt_eval_count?: number;
      eval_count?: number;
    };

    return {
      content: this._maybeProjectStructuredContent(config, data.message?.content ?? ""),
      promptTokens: data.prompt_eval_count ?? 0,
      completionTokens: data.eval_count ?? 0,
      durationMs: Date.now() - start,
    };
  }

  private async _streamOllama(
    config: ArchitectConfig,
    messages: ArchitectMessage[],
    onChunk: StreamCallback,
    start: number,
    signal?: AbortSignal,
  ): Promise<ArchitectResponse> {
    const res = await fetch(`${config.baseUrl}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: _serializeAndLogRequest('streamOllama', config.model, {
        model: config.model,
        messages: messages.map((m) => ({ role: m.role, content: this._toOllamaContent(m.content) })),
        stream: true,
        ...this._ollamaFormatField(config.provider),
      }),
      signal,
    });

    if (!res.ok) throw new Error(`Ollama API error (${res.status}): ${await res.text()}`);

    const reader = res.body?.getReader();
    if (!reader) throw new Error("No response body");
    const decoder = new TextDecoder();
    let fullContent = "";
    let promptTokens = 0;
    let completionTokens = 0;

    // When structured-output mode is on the wire content is a strict JSON
    // envelope; stream the unescaped narrative to the live UI and project
    // to the legacy fenced shape on completion. Mirrors the OpenAI Chat
    // Completions streaming path so downstream consumers see one shape.
    const structuredOn = this._isStructuredOutputEnabled(config.provider);
    const extractor = structuredOn ? new StrictNarrativeStreamExtractor() : null;

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      const line = decoder.decode(value, { stream: true }).trim();
      if (!line) continue;
      try {
        const parsed = JSON.parse(line) as {
          message?: { content?: string };
          done?: boolean;
          prompt_eval_count?: number;
          eval_count?: number;
        };
        const chunk = parsed.message?.content ?? "";
        if (chunk) {
          fullContent += chunk;
          if (extractor) {
            const visible = extractor.feed(chunk);
            if (visible) onChunk(visible);
          } else {
            onChunk(chunk);
          }
        }
        if (parsed.done) {
          promptTokens = parsed.prompt_eval_count ?? promptTokens;
          completionTokens = parsed.eval_count ?? completionTokens;
        }
      } catch {
        // skip malformed lines
      }
    }

    const projectedContent = structuredOn
      ? (projectStrictEnvelopeToLegacy(fullContent)?.legacyContent ?? fullContent)
      : fullContent;

    return {
      content: projectedContent,
      promptTokens,
      completionTokens,
      durationMs: Date.now() - start,
    };
  }

  private async _readSSEStream(
    res: Response,
    onChunk: StreamCallback,
    start: number,
    provider: "anthropic" | "openai",
  ): Promise<ArchitectResponse> {
    let fullContent = "";
    let promptTokens = 0;
    let completionTokens = 0;

    const reader = res.body?.getReader();
    if (!reader) throw new Error("No response body");

    const decoder = new TextDecoder();
    let buffer = "";

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";

      for (const line of lines) {
        if (!line.startsWith("data: ")) continue;
        const data = line.slice(6).trim();
        if (data === "[DONE]") continue;

        try {
          const parsed = JSON.parse(data);
          if (provider === "anthropic") {
            if (parsed.type === "content_block_delta" && parsed.delta?.text) {
              fullContent += parsed.delta.text;
              onChunk(parsed.delta.text);
            }
            if (parsed.type === "message_delta" && parsed.usage) {
              completionTokens = parsed.usage.output_tokens ?? 0;
            }
            if (parsed.type === "message_start" && parsed.message?.usage) {
              promptTokens = parsed.message.usage.input_tokens ?? 0;
            }
          } else {
            const text = parsed.choices?.[0]?.delta?.content;
            if (text) {
              fullContent += text;
              onChunk(text);
            }
            if (parsed.usage) {
              promptTokens = parsed.usage.prompt_tokens ?? 0;
              completionTokens = parsed.usage.completion_tokens ?? 0;
            }
          }
        } catch {
          // Skip malformed SSE events
        }
      }
    }

    return {
      content: fullContent,
      promptTokens,
      completionTokens,
      durationMs: Date.now() - start,
    };
  }

  private _splitSystem(messages: ArchitectMessage[]): { system: string | undefined; userMessages: ArchitectMessage[] } {
    const systemMsgs = messages.filter((m) => m.role === "system");
    const userMessages = messages.filter((m) => m.role !== "system");
    const system = systemMsgs.length > 0 ? systemMsgs.map((m) => this._messageTextContent(m.content)).join("\n\n") : undefined;
    return { system, userMessages };
  }

  private _defaultBaseUrl(provider: ArchitectProvider): string {
    switch (provider) {
      case "anthropic":
        return "https://api.anthropic.com/v1";
      case "openai":
        return "https://api.openai.com/v1";
      case "ollama":
        return "http://localhost:11434";
      case "lmstudio":
        return "http://localhost:1234/v1";
      case "copilot-cli":
      case "codex-cli":
        // No HTTP transport; the CLI is invoked locally.
        return "";
      default:
        return "";
    }
  }

  private _defaultModel(provider: ArchitectProvider): string {
    switch (provider) {
      case "anthropic":
        return ANTHROPIC_MODELS[0];
      case "openai":
        return OPENAI_MODELS[0];
      case "ollama":
        return "llama3.1";
      case "lmstudio":
        return "";
      case "copilot-cli":
        return COPILOT_CLI_MODELS[0] ?? "auto";
      case "codex-cli":
        return CODEX_CLI_MODELS[0] ?? "auto";
      default:
        return "";
    }
  }

  private _ensureConfigured(): void {
    if (!this._config || !this._config.provider) {
      throw new Error('Architect model not configured. Set "dreamgraph.architect.provider" and "dreamgraph.architect.model" in settings.');
    }
    if (!this._config.model) {
      throw new Error('Architect model name not set. Set "dreamgraph.architect.model" in settings.');
    }
    if (
      this._config.provider !== "ollama" &&
      this._config.provider !== "lmstudio" &&
      this._config.provider !== "copilot-cli" &&
      this._config.provider !== "codex-cli" &&
      !this._config.apiKey
    ) {
      throw new Error(`No API key stored for ${this._config.provider}. Use "DreamGraph: Set Architect API Key" to store one.`);
    }
    if (this._config.provider === "copilot-cli" || this._config.provider === "codex-cli") {
      // Native CLI providers are not callable through ArchitectLlm. The
      // chat panel must route turns through their ProviderPort-backed
      // runner instead of `architectLlm.stream`/`callWithTools`. Fail
      // loudly if a call slips through.
      throw new Error(
        `${this._config.provider} provider does not use ArchitectLlm transport. Route this turn through the native CLI ProviderPort instead.`,
      );
    }
  }

  dispose(): void {
    // Nothing to clean up
  }
}
