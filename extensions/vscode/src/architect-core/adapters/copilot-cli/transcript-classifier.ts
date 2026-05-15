// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Copilot CLI adapter — pure transcript classifier (Slice 1).
//
// Classifies a single observed tool call into one of four buckets:
//
//   • dreamgraph_authoritative — DreamGraph MCP server, allowlisted tool.
//   • dreamgraph_rejected      — DreamGraph MCP server, NOT allowlisted.
//   • generic_context_mcp      — any other MCP server (user-global,
//                                plugin, third-party). Never authoritative.
//   • provider_inline_tool     — Copilot's own inline surfaces
//                                (server === "<inline>"): shell, write, …
//
// Pure: no I/O, no side effects, no allocations beyond the return tag.
// Slice 1 §1.10.

import {
  COPILOT_INLINE_TOOL_SERVER,
  type ToolCallClass,
  type ToolCallClassificationContext,
  type ToolCallObservation,
} from "./types.js";

export function classifyToolCall(
  observation: ToolCallObservation,
  ctx: ToolCallClassificationContext,
): ToolCallClass {
  if (observation.server === COPILOT_INLINE_TOOL_SERVER) {
    return "provider_inline_tool";
  }

  if (observation.server === ctx.authoritativeServer) {
    // Linear scan on a small (~10) fixed list — Set construction would
    // dominate cost for the expected call volume.
    for (const allowed of ctx.allowlist) {
      if (allowed === observation.tool) {
        return "dreamgraph_authoritative";
      }
    }
    return "dreamgraph_rejected";
  }

  return "generic_context_mcp";
}
