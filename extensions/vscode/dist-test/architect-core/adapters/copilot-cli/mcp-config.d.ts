import { type CopilotMcpConfigArtifact, type CopilotMcpConfigInput } from "./types.js";
/**
 * Build the MCP config artifact for a Copilot CLI run.
 *
 * Throws `Error` only on programmer error (empty runId, empty
 * command, empty allowlist) — these should never occur at runtime
 * because the caller has already passed allowlist/registry checks.
 */
export declare function buildCopilotMcpConfig(input: CopilotMcpConfigInput): CopilotMcpConfigArtifact;
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
export declare function serializeCopilotMcpConfig(artifact: CopilotMcpConfigArtifact): string;
//# sourceMappingURL=mcp-config.d.ts.map