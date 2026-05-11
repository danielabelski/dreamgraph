# architect-v2/providers/

**Owner slice:** Slice 2 — Provider profile model.

**Purpose:** One folder per provider. Each provider exposes a `ProviderProfile` with capability flags (reasoning levels, tool-call schema, attachments, model window, streaming shape, default model) so the orchestrator never hardcodes provider quirks.

**Defaults locked by ADR-145:**

| Provider | Flagship default |
|----------|------------------|
| OpenAI Responses API | gpt-5.5 |
| OpenAI Chat (previous API) | gpt-5.4 |
| Anthropic | Claude 4.7 (xhigh) |
| LM Studio | gpt-oss-120b (high context) |
| Ollama | qwen2.5-coder:32b |

**Replaces in v1:** [`architect-llm.ts`](../../architect-llm.ts), [`openai-responses-adapter.ts`](../../openai-responses-adapter.ts).

**Inputs:** [plans/ARCHITECT_V2_SLICE1_INVENTORY.md](../../../../../plans/ARCHITECT_V2_SLICE1_INVENTORY.md) §1.4 + §3 row "Tool-call reliability" + §5 row "Provider model-list rot".

Empty placeholder — Slice 2 fills this.
