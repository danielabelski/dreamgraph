// architect-core — v1-native turn-lifecycle seam (ADR-089).
//
// Phase 2: ports + types + pure `runPass()` driver. The driver owns
// the inner agentic loop (provider → tools → provider → … until the
// pass goal is satisfied) and delegates every effect to a port.
// Adapters wiring real chat-panel internals ship in Phase 3.
//
// STRICT v1: this folder MUST NOT import from `architect-v2/`.
// ADR-140 isolation remains binding in both directions.

export type {
  AutonomyContract,
  IterationOutcome,
  PassGoal,
  PassResult,
  PassStopReason,
  PromptParts,
  ProviderProposal,
  TaskGoal,
  ToolInvocationRecord,
  UserIntent,
  Verdict,
} from "./types.js";

export type {
  ArchitectCorePorts,
  AttachmentPort,
  AutonomyPort,
  BuildContextInput,
  CallProviderInput,
  ClockPort,
  ComposePromptInput,
  ContextBuilderPort,
  ExecuteToolInput,
  MemoryPort,
  PromptComposerPort,
  ProviderPort,
  ToolExecutorPort,
} from "./ports.js";

export type { RunPassInput } from "./pass.js";
export { runPass, DEFAULT_MAX_INNER_ITERATIONS } from "./pass.js";

// Phase 3a host accessor type — pure interface, no v1 imports. Adapters
// and the runner that wires them live in their own modules so the seam
// barrel stays free of vscode/prompts/architect-llm transitive imports.
// The chat-panel imports the runner directly from `./architect-core/runner.js`.
export type { ChatPanelHost } from "./adapters/host.js";
export { SYSTEM_CLOCK } from "./adapters/clock.js";
