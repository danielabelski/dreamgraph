"use strict";
// architect-v2/autonomy/capability.ts
// Slice 3 — CapabilityInventory shape + Slice 3 stub builder.
//
// STRICT ISOLATION (ADR-140): no import from v1.
//
// Per Slice 3 directive 3.G: this slice ships the SHAPE and a static stub.
// Slice 4 (MCP-first execution policy) replaces the stub with a live producer
// that reflects the active MCP tool roster, workspace permissions, and
// provider availability.
Object.defineProperty(exports, "__esModule", { value: true });
exports.createStubCapabilityInventory = createStubCapabilityInventory;
exports.createCapabilityInventory = createCapabilityInventory;
/**
 * Slice 3 stub. Returns an inventory containing a small fixed allowlist so
 * the decision engine has something to filter against in unit tests and
 * during early Slice 4 wiring.
 *
 * Slice 4 MUST replace this with a live producer.
 */
function createStubCapabilityInventory(extra = []) {
    const base = new Set([
        "workspace.read",
        "workspace.write",
        "terminal.run",
        "mcp.query",
        "mcp.mutate",
        "mcp.verify",
        "vscode.command",
    ]);
    for (const c of extra)
        base.add(c);
    return {
        has(capability) {
            return base.has(capability);
        },
        list() {
            return Array.from(base).sort();
        },
    };
}
/**
 * Builds an inventory from an explicit set. Useful for tests that want
 * narrow capability surfaces.
 */
function createCapabilityInventory(capabilities) {
    const set = new Set(capabilities);
    return {
        has(capability) {
            return set.has(capability);
        },
        list() {
            return Array.from(set).sort();
        },
    };
}
//# sourceMappingURL=capability.js.map