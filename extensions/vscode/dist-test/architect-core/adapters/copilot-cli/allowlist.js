"use strict";
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Copilot CLI adapter — pure allowlist builder (Slice 1).
//
// Validates the live DreamGraph MCP tool registry against the
// `COPILOT_REQUIRED_AUTHORITATIVE_TOOLS` set. Pure: takes the live
// tool-name list as input, returns an `AuthoritativeAllowlist`.
//
// Slice 1 invariant: every required tool MUST be present. If any is
// missing the caller raises `DREAMGRAPH_TOOL_REGISTRY_MISMATCH` and
// refuses to launch — the spec promises Copilot a known surface and
// silently dropping required tools would violate that promise.
Object.defineProperty(exports, "__esModule", { value: true });
exports.buildAuthoritativeAllowlist = buildAuthoritativeAllowlist;
const types_js_1 = require("./types.js");
/**
 * Compute the Slice 1 allowlist from the live DreamGraph tool
 * registry.
 *
 * @param liveToolNames tool names actually exposed by the in-process
 *   DreamGraph MCP server (order-insensitive, duplicates ignored).
 */
function buildAuthoritativeAllowlist(liveToolNames) {
    const live = new Set(liveToolNames);
    const present = [];
    const missing = [];
    for (const required of types_js_1.COPILOT_REQUIRED_AUTHORITATIVE_TOOLS) {
        if (live.has(required)) {
            present.push(required);
        }
        else {
            missing.push(required);
        }
    }
    return {
        tools: Object.freeze(present),
        missingRequired: Object.freeze(missing),
        ok: missing.length === 0,
    };
}
//# sourceMappingURL=allowlist.js.map