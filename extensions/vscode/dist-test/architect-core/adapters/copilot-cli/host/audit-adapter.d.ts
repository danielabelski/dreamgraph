import type { CopilotCliMcpAuditPort, RecordedMcpToolCall } from "../orchestrator-ports.js";
export interface HostAuditOptions {
    /**
     * Absolute path to the directory the bridge writes audit files into.
     * The orchestrator typically points this at
     * `<copilotHome>/audit/` so it lands inside the per-run scratch
     * directory and is scrubbed by the same `rmRecursive` cleanup.
     */
    readonly auditDirAbsPath: string;
}
/**
 * Compute the audit NDJSON path for a given run. The bridge calls the
 * same function so adapter and bridge stay in lockstep without sharing
 * a runtime module.
 */
export declare function auditFilePathFor(auditDirAbsPath: string, runId: string): string;
export declare function createHostAudit(opts: HostAuditOptions): CopilotCliMcpAuditPort;
/**
 * Parse one NDJSON line written by the bridge into a frozen
 * `RecordedMcpToolCall`, or return `null` if the line is not a
 * well-formed audit record. Shared with the live tail reader
 * (`audit-live-adapter.ts`) so both readers agree on the wire format.
 */
export declare function parseRecordOrNull(line: string): RecordedMcpToolCall | null;
//# sourceMappingURL=audit-adapter.d.ts.map