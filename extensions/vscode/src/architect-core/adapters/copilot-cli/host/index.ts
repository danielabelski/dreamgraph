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

export { HOST_FS } from "./fs-adapter.js";
export { HOST_PROCESS } from "./process-adapter.js";
export { HOST_CRYPTO } from "./crypto-adapter.js";
export { HOST_CLOCK } from "./clock-adapter.js";

export {
  auditFilePathFor,
  createHostAudit,
  type HostAuditOptions,
} from "./audit-adapter.js";

export {
  bridgeEnvForRun,
  createHostRegistry,
  probeDreamgraphStdio,
  type HostRegistryOptions,
} from "./registry-adapter.js";
