"use strict";
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Copilot CLI adapter — adapter-private type surface (Slice 1).
//
// These types describe the headless Copilot CLI invocation contract used by
// the adapter. They are intentionally NOT exported from `architect-core` —
// the adapter is consumed only via its barrel (`./index.ts`) and integrates
// with the Architect core via the existing `ProviderPort` seam in a later
// slice. Per the binding rule "no empty stubs", this file declares only
// concrete types and readonly constants — no functions yet.
//
// Provider-agnostic note: `providerId` is fixed to `"copilot-cli"` for this
// adapter. The Copilot-CLI-specific shape lives entirely behind this seam;
// the rest of the system never sees these types.
Object.defineProperty(exports, "__esModule", { value: true });
exports.COPILOT_INLINE_TOOL_SERVER = exports.DREAMGRAPH_AUTHORITATIVE_SERVER_NAME = exports.COPILOT_REQUIRED_AUTHORITATIVE_TOOLS = exports.COPILOT_CLI_PROVIDER_ID = void 0;
/**
 * Stable identifier for this provider adapter. The Architect core uses this
 * to route a `CallProviderInput` to this adapter when integration lands.
 */
exports.COPILOT_CLI_PROVIDER_ID = "copilot-cli";
/**
 * Required-tool catalogue for the DreamGraph authoritative MCP exposed to
 * Copilot CLI in Slice 1. Exactly the read-only graph + source surface
 * Copilot needs to plan a patch — every mutation tool is intentionally
 * absent so a patch must come back in the proposal channel.
 *
 * If any of these is missing from the live DreamGraph tool registry the
 * adapter MUST refuse to launch with `DREAMGRAPH_TOOL_REGISTRY_MISMATCH`.
 */
exports.COPILOT_REQUIRED_AUTHORITATIVE_TOOLS = Object.freeze([
    "query_resource",
    "query_api_surface",
    "read_source_code",
    "search_source_code",
    "list_directory",
    "list_markdown_chapters",
    "read_markdown_chapter",
    "graph_rag_retrieve",
    "shortest_path",
    "query_db_schema",
]);
/**
 * Logical name of the authoritative MCP server as seen by Copilot CLI.
 * Must match the `name` key under `mcpServers` in the generated
 * `mcp-config.json`.
 */
exports.DREAMGRAPH_AUTHORITATIVE_SERVER_NAME = "dreamgraph";
/**
 * Sentinel used in `ToolCallObservation.server` to denote a non-MCP
 * tool (`shell`, `write`, …) that the CLI exposes natively.
 */
exports.COPILOT_INLINE_TOOL_SERVER = "<inline>";
//# sourceMappingURL=types.js.map