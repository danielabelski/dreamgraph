import { type AuthoritativeAllowlist } from "./types.js";
/**
 * Compute the audited allowlist from the live DreamGraph bridge tool
 * registry.
 *
 * @param liveToolNames tool names actually exposed by the in-process
 *   DreamGraph MCP bridge (order-insensitive, duplicates ignored).
 */
export declare function buildAuthoritativeAllowlist(liveToolNames: readonly string[]): AuthoritativeAllowlist;
//# sourceMappingURL=allowlist.d.ts.map