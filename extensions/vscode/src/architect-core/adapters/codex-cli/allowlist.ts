// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Codex CLI adapter - pure authoritative allowlist builder (Slice 1).

import {
  CODEX_AUTHORITATIVE_TOOL_CATALOG,
  CODEX_BRIDGE_LOCAL_AUTHORITATIVE_TOOLS,
  CODEX_MINIMUM_AUTHORITATIVE_TOOLS,
  type AuthoritativeAllowlist,
} from "./types.js";

export function buildAuthoritativeAllowlist(
  liveToolNames: readonly string[],
): AuthoritativeAllowlist {
  const live = new Set<string>(liveToolNames);
  for (const bridgeLocalTool of CODEX_BRIDGE_LOCAL_AUTHORITATIVE_TOOLS) {
    live.add(bridgeLocalTool);
  }

  const present: string[] = [];
  const missing: string[] = [];

  for (const tool of CODEX_AUTHORITATIVE_TOOL_CATALOG) {
    if (live.has(tool)) {
      present.push(tool);
    }
  }

  for (const required of CODEX_MINIMUM_AUTHORITATIVE_TOOLS) {
    if (!live.has(required)) {
      missing.push(required);
    }
  }

  return {
    tools: Object.freeze(present),
    missingRequired: Object.freeze(missing),
    ok: missing.length === 0,
  };
}
