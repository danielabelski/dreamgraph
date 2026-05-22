import type { ArchitectLlm } from "../../../architect-llm.js";
import type { ProviderPort } from "../../ports.js";
import { type CodexCliDeps, type CodexCliRunResult } from "./orchestrator.js";
import { type CliToolsManifest } from "./prompt-serializer.js";
import type { CodexCliMcpAuditLivePort, RecordedMcpToolCall } from "./orchestrator-ports.js";
export interface CodexCliProviderPortOptions {
    readonly hostLlm: ArchitectLlm;
    readonly invocationCwd: string;
    readonly timeoutMs: number;
    readonly idleTimeoutMs?: number;
    readonly baseEnv: Readonly<Record<string, string | undefined>>;
    readonly model?: string;
    readonly profile?: string;
    readonly binaryName?: string;
    readonly configOverrides?: readonly {
        readonly key: string;
        readonly value: string | number | boolean;
    }[];
    readonly deps: CodexCliDeps;
    readonly onRunResult?: (result: CodexCliRunResult) => void;
    readonly auditLive?: CodexCliMcpAuditLivePort;
    readonly onToolCall?: (runId: string, call: RecordedMcpToolCall) => void;
    readonly historyKeepLast?: number;
    readonly markCurrentTurn?: boolean;
    readonly cliToolsManifest?: CliToolsManifest;
    readonly onPromptComposed?: (info: PromptComposedInfo) => void;
}
export interface PromptComposedInfo {
    readonly promptByteLength: number;
    readonly historyMessageCount: number;
    readonly mcpToolsAdvertised: number;
    readonly mcpServerAdvertised: string | null;
    readonly markCurrentTurn: boolean;
    readonly model: string | null;
}
export declare function createCodexCliProviderPort(options: CodexCliProviderPortOptions): ProviderPort;
//# sourceMappingURL=provider-port.d.ts.map