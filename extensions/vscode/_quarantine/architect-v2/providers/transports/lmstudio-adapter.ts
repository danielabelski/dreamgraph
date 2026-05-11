// architect-v2/providers/transports/lmstudio-adapter.ts
// Milestone 2 (v10.0.0 cutover) — LM Studio adapter.
//
// STRICT ISOLATION (ADR-140): no import from v1.
//
// LM Studio exposes an OpenAI-compatible /v1 surface:
//   - POST {baseUrl}/chat/completions   (same wire as OpenAI Chat Completions)
//   - GET  {baseUrl}/models             (model discovery; no auth required)
// Default baseUrl is http://localhost:1234/v1.
//
// We reuse OpenAIChatAdapter as the wire implementation but rebrand the
// providerId to 'lmstudio' for typed errors and discovery telemetry.

import {
  ProviderError,
  type ChatRequest,
  type ChatResponse,
  type ProviderAdapter,
  type ProviderConfig,
  type StreamEvent,
} from "../adapter";
import type { ModelDescriptor } from "../profile";
import { mapHttpError, mapNetworkError } from "../_transport";
import { OpenAIChatAdapter } from "./openai-chat-adapter";

export const LMSTUDIO_DEFAULT_BASE_URL = "http://localhost:1234/v1";

export class LMStudioAdapter implements ProviderAdapter {
  readonly providerId = "lmstudio" as const;
  readonly model: ModelDescriptor;
  private readonly inner: OpenAIChatAdapter;

  constructor(model: ModelDescriptor, config: ProviderConfig) {
    this.model = model;
    // Inner adapter does the wire work but reports as 'openai'; we rewrap
    // its errors in stream/callWithTools so the providerId is 'lmstudio'.
    this.inner = new OpenAIChatAdapter(model, config, {
      defaultBaseUrl: LMSTUDIO_DEFAULT_BASE_URL,
      authHeaderRequired: false,
    });
  }

  async callWithTools(request: ChatRequest): Promise<ChatResponse> {
    try {
      return await this.inner.callWithTools(request);
    } catch (err) {
      throw rebrandError(err, this.providerId, this.model.id);
    }
  }

  async *stream(request: ChatRequest): AsyncIterable<StreamEvent> {
    for await (const evt of this.inner.stream(request)) {
      if (evt.kind === "error") {
        yield {
          kind: "error",
          error: rebrandError(evt.error, this.providerId, this.model.id),
        };
        return;
      }
      yield evt;
    }
  }
}

// ---------------------------------------------------------------------------
// Discovery: GET /models
// ---------------------------------------------------------------------------

interface LmStudioModelEntry {
  id: string;
  context_length?: number;
}

/**
 * Calls LM Studio's `/models` endpoint and returns the discovered model ids
 * lifted into v2 ModelDescriptors. Unknown context windows fall back to
 * `defaultContextWindow`.
 *
 * On any failure (server down, parse error) returns the supplied
 * `fallbackModels` so the registry still resolves.
 */
export async function discoverLmStudioModels(
  config: ProviderConfig,
  fallbackModels: readonly ModelDescriptor[],
  defaults: { capabilitiesTemplate: ModelDescriptor; defaultContextWindow: number },
): Promise<ModelDescriptor[]> {
  const baseUrl = (config.baseUrl ?? LMSTUDIO_DEFAULT_BASE_URL).replace(/\/+$/, "");
  let res: Response;
  try {
    res = await fetch(`${baseUrl}/models`, {
      method: "GET",
      headers: { Accept: "application/json" },
    });
  } catch {
    return fallbackModels.slice();
  }
  if (!res.ok) return fallbackModels.slice();

  const json = (await res.json().catch(() => undefined)) as
    | { data?: LmStudioModelEntry[] }
    | undefined;
  const entries = json?.data;
  if (!Array.isArray(entries) || entries.length === 0) return fallbackModels.slice();

  const tpl = defaults.capabilitiesTemplate;
  return entries
    .filter((e) => typeof e.id === "string" && e.id.length > 0)
    .map((e) => ({
      id: e.id,
      displayName: e.id,
      contextWindow:
        typeof e.context_length === "number" && e.context_length > 0
          ? e.context_length
          : defaults.defaultContextWindow,
      capabilities: tpl.capabilities,
    }));
}

// ---------------------------------------------------------------------------

function rebrandError(err: unknown, providerId: "lmstudio", modelId: string): ProviderError {
  if (err instanceof ProviderError) {
    return new ProviderError({
      kind: err.kind,
      providerId,
      modelId,
      message: err.message,
      retryable: err.retryable,
      providerRaw: err.providerRaw,
    });
  }
  return mapNetworkError(err, providerId, modelId);
}

// Re-export for tests / callers that want to map an HTTP error themselves.
export { mapHttpError as mapLmStudioHttpError };
