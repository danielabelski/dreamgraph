"use strict";
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Copilot CLI adapter — pure MCP-config artifact generator (Slice 1).
//
// Produces the JSON payload the adapter will write to
// `<copilotHome>/mcp-config.json` for the per-run isolated invocation.
// Pure: returns a frozen artifact, no I/O.
//
// Per Slice 1 §1.6: only the DreamGraph authoritative MCP server is
// declared here. Tool gating is enforced separately on argv via
// `--allow-tool` (see argv.ts). The allowlist is recorded in
// `_dreamgraph_meta` purely for audit traceability.
Object.defineProperty(exports, "__esModule", { value: true });
exports.buildCopilotMcpConfig = buildCopilotMcpConfig;
exports.serializeCopilotMcpConfig = serializeCopilotMcpConfig;
const types_js_1 = require("./types.js");
/**
 * Build the MCP config artifact for a Copilot CLI run.
 *
 * Throws `Error` only on programmer error (empty runId, empty
 * command, empty allowlist) — these should never occur at runtime
 * because the caller has already passed allowlist/registry checks.
 */
function buildCopilotMcpConfig(input) {
    if (!input.runId) {
        throw new Error("buildCopilotMcpConfig: runId is required");
    }
    if (!input.dreamgraphCommand) {
        throw new Error("buildCopilotMcpConfig: dreamgraphCommand is required");
    }
    if (input.allowlist.length === 0) {
        throw new Error("buildCopilotMcpConfig: allowlist must contain at least one tool");
    }
    // Merge transport token into env. The DreamGraph MCP child validates
    // this token on connect. Caller-supplied env wins for any other key
    // so test fixtures can inject overrides.
    const env = {
        ...(input.dreamgraphEnv ?? {}),
        DREAMGRAPH_MCP_TOKEN: input.transportToken,
        DREAMGRAPH_RUN_ID: input.runId,
    };
    const artifact = {
        filename: "mcp-config.json",
        content: {
            mcpServers: Object.freeze({
                [types_js_1.DREAMGRAPH_AUTHORITATIVE_SERVER_NAME]: {
                    type: "stdio",
                    command: input.dreamgraphCommand,
                    args: Object.freeze([...input.dreamgraphArgs]),
                    env: Object.freeze(env),
                },
            }),
            _dreamgraph_meta: {
                runId: input.runId,
                authoritativeServer: types_js_1.DREAMGRAPH_AUTHORITATIVE_SERVER_NAME,
                allowlist: Object.freeze([...input.allowlist]),
            },
        },
    };
    return artifact;
}
/**
 * Serialize the artifact to the exact string that should be written
 * to `<copilotHome>/mcp-config.json`. Stable two-space indentation
 * with a trailing newline — keeps diffs and audit hashes deterministic.
 *
 * This is the ONLY serialization form. Per the adapter's Large
 * Payload Isolation Rule the MCP config travels exclusively as a
 * file inside the per-run `COPILOT_HOME`, never on argv, so a
 * separate compact-for-argv form is unnecessary.
 */
function serializeCopilotMcpConfig(artifact) {
    return `${JSON.stringify(artifact.content, null, 2)}\n`;
}
//# sourceMappingURL=mcp-config.js.map