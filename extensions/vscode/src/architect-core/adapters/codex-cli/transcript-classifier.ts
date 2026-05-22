// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Codex CLI adapter - pure transcript classifier (Slice 1).

import {
  CODEX_INLINE_TOOL_SERVER,
  type ToolCallClass,
  type ToolCallClassificationContext,
  type ToolCallObservation,
} from "./types.js";

export function classifyToolCall(
  observation: ToolCallObservation,
  ctx: ToolCallClassificationContext,
): ToolCallClass {
  if (observation.server === CODEX_INLINE_TOOL_SERVER) {
    return "provider_inline_tool";
  }

  if (observation.server === ctx.authoritativeServer) {
    for (const allowed of ctx.allowlist) {
      if (allowed === observation.tool) {
        return "dreamgraph_authoritative";
      }
    }
    return "dreamgraph_rejected";
  }

  return "generic_context_mcp";
}
