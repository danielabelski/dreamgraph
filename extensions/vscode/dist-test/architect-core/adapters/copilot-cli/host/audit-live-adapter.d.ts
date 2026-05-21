import type { CopilotCliMcpAuditLivePort } from "../orchestrator-ports.js";
/** Live `resultJson` size cap. Post-run batch is unaffected. */
export declare const MAX_LIVE_RESULT_JSON_BYTES: number;
export interface HostAuditLiveOptions {
    /** Same dir the orchestrator passes to {@link createHostAudit}. */
    readonly auditDirAbsPath: string;
    /**
     * Stat-heartbeat interval in ms. Defaults to 250. Exposed for
     * profiling only — production callers should rely on the default.
     * Values <= 0 disable the heartbeat (fs.watch only).
     */
    readonly heartbeatMs?: number;
}
export declare function createHostAuditLive(opts: HostAuditLiveOptions): CopilotCliMcpAuditLivePort;
//# sourceMappingURL=audit-live-adapter.d.ts.map