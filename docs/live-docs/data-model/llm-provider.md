# LLM Provider

> Low-level adapter for chat-completion and embedding calls against OpenAI-compatible endpoints (OpenAI, Anthropic, Ollama, llama.cpp, custom). Stateless; all orchestration (retries, fingerprints, accounting) lives in management_hub.

**Table:** ``  
**Storage:** unknown  

## Relationships

| Target | Type | Description |
|--------|------|-------------|
| management_hub | wrapped_by | - |
| llm_config | configured_by | - |

