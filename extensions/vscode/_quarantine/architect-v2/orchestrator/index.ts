// STRICT ISOLATION (ADR-140): no import from v1.
// Slice 8A.1 — Public surface of the orchestrator module.

export type {
  UserIntent,
  UserAttachment,
  ContextEnvelope,
  ContextSection,
  PromptParts,
  PassResult,
  ProviderProposal,
} from "./types.js";

export type {
  ContextBuilderPort,
  PromptComposerPort,
  ExecutorPort,
  MemoryPort,
  ClockPort,
  OrchestratorPorts,
  BuildContextInput,
  ComposePromptInput,
  CallProviderInput,
  ExecuteCapabilityInput,
  PassLog,
} from "./ports.js";
export { SYSTEM_CLOCK } from "./ports.js";

export type {
  ProjectGraphNodeId,
  ProjectGraphNodeKind,
  ProjectGraphNode,
  ProjectGraphEdge,
  ProjectSubgraph,
  GraphScope,
  GraphRichness,
  GraphRichnessSignal,
  ProjectGraphQuery,
  NeighborOptions,
  DecisionRecord,
  OutcomeRecord,
  ProjectGraphReader,
  ProjectGraphRecorder,
} from "./project-graph.js";
export {
  NULL_PROJECT_SUBGRAPH,
  NULL_RICHNESS_SIGNAL,
  NullProjectGraphReader,
  NullProjectGraphRecorder,
} from "./project-graph.js";

export type { RunPassInput } from "./loop.js";
export { runPass } from "./loop.js";

// 8A.3 + 8A.4: DreamGraph adapters for ProjectGraphReader,
// ProjectGraphRecorder, and ContextDiscoveryRecorder. Live under
// orchestrator/adapters/dreamgraph/ per ADR-171 guard rail. Re-exported
// here so 8A.5 host wiring can import them without crossing module
// boundaries.
export {
  DreamGraphReaderAdapter,
  DreamGraphRecorderAdapter,
  UnboundMcpClient,
  type DreamGraphReaderAdapterOptions,
  type DreamGraphRecorderAdapterOptions,
  type McpClient,
} from "./adapters/dreamgraph/index.js";
