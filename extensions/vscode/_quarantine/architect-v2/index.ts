// architect-v2 — Public surface
// Loaded by extensions/vscode/src/extension.ts when the v2 feature flag is on.
// All v2 work lands here per ADR-140 (parallel folder).
// Do not import from v1 files; the two surfaces are isolated until the v10.0.0 cutover (ADR-141).

export const ARCHITECT_V2_SKELETON_VERSION = "0.0.0-slice1";

// Slice 8A.5: host wiring is the single entry point the cutover commit
// will call. extension.ts: createArchitectHost({...}) → host.runPass(...).
export {
  createArchitectHost,
  InMemoryKeyValueStore,
  UnboundMcpClient,
  type ArchitectHost,
  type ArchitectHostOptions,
  type ContextDiscoveryRecorder,
  type ExecutorPort,
  type FallbackSignalProvider,
  type HostRunPassInput,
  type KeyValueStore,
  type McpClient,
  type MemoryPort,
  type OrchestratorPorts,
  type PassResult,
  type ProjectGraphReader,
  type ProjectGraphRecorder,
} from "./host/index.js";
