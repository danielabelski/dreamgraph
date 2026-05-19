// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Copilot CLI adapter — public barrel (Slice 1).
//
// The adapter is consumed only through this barrel. Architect core
// MUST NOT import from any sibling file directly. Slice 1 ships only
// the pure modules; the live `ProviderPort` implementation that wires
// these into `child_process.spawn` lands in a follow-up slice.

export {
  COPILOT_CLI_PROVIDER_ID,
  COPILOT_INLINE_TOOL_SERVER,
  COPILOT_REQUIRED_AUTHORITATIVE_TOOLS,
  DREAMGRAPH_AUTHORITATIVE_SERVER_NAME,
  type AuthoritativeAllowlist,
  type CopilotArgvInput,
  type CopilotArgvPlan,
  type CopilotAuthoritativeToolName,
  type CopilotCliErrorCode,
  type CopilotCliProviderId,
  type CopilotHelpSurface,
  type CopilotMcpConfigArtifact,
  type CopilotMcpConfigInput,
  type DreamgraphAuthoritativeServerName,
  type ToolCallClass,
  type ToolCallClassificationContext,
  type ToolCallObservation,
} from "./types.js";

export {
  isHelpSurfaceSupported,
  parseCopilotHelpSurface,
} from "./help-probe.js";

export {
  buildCopilotMcpConfig,
  serializeCopilotMcpConfig,
} from "./mcp-config.js";

export { buildAuthoritativeAllowlist } from "./allowlist.js";

export { buildCopilotArgv } from "./argv.js";

export { classifyToolCall } from "./transcript-classifier.js";

export {
  normalizeCopilotTranscript,
  type CopilotCliTranscript,
} from "./transcript.js";

export {
  type CopilotCliClockPort,
  type CopilotCliCryptoPort,
  type CopilotCliFsPort,
  type CopilotCliHelpResult,
  type CopilotCliMcpAuditPort,
  type CopilotCliProcessPort,
  type CopilotCliRegistryPort,
  type CopilotCliResolveResult,
  type CopilotCliSpawnInput,
  type CopilotCliSpawnResult,
  type CopilotMcpBridgeSpawn,
  type RecordedMcpToolCall,
} from "./orchestrator-ports.js";

export {
  runCopilotCli,
  type ClassifiedToolCall,
  type CopilotCliDeps,
  type CopilotCliFailure,
  type CopilotCliRunInput,
  type CopilotCliRunResult,
} from "./orchestrator.js";

// NDJSON stdout event stream for `--output-format json` (always
// emitted by argv.ts). Authoritative runtime source for tool-call
// surfacing and per-token assistant text streaming.
export {
  createCopilotCliEventStream,
  type CliJsonAssistantDeltaEvent,
  type CliJsonAssistantMessageEvent,
  type CliJsonEvent,
  type CliJsonOtherEvent,
  type CliJsonResultEvent,
  type CliJsonToolCompleteEvent,
  type CliJsonToolStartEvent,
  type CopilotCliEventStream,
} from "./event-stream.js";

// Real host runtime adapters. The four stable ports (fs/process/
// crypto/clock) are exported as singletons. The two ports that depend
// on the DreamGraph stdio MCP server (`registry`, `mcpAudit`) ship as
// factories so the host can supply absolute paths to the dreamgraph
// binary, the bridge entry, and the per-run audit directory.
export {
  HOST_CLOCK,
  HOST_CRYPTO,
  HOST_FS,
  HOST_PROCESS,
  auditFilePathFor,
  bridgeEnvForRun,
  createHostAudit,
  createHostAuditLive,
  createHostRegistry,
  probeDreamgraphHttpMcp,
  type HostAuditLiveOptions,
  type HostAuditOptions,
  type HostRegistryOptions,
} from "./host/index.js";

// Pure prompt serializer used by the provider-port wrapper. Exposed
// so callers (and tests) can reproduce the exact byte stream the CLI
// surface receives without standing up the full provider port.
export {
  serializeConversationForCopilotCli,
  type SerializeConversationOptions,
  type CliToolsManifest,
  CURRENT_TURN_OPEN_MARKER,
  CURRENT_TURN_CLOSE_MARKER,
} from "./prompt-serializer.js";

// Slice 4: live `ProviderPort` implementation that drives the Slice 2
// orchestrator from the architect-core seam.
export {
  createCopilotCliProviderPort,
  type CopilotCliProviderPortOptions,
  type PromptComposedInfo,
} from "./provider-port.js";
