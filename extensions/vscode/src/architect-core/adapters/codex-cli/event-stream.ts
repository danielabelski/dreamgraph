// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Codex CLI adapter - JSON event stream utilities.

export interface CodexJsonExtraction {
  readonly events: readonly unknown[];
  readonly diagnostics: readonly string[];
}

export interface CodexCliEventStream {
  feed(chunk: string): readonly unknown[];
  flush(): readonly unknown[];
}

const MAX_DIAGNOSTIC_LINE_CHARS = 500;
const PLUGIN_SYNC_WARNING =
  "codex plugin sync warning: remote plugin catalog request returned 403/Cloudflare HTML; suppressed verbose HTML diagnostic";
const PLUGIN_SYNC_RE =
  /(?:\/backend-api\/(?:plugins\/featured|ps\/plugins\/installed)|remote plugin catalog|plugin catalog|cloudflare|cf-error|cf-ray|just a moment|attention required|checking your browser|403 forbidden)/i;
const CODEX_TIMESTAMPED_INFO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z\s+INFO\b/i;
const SALIENT_INFO_RE =
  /\b(?:turn error|usage limit|rate[_ -]?limit|insufficient[_ -]?quota|unsupported[_ -]?model|model_not_supported|unsupported_model|model_not_found|invalid[_ -]?model|not logged in|login required|authentication required|blocked by policy|read-only sandbox|writing is blocked|user approval settings|mcp_tool_call failed|failed to load mcp|failed to start mcp|mcp server failed)\b/i;

export function createCodexCliEventStream(): CodexCliEventStream {
  let fragmentText = "";
  let closeStack: string[] = [];
  let inString = false;
  let escaped = false;

  function ingest(chunk: string, out: unknown[]): void {
    for (let i = 0; i < chunk.length; i += 1) {
      const ch = chunk[i]!;
      if (closeStack.length === 0) {
        const expectedClose = jsonStartClose(chunk, i);
        if (expectedClose) {
          fragmentText = ch;
          closeStack = [expectedClose];
          inString = false;
          escaped = false;
        }
        continue;
      }

      fragmentText += ch;
      if (inString) {
        if (escaped) {
          escaped = false;
        } else if (ch === "\\") {
          escaped = true;
        } else if (ch === "\"") {
          inString = false;
        }
        continue;
      }

      if (ch === "\"") {
        inString = true;
      } else if (ch === "{") {
        closeStack.push("}");
      } else if (ch === "[") {
        closeStack.push("]");
      } else if (ch === "}" || ch === "]") {
        if (closeStack[closeStack.length - 1] === ch) {
          closeStack.pop();
        }
        if (closeStack.length === 0) {
          projectParsedJsonFragment(fragmentText, out);
          fragmentText = "";
        }
      }
    }
  }

  return Object.freeze({
    feed(chunk: string): readonly unknown[] {
      const out: unknown[] = [];
      if (chunk.length === 0) return out;
      ingest(chunk, out);
      return Object.freeze(out);
    },
    flush(): readonly unknown[] {
      const out: unknown[] = [];
      if (fragmentText.length > 0 && closeStack.length === 0) {
        projectParsedJsonFragment(fragmentText, out);
      }
      fragmentText = "";
      closeStack = [];
      inString = false;
      escaped = false;
      return Object.freeze(out);
    },
  });
}

export function extractCodexJsonEvents(text: string): CodexJsonExtraction {
  const stream = createCodexCliEventStream();
  const events = [...stream.feed(text), ...stream.flush()];
  const diagnostics = extractNonJsonDiagnostics(text);
  return Object.freeze({
    events: Object.freeze(events),
    diagnostics: Object.freeze(diagnostics),
  });
}

export function codexEventType(event: unknown): string | undefined {
  return recordString(asRecord(event), "type");
}

export function codexEventData(event: unknown): Record<string, unknown> | undefined {
  const record = asRecord(event);
  return asRecord(record?.data);
}

export function codexAssistantDelta(event: unknown): string | null {
  const record = asRecord(event);
  const type = codexEventType(event);
  const data = codexEventData(event);
  if (
    type === "assistant.message_delta" ||
    type === "response.output_text.delta" ||
    type === "response.output_text_delta" ||
    type === "message.delta"
  ) {
    return (
      recordString(record, "deltaContent") ??
      recordString(data, "deltaContent") ??
      recordString(record, "delta") ??
      recordString(data, "delta") ??
      recordString(record, "text") ??
      recordString(data, "text") ??
      null
    );
  }
  return null;
}

export function codexAssistantCompletedText(event: unknown): string | null {
  const record = asRecord(event);
  const type = codexEventType(event);
  const data = codexEventData(event);

  if (type === "assistant.message") {
    return recordString(record, "content") ?? recordString(data, "content") ?? null;
  }
  if (
    type === "response.output_text.done" ||
    type === "response.output_text_done" ||
    type === "message.completed"
  ) {
    return (
      recordString(record, "text") ??
      recordString(data, "text") ??
      recordString(record, "content") ??
      recordString(data, "content") ??
      null
    );
  }
  if (type === "item.completed" || type === "response.output_item.done") {
    const item = asRecord(record?.item) ?? asRecord(data?.item);
    return assistantTextFromItem(item);
  }
  if (type === "response.completed") {
    return assistantTextFromResponse(asRecord(record?.response) ?? asRecord(data?.response));
  }
  return null;
}

export function summarizeCodexDiagnosticLine(raw: string): string | null {
  const line = raw.trim();
  if (line.length === 0) return null;
  if (isCodexPluginSyncNoise(line)) return PLUGIN_SYNC_WARNING;
  if (CODEX_TIMESTAMPED_INFO_RE.test(line) && !SALIENT_INFO_RE.test(line)) return null;
  if (line.length <= MAX_DIAGNOSTIC_LINE_CHARS) return line;
  return `${line.slice(0, MAX_DIAGNOSTIC_LINE_CHARS)}... [truncated ${line.length - MAX_DIAGNOSTIC_LINE_CHARS} chars]`;
}

export function isCodexPluginSyncNoise(text: string): boolean {
  return PLUGIN_SYNC_RE.test(text) && /(?:403|forbidden|cloudflare|\/backend-api\/|plugin)/i.test(text);
}

export function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  return value as Record<string, unknown>;
}

export function recordString(record: Record<string, unknown> | undefined, key: string): string | undefined {
  const value = record?.[key];
  return typeof value === "string" ? value : undefined;
}

export function recordNumber(record: Record<string, unknown> | undefined, key: string): number | undefined {
  const value = record?.[key];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function extractNonJsonDiagnostics(text: string): readonly string[] {
  const diagnostics: string[] = [];
  let nonJson = "";
  let jsonStart = -1;
  let closeStack: string[] = [];
  let inString = false;
  let escaped = false;

  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i]!;
    if (jsonStart < 0) {
      const expectedClose = jsonStartClose(text, i);
      if (expectedClose) {
        appendDiagnostics(diagnostics, nonJson);
        nonJson = "";
        jsonStart = i;
        closeStack = [expectedClose];
        inString = false;
        escaped = false;
      } else {
        nonJson += ch;
      }
      continue;
    }

    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (ch === "\\") {
        escaped = true;
      } else if (ch === "\"") {
        inString = false;
      }
      continue;
    }

    if (ch === "\"") {
      inString = true;
    } else if (ch === "{") {
      closeStack.push("}");
    } else if (ch === "[") {
      closeStack.push("]");
    } else if (ch === "}" || ch === "]") {
      if (closeStack[closeStack.length - 1] === ch) {
        closeStack.pop();
      }
      if (closeStack.length === 0) {
        const rawJson = text.slice(jsonStart, i + 1);
        try {
          JSON.parse(rawJson);
        } catch {
          appendDiagnostics(diagnostics, rawJson);
        }
        jsonStart = -1;
      }
    }
  }

  if (jsonStart >= 0) appendDiagnostics(diagnostics, text.slice(jsonStart));
  appendDiagnostics(diagnostics, nonJson);
  return Object.freeze(dedupe(diagnostics));
}

function appendDiagnostics(target: string[], text: string): void {
  for (const raw of text.split("\n")) {
    const line = summarizeCodexDiagnosticLine(raw);
    if (line) target.push(line);
  }
}

function nextNonWhitespace(text: string, start: number): string | null {
  for (let i = start; i < text.length; i += 1) {
    const ch = text[i]!;
    if (/\s/.test(ch)) continue;
    return ch;
  }
  return null;
}

function jsonStartClose(text: string, index: number): string | null {
  const ch = text[index];
  const next = nextNonWhitespace(text, index + 1);
  if (ch === "{" && (next === "\"" || next === "}")) return "}";
  if (ch === "[" && (next === "{" || next === "\"" || next === "]")) return "]";
  return null;
}

function projectParsedJsonFragment(rawJson: string, out: unknown[]): void {
  try {
    appendCodexEventsFromJsonValue(JSON.parse(rawJson) as unknown, out);
  } catch {
    // Malformed JSON fragments are diagnostics for final parsing, not live UI
    // events. Drop them here so raw logs never stream as assistant text.
  }
}

function appendCodexEventsFromJsonValue(value: unknown, out: unknown[]): void {
  if (isCodexEventShape(value)) {
    out.push(value);
    return;
  }
  if (!Array.isArray(value)) return;
  for (const item of value) {
    if (isCodexEventShape(item)) out.push(item);
  }
}

function isCodexEventShape(value: unknown): boolean {
  const record = asRecord(value);
  if (!record) return false;
  const type = recordString(record, "type");
  if (type) {
    return /^(?:thread\.|turn\.|item\.|response\.|assistant\.|message\.|mcp_tool_call(?:[._]|$)|tool\.execution_|error$)/.test(type);
  }
  return asRecord(record.error) !== undefined;
}

function dedupe(lines: readonly string[]): readonly string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const line of lines) {
    if (seen.has(line)) continue;
    seen.add(line);
    out.push(line);
  }
  return Object.freeze(out);
}

function assistantTextFromItem(item: Record<string, unknown> | undefined): string | null {
  const type = recordString(item, "type") ?? recordString(item, "item_type");
  if (type !== "agent_message" && type !== "message" && type !== "assistant_message") return null;
  return (
    recordString(item, "text") ??
    recordString(item, "content") ??
    textFromContentArray(item?.content) ??
    null
  );
}

function assistantTextFromResponse(response: Record<string, unknown> | undefined): string | null {
  const output = response?.output;
  if (!Array.isArray(output)) return null;
  const parts: string[] = [];
  for (const item of output) {
    const record = asRecord(item);
    const role = recordString(record, "role");
    const type = recordString(record, "type");
    if (role && role !== "assistant") continue;
    if (type && type !== "message" && type !== "assistant_message") continue;
    const text = recordString(record, "text") ?? recordString(record, "content") ?? textFromContentArray(record?.content);
    if (text) parts.push(text);
  }
  return parts.length > 0 ? parts.join("\n\n") : null;
}

function textFromContentArray(value: unknown): string | undefined {
  if (!Array.isArray(value)) return undefined;
  const parts: string[] = [];
  for (const part of value) {
    if (typeof part === "string") {
      parts.push(part);
      continue;
    }
    const record = asRecord(part);
    const text = recordString(record, "text") ?? recordString(record, "content");
    if (text) parts.push(text);
  }
  return parts.length > 0 ? parts.join("") : undefined;
}
