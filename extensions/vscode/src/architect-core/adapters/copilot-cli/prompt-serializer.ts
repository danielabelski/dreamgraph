// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Copilot CLI adapter — pure prompt serializer (Slice 4).
//
// The Copilot CLI surface is single-shot: every run takes one
// `--prompt <string>` argument and produces one transcript. There is
// no native concept of multi-turn messages, system prompts, or
// tool-result interleaving on the wire. The architect-core seam,
// however, hands us a `PromptParts` envelope with a system prompt and
// a list of `ArchitectMessage`s.
//
// `serializeConversationForCopilotCli` flattens that envelope into
// a single string the CLI model can read. The flattening is:
//
//   [system]
//   <system text>
//
//   [user]
//   <user text>
//
//   [assistant]
//   <assistant text>
//
//   …
//
//   [user]
//   <final user turn>
//
// Image content blocks are not transmissible through `--prompt` and
// are replaced by a SYSTEM-card-style placeholder so the model knows
// an image was elided. This matches the multi-modal output
// normalization rule (provider-agnostic): any provider that cannot
// ingest images receives the same surface notice instead of a
// silently-dropped attachment.
//
// Pure: no I/O, no time, no randomness. Safe to call in tests.

import type { ArchitectContent, ArchitectMessage } from "../../../architect-llm.js";

const ROLE_HEADERS: Record<ArchitectMessage["role"], string> = {
  system: "[system]",
  user: "[user]",
  assistant: "[assistant]",
};

function renderContentBlock(block: ArchitectContent): string {
  if (block.type === "text") {
    return block.text;
  }
  // Image / binary block. The CLI cannot ingest it; emit a
  // surface-uniform placeholder.
  const label = block.fileName ? `${block.fileName} (${block.mimeType})` : block.mimeType;
  return `[image attachment elided — Copilot CLI surface does not support image input: ${label}]`;
}

function renderMessageContent(content: ArchitectMessage["content"]): string {
  if (typeof content === "string") return content;
  return content.map(renderContentBlock).join("\n");
}

/**
 * Stable markers wrapping the final user turn. Single-shot CLI runs
 * read the FULL conversation; without unambiguous delimiters the
 * model can latch onto an earlier `[user]` block in the history
 * (manifests as the assistant answering the previous turn's prompt
 * for the new turn). The closing marker mirrors the opener so the
 * region is parseable in audit dumps.
 */
export const CURRENT_TURN_OPEN_MARKER =
  "===== CURRENT TURN — RESPOND ONLY TO THIS MESSAGE =====";
export const CURRENT_TURN_CLOSE_MARKER =
  "===== END CURRENT TURN =====";

export interface CliToolsManifest {
  readonly server: string;
  readonly tools: readonly string[];
}

export interface SerializeConversationOptions {
  /**
   * Override the role headers used between turns. The defaults match
   * the inline documentation above (`[system]`, `[user]`, `[assistant]`).
   * Provided for tests that want to assert exact byte output.
   */
  readonly roleHeaders?: Readonly<Record<ArchitectMessage["role"], string>>;
  /**
   * Maximum number of NON-system messages to retain (most recent
   * kept). System messages are always preserved verbatim and in
   * order. When omitted, no truncation is applied.
   */
  readonly historyKeepLast?: number;
  /**
   * When true the final `[user]` turn is wrapped in
   * `CURRENT_TURN_OPEN_MARKER` / `CURRENT_TURN_CLOSE_MARKER` so the
   * single-shot CLI model can identify the active request even when
   * the file contains many prior user turns.
   */
  readonly markCurrentTurn?: boolean;
  /**
   * When provided, an addendum is appended to the (last) system
   * message — or a synthetic leading system block is inserted if
   * none exists — listing the MCP server + tool names available
   * to the CLI surface and instructing the model to prefer them
   * for repo/graph/code queries over its inline native tools.
   * Provider-agnostic shape: the caller decides which tools to
   * advertise.
   */
  readonly cliToolsManifest?: CliToolsManifest;
}

function renderToolsManifest(manifest: CliToolsManifest): string {
  const lines: string[] = [];
  lines.push(
    `### REQUIRED FIRST STEP — DreamGraph MCP context economy`,
  );
  lines.push("");
  lines.push(
    `This conversation runs inside the DreamGraph VS Code extension. A project-aware MCP server "${manifest.server}" is connected and exposes graph-first context (cognitive knowledge graph, ADRs, workflows, data model, UI registry, source code, API surface).`,
  );
  lines.push("");
  lines.push(`Available ${manifest.server} tools (call by the SHORT name; the MCP layer routes server prefix automatically):`);
  for (const tool of manifest.tools) {
    lines.push(`  - ${tool}`);
  }
  lines.push("");
  lines.push(
    `MANDATORY POLICY — before answering ANY question about this repository, its architecture, its tools, its data model, its workflows, its ADRs, its UI registry, its dreams/insights, OR before reading any project file with a native tool (view/read/glob/rg), you MUST first ground yourself by calling at least ONE relevant ${manifest.server} tool. Suggested grounding calls:`,
  );
  lines.push(`  • Project overview / capabilities → query_resource("system://overview") or query_resource("system://capabilities")`);
  lines.push(`  • Architecture decisions             → query_resource("dream://adrs")`);
  lines.push(`  • Workflows                          → query_resource("system://workflows")`);
  lines.push(`  • Data model                         → query_resource("system://data-model") or search_data_model(query)`);
  lines.push(`  • Semantic code/graph search         → graph_rag_retrieve(query)`);
  lines.push(`  • Source inspection                  → read_source_code(repo, filePath, entity?/range?)`);
  lines.push(`  • Directory layout                   → list_directory(repo, dirPath?)`);
  lines.push("");
  lines.push(
    `Only fall back to native CLI tools (view, read, glob, rg, shell, powershell, report_intent, etc.) for actions ${manifest.server} cannot perform (live filesystem mutations, ad-hoc text grep across non-indexed paths, terminal output capture). For anything related to "what is this project", "how does X work", "where is Y defined", "what are the ADRs/workflows/tensions/insights" — ${manifest.server} tools are AUTHORITATIVE and must be used first. Skipping the grounding call is a protocol violation.`,
  );
  return lines.join("\n");
}

function applyHistoryCap(
  conversation: readonly ArchitectMessage[],
  keepLast: number,
): readonly ArchitectMessage[] {
  if (!Number.isFinite(keepLast) || keepLast <= 0) return conversation;
  const systems: ArchitectMessage[] = [];
  const rest: ArchitectMessage[] = [];
  for (const m of conversation) {
    if (m.role === "system") systems.push(m);
    else rest.push(m);
  }
  if (rest.length <= keepLast) return conversation;
  const trimmed = rest.slice(rest.length - keepLast);
  return [...systems, ...trimmed];
}

function applyToolsManifest(
  conversation: readonly ArchitectMessage[],
  manifest: CliToolsManifest,
): readonly ArchitectMessage[] {
  if (manifest.tools.length === 0) return conversation;
  const addendum = renderToolsManifest(manifest);
  let lastSystemIdx = -1;
  for (let i = 0; i < conversation.length; i++) {
    if (conversation[i]!.role === "system") lastSystemIdx = i;
  }
  if (lastSystemIdx === -1) {
    const synthetic: ArchitectMessage = {
      role: "system",
      content: addendum,
    };
    return [synthetic, ...conversation];
  }
  const out = conversation.slice() as ArchitectMessage[];
  const existing = out[lastSystemIdx]!;
  const existingText = renderMessageContent(existing.content);
  out[lastSystemIdx] = {
    role: "system",
    content: `${existingText}\n\n${addendum}`,
  };
  return out;
}

/**
 * Flatten an architect-core conversation into a single prompt string
 * suitable for passing to `runCopilotCli({ prompt })`.
 *
 * Throws when the conversation is empty (the caller must always
 * include at least the user turn the architect-core driver composed).
 */
export function serializeConversationForCopilotCli(
  conversation: readonly ArchitectMessage[],
  options: SerializeConversationOptions = {},
): string {
  if (conversation.length === 0) {
    throw new Error(
      "serializeConversationForCopilotCli: conversation must contain at least one message",
    );
  }
  const headers = options.roleHeaders ?? ROLE_HEADERS;

  let working: readonly ArchitectMessage[] = conversation;
  if (options.cliToolsManifest) {
    working = applyToolsManifest(working, options.cliToolsManifest);
  }
  if (options.historyKeepLast !== undefined) {
    working = applyHistoryCap(working, options.historyKeepLast);
  }

  let lastUserIdx = -1;
  if (options.markCurrentTurn) {
    for (let i = 0; i < working.length; i++) {
      if (working[i]!.role === "user") lastUserIdx = i;
    }
  }

  const parts: string[] = [];
  for (let i = 0; i < working.length; i++) {
    const msg = working[i]!;
    const header = headers[msg.role];
    const body = renderMessageContent(msg.content);
    if (i === lastUserIdx) {
      parts.push(
        `${header}\n${CURRENT_TURN_OPEN_MARKER}\n${body}\n${CURRENT_TURN_CLOSE_MARKER}`,
      );
    } else {
      parts.push(`${header}\n${body}`);
    }
  }
  return parts.join("\n\n");
}
