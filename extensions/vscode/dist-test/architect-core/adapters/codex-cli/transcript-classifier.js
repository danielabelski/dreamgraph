"use strict";
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Codex CLI adapter - pure transcript classifier (Slice 1).
Object.defineProperty(exports, "__esModule", { value: true });
exports.classifyToolCall = classifyToolCall;
const types_js_1 = require("./types.js");
const TOOL_NAME_ALIASES = Object.freeze(new Map([
    ["read_source_file", "read_source_code"],
]));
function normalizeToolName(tool) {
    return TOOL_NAME_ALIASES.get(tool) ?? tool;
}
function classifyToolCall(observation, ctx) {
    if (observation.server === types_js_1.CODEX_INLINE_TOOL_SERVER) {
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
//# sourceMappingURL=transcript-classifier.js.map