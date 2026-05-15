"use strict";
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Copilot CLI adapter — host runtime ports.
//
// Slice 3 (stable adapters) ships:
//   - HOST_FS       (node:fs/promises + node:os + node:path)
//   - HOST_PROCESS  (node:child_process + manual PATH walk)
//   - HOST_CRYPTO   (node:crypto)
//   - HOST_CLOCK    (Date.now)
//
// Slice 3b (DreamGraph bridge + audit) ships:
//   - createHostAudit({ auditDirAbsPath })       → CopilotCliMcpAuditPort
//   - createHostRegistry({ … })                  → CopilotCliRegistryPort
//   - bridgeEnvForRun({ auditDirAbsPath, runId}) → run-scoped env overlay
//   - probeDreamgraphStdio(…)                    → liveness probe
//   - auditFilePathFor(dir, runId)               → bridge↔adapter contract
//
// The bridge entry point (`bridge-entry.ts`) is bundled to its own
// standalone artifact (`dist/copilot-cli-bridge.js`) and is NOT
// re-exported from a runtime barrel; consumers refer to it by absolute
// disk path because Copilot CLI launches it as a separate process.
Object.defineProperty(exports, "__esModule", { value: true });
exports.probeDreamgraphStdio = exports.createHostRegistry = exports.bridgeEnvForRun = exports.createHostAudit = exports.auditFilePathFor = exports.HOST_CLOCK = exports.HOST_CRYPTO = exports.HOST_PROCESS = exports.HOST_FS = void 0;
var fs_adapter_js_1 = require("./fs-adapter.js");
Object.defineProperty(exports, "HOST_FS", { enumerable: true, get: function () { return fs_adapter_js_1.HOST_FS; } });
var process_adapter_js_1 = require("./process-adapter.js");
Object.defineProperty(exports, "HOST_PROCESS", { enumerable: true, get: function () { return process_adapter_js_1.HOST_PROCESS; } });
var crypto_adapter_js_1 = require("./crypto-adapter.js");
Object.defineProperty(exports, "HOST_CRYPTO", { enumerable: true, get: function () { return crypto_adapter_js_1.HOST_CRYPTO; } });
var clock_adapter_js_1 = require("./clock-adapter.js");
Object.defineProperty(exports, "HOST_CLOCK", { enumerable: true, get: function () { return clock_adapter_js_1.HOST_CLOCK; } });
var audit_adapter_js_1 = require("./audit-adapter.js");
Object.defineProperty(exports, "auditFilePathFor", { enumerable: true, get: function () { return audit_adapter_js_1.auditFilePathFor; } });
Object.defineProperty(exports, "createHostAudit", { enumerable: true, get: function () { return audit_adapter_js_1.createHostAudit; } });
var registry_adapter_js_1 = require("./registry-adapter.js");
Object.defineProperty(exports, "bridgeEnvForRun", { enumerable: true, get: function () { return registry_adapter_js_1.bridgeEnvForRun; } });
Object.defineProperty(exports, "createHostRegistry", { enumerable: true, get: function () { return registry_adapter_js_1.createHostRegistry; } });
Object.defineProperty(exports, "probeDreamgraphStdio", { enumerable: true, get: function () { return registry_adapter_js_1.probeDreamgraphStdio; } });
//# sourceMappingURL=index.js.map