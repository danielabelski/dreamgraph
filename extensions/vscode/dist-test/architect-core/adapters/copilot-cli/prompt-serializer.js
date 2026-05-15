"use strict";
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
Object.defineProperty(exports, "__esModule", { value: true });
exports.serializeConversationForCopilotCli = serializeConversationForCopilotCli;
const ROLE_HEADERS = {
    system: "[system]",
    user: "[user]",
    assistant: "[assistant]",
};
function renderContentBlock(block) {
    if (block.type === "text") {
        return block.text;
    }
    // Image / binary block. The CLI cannot ingest it; emit a
    // surface-uniform placeholder.
    const label = block.fileName ? `${block.fileName} (${block.mimeType})` : block.mimeType;
    return `[image attachment elided — Copilot CLI surface does not support image input: ${label}]`;
}
function renderMessageContent(content) {
    if (typeof content === "string")
        return content;
    return content.map(renderContentBlock).join("\n");
}
/**
 * Flatten an architect-core conversation into a single prompt string
 * suitable for passing to `runCopilotCli({ prompt })`.
 *
 * Throws when the conversation is empty (the caller must always
 * include at least the user turn the architect-core driver composed).
 */
function serializeConversationForCopilotCli(conversation, options = {}) {
    if (conversation.length === 0) {
        throw new Error("serializeConversationForCopilotCli: conversation must contain at least one message");
    }
    const headers = options.roleHeaders ?? ROLE_HEADERS;
    const parts = [];
    for (const msg of conversation) {
        const header = headers[msg.role];
        const body = renderMessageContent(msg.content);
        parts.push(`${header}\n${body}`);
    }
    return parts.join("\n\n");
}
//# sourceMappingURL=prompt-serializer.js.map