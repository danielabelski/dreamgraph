"use strict";
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Codex CLI adapter - pure authoritative allowlist builder (Slice 1).
Object.defineProperty(exports, "__esModule", { value: true });
exports.buildAuthoritativeAllowlist = buildAuthoritativeAllowlist;
const types_js_1 = require("./types.js");
function buildAuthoritativeAllowlist(liveToolNames) {
    const live = new Set(liveToolNames);
    for (const bridgeLocalTool of types_js_1.CODEX_BRIDGE_LOCAL_AUTHORITATIVE_TOOLS) {
        live.add(bridgeLocalTool);
    }
    const present = [];
    const missing = [];
    for (const tool of types_js_1.CODEX_AUTHORITATIVE_TOOL_CATALOG) {
        if (live.has(tool)) {
            present.push(tool);
        }
    }
    for (const required of types_js_1.CODEX_MINIMUM_AUTHORITATIVE_TOOLS) {
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