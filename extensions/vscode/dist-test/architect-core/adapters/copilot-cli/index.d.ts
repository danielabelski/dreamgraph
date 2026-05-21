export { COPILOT_AUTHORITATIVE_TOOL_CATALOG, COPILOT_BRIDGE_LOCAL_AUTHORITATIVE_TOOLS, COPILOT_CLI_PROVIDER_ID, COPILOT_INLINE_TOOL_SERVER, COPILOT_MINIMUM_AUTHORITATIVE_TOOLS, COPILOT_NATIVE_COMMAND_TOOLS, COPILOT_REQUIRED_AUTHORITATIVE_TOOLS, DREAMGRAPH_AUTHORITATIVE_SERVER_NAME, type AuthoritativeAllowlist, type CopilotArgvInput, type CopilotArgvPlan, type CopilotAuthoritativeToolName, type CopilotCliErrorCode, type CopilotCliProviderId, type CopilotHelpSurface, type CopilotMcpConfigArtifact, type CopilotMcpConfigInput, type DreamgraphAuthoritativeServerName, type ToolCallClass, type ToolCallClassificationContext, type ToolCallObservation, } from "./types.js";
export { isHelpSurfaceSupported, parseCopilotHelpSurface, } from "./help-probe.js";
export { buildCopilotMcpConfig, serializeCopilotMcpConfig, } from "./mcp-config.js";
export { buildAuthoritativeAllowlist } from "./allowlist.js";
export { buildCopilotArgv } from "./argv.js";
export { classifyToolCall } from "./transcript-classifier.js";
export { normalizeCopilotTranscript, type CopilotCliTranscript, } from "./transcript.js";
export { type CopilotCliClockPort, type CopilotCliCryptoPort, type CopilotCliFsPort, type CopilotCliHelpResult, type CopilotCliMcpAuditPort, type CopilotCliProcessPort, type CopilotCliRegistryPort, type CopilotCliResolveResult, type CopilotCliSpawnInput, type CopilotCliSpawnResult, type CopilotMcpBridgeSpawn, type RecordedMcpToolCall, } from "./orchestrator-ports.js";
export { runCopilotCli, type ClassifiedToolCall, type CopilotCliDeps, type CopilotCliFailure, type CopilotCliRunInput, type CopilotCliRunResult, } from "./orchestrator.js";
export { createCopilotCliEventStream, type CliJsonAssistantDeltaEvent, type CliJsonAssistantMessageEvent, type CliJsonEvent, type CliJsonOtherEvent, type CliJsonResultEvent, type CliJsonToolCompleteEvent, type CliJsonToolStartEvent, type CopilotCliEventStream, } from "./event-stream.js";
export { HOST_CLOCK, HOST_CRYPTO, HOST_FS, HOST_PROCESS, auditFilePathFor, bridgeEnvForRun, createHostAudit, createHostAuditLive, createHostRegistry, probeDreamgraphHttpMcp, type HostAuditLiveOptions, type HostAuditOptions, type HostRegistryOptions, } from "./host/index.js";
export { serializeConversationForCopilotCli, type SerializeConversationOptions, type CliToolsManifest, CURRENT_TURN_OPEN_MARKER, CURRENT_TURN_CLOSE_MARKER, } from "./prompt-serializer.js";
export { createCopilotCliProviderPort, type CopilotCliProviderPortOptions, type PromptComposedInfo, } from "./provider-port.js";
//# sourceMappingURL=index.d.ts.map