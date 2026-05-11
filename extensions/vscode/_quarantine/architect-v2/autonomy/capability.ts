// architect-v2/autonomy/capability.ts
// Slice 3 — CapabilityInventory shape + Slice 3 stub builder.
//
// STRICT ISOLATION (ADR-140): no import from v1.
//
// Per Slice 3 directive 3.G: this slice ships the SHAPE and a static stub.
// Slice 4 (MCP-first execution policy) replaces the stub with a live producer
// that reflects the active MCP tool roster, workspace permissions, and
// provider availability.

/**
 * Closed read-only view over what the system can do RIGHT NOW.
 * The decision engine consults this to filter `ActionCandidate.requiresCapabilities`.
 *
 * Capability identifiers are free-form strings by design — Slice 4 owns the
 * canonical list. Slice 3 callers should treat capability names as opaque.
 */
export interface CapabilityInventory {
  has(capability: string): boolean;
  list(): readonly string[];
}

/**
 * Slice 3 stub. Returns an inventory containing a small fixed allowlist so
 * the decision engine has something to filter against in unit tests and
 * during early Slice 4 wiring.
 *
 * Slice 4 MUST replace this with a live producer.
 */
export function createStubCapabilityInventory(
  extra: readonly string[] = [],
): CapabilityInventory {
  const base = new Set<string>([
    "workspace.read",
    "workspace.write",
    "terminal.run",
    "mcp.query",
    "mcp.mutate",
    "mcp.verify",
    "vscode.command",
  ]);
  for (const c of extra) base.add(c);
  return {
    has(capability: string): boolean {
      return base.has(capability);
    },
    list(): readonly string[] {
      return Array.from(base).sort();
    },
  };
}

/**
 * Builds an inventory from an explicit set. Useful for tests that want
 * narrow capability surfaces.
 */
export function createCapabilityInventory(
  capabilities: Iterable<string>,
): CapabilityInventory {
  const set = new Set<string>(capabilities);
  return {
    has(capability: string): boolean {
      return set.has(capability);
    },
    list(): readonly string[] {
      return Array.from(set).sort();
    },
  };
}
