"use strict";
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Copilot CLI adapter — pure allowlist builder (Slice 1).
//
// Validates the live DreamGraph MCP bridge registry against the
// fail-closed minimum set, then exposes every audited catalog tool the
// bridge actually serves. Pure: takes the live tool-name list as input,
// returns an `AuthoritativeAllowlist`.
//
// Invariant: every minimum grounding tool MUST be present. Optional
// mutation/graph/markdown/verification tools are included when live, so
// Copilot CLI gets the same DreamGraph-native authority surface as other
// Architect providers without wildcarding dangerous maintenance tools.
Object.defineProperty(exports, "__esModule", { value: true });
exports.buildAuthoritativeAllowlist = buildAuthoritativeAllowlist;
const types_js_1 = require("./types.js");
/**
 * Compute the audited allowlist from the live DreamGraph bridge tool
 * registry.
 *
 * @param liveToolNames tool names actually exposed by the in-process
 *   DreamGraph MCP bridge (order-insensitive, duplicates ignored).
 */
function buildAuthoritativeAllowlist(liveToolNames) {
    const live = new Set(liveToolNames);
    for (const bridgeLocalTool of types_js_1.COPILOT_BRIDGE_LOCAL_AUTHORITATIVE_TOOLS) {
        live.add(bridgeLocalTool);
    }
    const present = [];
    const missing = [];
    for (const tool of types_js_1.COPILOT_AUTHORITATIVE_TOOL_CATALOG) {
        if (live.has(tool)) {
            present.push(tool);
        }
    }
    for (const required of types_js_1.COPILOT_MINIMUM_AUTHORITATIVE_TOOLS) {
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
//# sourceMappingURL=allowlist.js.map