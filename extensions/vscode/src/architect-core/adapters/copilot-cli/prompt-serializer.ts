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

export interface SerializeConversationOptions {
  /**
   * Override the role headers used between turns. The defaults match
   * the inline documentation above (`[system]`, `[user]`, `[assistant]`).
   * Provided for tests that want to assert exact byte output.
   */
  readonly roleHeaders?: Readonly<Record<ArchitectMessage["role"], string>>;
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
  const parts: string[] = [];
  for (const msg of conversation) {
    const header = headers[msg.role];
    const body = renderMessageContent(msg.content);
    parts.push(`${header}\n${body}`);
  }
  return parts.join("\n\n");
}
