"use strict";
// architect-v2/execution/inventory.ts
// Slice 4 — Live CapabilityInventory producer (replaces Slice 3 stub).
//
// STRICT ISOLATION (ADR-140): no import from v1.
//
// Per Slice 3 §3.G: this module supplies the live inventory. Slice 3
// `deriveNextAction()` consumes it via the `CapabilityInventory` contract.
Object.defineProperty(exports, "__esModule", { value: true });
exports.resolveCatalog = resolveCatalog;
exports.buildCapabilityInventory = buildCapabilityInventory;
exports.tiersCoveringIntent = tiersCoveringIntent;
const catalog_js_1 = require("./catalog.js");
/**
 * Resolve `NATIVE_TOOL_CATALOG` against the live probes.
 * - MCP descriptors: available iff `mcp.has(tool)`.
 * - VS Code descriptors: available iff every `requires` capability is present.
 * - Shell descriptors: always available (the host runs in a Node/VS Code process).
 */
function resolveCatalog(args) {
    const available = [];
    const unavailable = [];
    for (const desc of catalog_js_1.NATIVE_TOOL_CATALOG) {
        if (desc.kind === "mcp") {
            (args.mcp.has(desc.tool) ? available : unavailable).push(desc);
        }
        else if (desc.kind === "vscode") {
            const ok = (desc.requires ?? []).every((cap) => args.vscode.has(cap));
            (ok ? available : unavailable).push(desc);
        }
        else {
            // shell — always available in the host process.
            available.push(desc);
        }
    }
    const known = new Set(catalog_js_1.NATIVE_TOOL_CATALOG.filter((d) => d.kind === "mcp").map((d) => d.tool));
    const unknownRosterTools = args.mcp.list().filter((t) => !known.has(t));
    return Object.freeze({
        available: Object.freeze(available),
        unavailable: Object.freeze(unavailable),
        unknownRosterTools: Object.freeze(unknownRosterTools),
    });
}
/**
 * Project a resolved catalog into the Slice 3 `CapabilityInventory` contract.
 * `has(intent)` answers true iff at least one available descriptor covers it,
 * regardless of tier. `list()` returns the sorted set of covered intents.
 */
function buildCapabilityInventory(resolved) {
    const covered = new Set();
    for (const d of resolved.available)
        covered.add(d.intent);
    return {
        has(capability) {
            return covered.has(capability);
        },
        list() {
            return Array.from(covered).sort();
        },
    };
}
/**
 * Helper: which tiers cover the given intent in this resolved catalog?
 * Used by `policy.selectExecutor` and by Slice 6's parity matrix.
 */
function tiersCoveringIntent(resolved, intent) {
    const tiers = new Set();
    for (const d of resolved.available) {
        if (d.intent === intent)
            tiers.add(d.tier);
    }
    return Array.from(tiers).sort((a, b) => a - b);
}
//# sourceMappingURL=inventory.js.map