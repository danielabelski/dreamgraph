// architect-v2/host/chat-panel/index.ts
// M7 — Public surface of the v2 ChatPanel host.

export { ArchitectV2Panel, type ArchitectV2PanelOptions } from "./panel.js";
export type {
  AutonomyModeId,
  BudgetView,
  HostToWebview,
  PanelInitState,
  PanelStatus,
  TraceEntry,
  WebviewToHost,
} from "./messages.js";
