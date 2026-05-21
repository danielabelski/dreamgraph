"use strict";
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Copilot CLI adapter — public barrel (Slice 1).
//
// The adapter is consumed only through this barrel. Architect core
// MUST NOT import from any sibling file directly. Slice 1 ships only
// the pure modules; the live `ProviderPort` implementation that wires
// these into `child_process.spawn` lands in a follow-up slice.
Object.defineProperty(exports, "__esModule", { value: true });
exports.createCopilotCliProviderPort = exports.CURRENT_TURN_CLOSE_MARKER = exports.CURRENT_TURN_OPEN_MARKER = exports.serializeConversationForCopilotCli = exports.probeDreamgraphHttpMcp = exports.createHostRegistry = exports.createHostAuditLive = exports.createHostAudit = exports.bridgeEnvForRun = exports.auditFilePathFor = exports.HOST_PROCESS = exports.HOST_FS = exports.HOST_CRYPTO = exports.HOST_CLOCK = exports.createCopilotCliEventStream = exports.runCopilotCli = exports.normalizeCopilotTranscript = exports.classifyToolCall = exports.buildCopilotArgv = exports.buildAuthoritativeAllowlist = exports.serializeCopilotMcpConfig = exports.buildCopilotMcpConfig = exports.parseCopilotHelpSurface = exports.isHelpSurfaceSupported = exports.DREAMGRAPH_AUTHORITATIVE_SERVER_NAME = exports.COPILOT_REQUIRED_AUTHORITATIVE_TOOLS = exports.COPILOT_NATIVE_COMMAND_TOOLS = exports.COPILOT_MINIMUM_AUTHORITATIVE_TOOLS = exports.COPILOT_INLINE_TOOL_SERVER = exports.COPILOT_CLI_PROVIDER_ID = exports.COPILOT_BRIDGE_LOCAL_AUTHORITATIVE_TOOLS = exports.COPILOT_AUTHORITATIVE_TOOL_CATALOG = void 0;
var types_js_1 = require("./types.js");
Object.defineProperty(exports, "COPILOT_AUTHORITATIVE_TOOL_CATALOG", { enumerable: true, get: function () { return types_js_1.COPILOT_AUTHORITATIVE_TOOL_CATALOG; } });
Object.defineProperty(exports, "COPILOT_BRIDGE_LOCAL_AUTHORITATIVE_TOOLS", { enumerable: true, get: function () { return types_js_1.COPILOT_BRIDGE_LOCAL_AUTHORITATIVE_TOOLS; } });
Object.defineProperty(exports, "COPILOT_CLI_PROVIDER_ID", { enumerable: true, get: function () { return types_js_1.COPILOT_CLI_PROVIDER_ID; } });
Object.defineProperty(exports, "COPILOT_INLINE_TOOL_SERVER", { enumerable: true, get: function () { return types_js_1.COPILOT_INLINE_TOOL_SERVER; } });
Object.defineProperty(exports, "COPILOT_MINIMUM_AUTHORITATIVE_TOOLS", { enumerable: true, get: function () { return types_js_1.COPILOT_MINIMUM_AUTHORITATIVE_TOOLS; } });
Object.defineProperty(exports, "COPILOT_NATIVE_COMMAND_TOOLS", { enumerable: true, get: function () { return types_js_1.COPILOT_NATIVE_COMMAND_TOOLS; } });
Object.defineProperty(exports, "COPILOT_REQUIRED_AUTHORITATIVE_TOOLS", { enumerable: true, get: function () { return types_js_1.COPILOT_REQUIRED_AUTHORITATIVE_TOOLS; } });
Object.defineProperty(exports, "DREAMGRAPH_AUTHORITATIVE_SERVER_NAME", { enumerable: true, get: function () { return types_js_1.DREAMGRAPH_AUTHORITATIVE_SERVER_NAME; } });
var help_probe_js_1 = require("./help-probe.js");
Object.defineProperty(exports, "isHelpSurfaceSupported", { enumerable: true, get: function () { return help_probe_js_1.isHelpSurfaceSupported; } });
Object.defineProperty(exports, "parseCopilotHelpSurface", { enumerable: true, get: function () { return help_probe_js_1.parseCopilotHelpSurface; } });
var mcp_config_js_1 = require("./mcp-config.js");
Object.defineProperty(exports, "buildCopilotMcpConfig", { enumerable: true, get: function () { return mcp_config_js_1.buildCopilotMcpConfig; } });
Object.defineProperty(exports, "serializeCopilotMcpConfig", { enumerable: true, get: function () { return mcp_config_js_1.serializeCopilotMcpConfig; } });
var allowlist_js_1 = require("./allowlist.js");
Object.defineProperty(exports, "buildAuthoritativeAllowlist", { enumerable: true, get: function () { return allowlist_js_1.buildAuthoritativeAllowlist; } });
var argv_js_1 = require("./argv.js");
Object.defineProperty(exports, "buildCopilotArgv", { enumerable: true, get: function () { return argv_js_1.buildCopilotArgv; } });
var transcript_classifier_js_1 = require("./transcript-classifier.js");
Object.defineProperty(exports, "classifyToolCall", { enumerable: true, get: function () { return transcript_classifier_js_1.classifyToolCall; } });
var transcript_js_1 = require("./transcript.js");
Object.defineProperty(exports, "normalizeCopilotTranscript", { enumerable: true, get: function () { return transcript_js_1.normalizeCopilotTranscript; } });
var orchestrator_js_1 = require("./orchestrator.js");
Object.defineProperty(exports, "runCopilotCli", { enumerable: true, get: function () { return orchestrator_js_1.runCopilotCli; } });
// NDJSON stdout event stream for `--output-format json` (always
// emitted by argv.ts). Authoritative runtime source for tool-call
// surfacing and per-token assistant text streaming.
var event_stream_js_1 = require("./event-stream.js");
Object.defineProperty(exports, "createCopilotCliEventStream", { enumerable: true, get: function () { return event_stream_js_1.createCopilotCliEventStream; } });
// Real host runtime adapters. The four stable ports (fs/process/
// crypto/clock) are exported as singletons. The two ports that depend
// on the DreamGraph stdio MCP server (`registry`, `mcpAudit`) ship as
// factories so the host can supply absolute paths to the dreamgraph
// binary, the bridge entry, and the per-run audit directory.
var index_js_1 = require("./host/index.js");
Object.defineProperty(exports, "HOST_CLOCK", { enumerable: true, get: function () { return index_js_1.HOST_CLOCK; } });
Object.defineProperty(exports, "HOST_CRYPTO", { enumerable: true, get: function () { return index_js_1.HOST_CRYPTO; } });
Object.defineProperty(exports, "HOST_FS", { enumerable: true, get: function () { return index_js_1.HOST_FS; } });
Object.defineProperty(exports, "HOST_PROCESS", { enumerable: true, get: function () { return index_js_1.HOST_PROCESS; } });
Object.defineProperty(exports, "auditFilePathFor", { enumerable: true, get: function () { return index_js_1.auditFilePathFor; } });
Object.defineProperty(exports, "bridgeEnvForRun", { enumerable: true, get: function () { return index_js_1.bridgeEnvForRun; } });
Object.defineProperty(exports, "createHostAudit", { enumerable: true, get: function () { return index_js_1.createHostAudit; } });
Object.defineProperty(exports, "createHostAuditLive", { enumerable: true, get: function () { return index_js_1.createHostAuditLive; } });
Object.defineProperty(exports, "createHostRegistry", { enumerable: true, get: function () { return index_js_1.createHostRegistry; } });
Object.defineProperty(exports, "probeDreamgraphHttpMcp", { enumerable: true, get: function () { return index_js_1.probeDreamgraphHttpMcp; } });
// Pure prompt serializer used by the provider-port wrapper. Exposed
// so callers (and tests) can reproduce the exact byte stream the CLI
// surface receives without standing up the full provider port.
var prompt_serializer_js_1 = require("./prompt-serializer.js");
Object.defineProperty(exports, "serializeConversationForCopilotCli", { enumerable: true, get: function () { return prompt_serializer_js_1.serializeConversationForCopilotCli; } });
Object.defineProperty(exports, "CURRENT_TURN_OPEN_MARKER", { enumerable: true, get: function () { return prompt_serializer_js_1.CURRENT_TURN_OPEN_MARKER; } });
Object.defineProperty(exports, "CURRENT_TURN_CLOSE_MARKER", { enumerable: true, get: function () { return prompt_serializer_js_1.CURRENT_TURN_CLOSE_MARKER; } });
// Slice 4: live `ProviderPort` implementation that drives the Slice 2
// orchestrator from the architect-core seam.
var provider_port_js_1 = require("./provider-port.js");
Object.defineProperty(exports, "createCopilotCliProviderPort", { enumerable: true, get: function () { return provider_port_js_1.createCopilotCliProviderPort; } });
//# sourceMappingURL=index.js.map