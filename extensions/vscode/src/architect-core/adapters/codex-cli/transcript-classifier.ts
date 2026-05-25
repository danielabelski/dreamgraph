// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Codex CLI adapter - pure transcript classifier (Slice 1).

import {
  CODEX_INLINE_TOOL_SERVER,
  type ToolCallClass,
  type ToolCallClassificationContext,
  type ToolCallObservation,
} from "./types.js";

const TOOL_NAME_ALIASES = Object.freeze(new Map<string, string>([
  ["read_source_file", "read_source_code"],
]));

function normalizeToolName(tool: string): string {
  return TOOL_NAME_ALIASES.get(tool) ?? tool;
}

export function classifyToolCall(
  observation: ToolCallObservation,
  ctx: ToolCallClassificationContext,
): ToolCallClass {
  if (observation.server === CODEX_INLINE_TOOL_SERVER) {
    return "provider_inline_tool";
  }

  if (observation.server === ctx.authoritativeServer) {
    const tool = normalizeToolName(observation.tool);
    for (const allowed of ctx.allowlist) {
      if (allowed === tool) {
        return "dreamgraph_authoritative";
      }
    }
    return "dreamgraph_rejected";
  }

  return "generic_context_mcp";
}
