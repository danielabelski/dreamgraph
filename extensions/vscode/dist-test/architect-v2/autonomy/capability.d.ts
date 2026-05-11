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
export declare function createStubCapabilityInventory(extra?: readonly string[]): CapabilityInventory;
/**
 * Builds an inventory from an explicit set. Useful for tests that want
 * narrow capability surfaces.
 */
export declare function createCapabilityInventory(capabilities: Iterable<string>): CapabilityInventory;
//# sourceMappingURL=capability.d.ts.map