import { type CodexConfigOverride, type CodexMcpBridgePlan, type CodexMcpBridgePlanInput, type CodexMcpConfigArtifact, type CodexMcpConfigInput } from "./types.js";
export declare function buildCodexMcpConfig(input: CodexMcpConfigInput): CodexMcpConfigArtifact;
export declare function buildCodexMcpConfigOverrides(input: CodexMcpConfigInput): readonly CodexConfigOverride[];
export declare function buildCodexMcpBridgePlan(input: CodexMcpBridgePlanInput): CodexMcpBridgePlan;
export declare function serializeCodexMcpConfig(artifact: CodexMcpConfigArtifact): string;
//# sourceMappingURL=mcp-config.d.ts.map