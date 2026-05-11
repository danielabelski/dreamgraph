import type { CapabilityInventory } from "../autonomy/index.js";
import type { CapabilityId } from "../capabilities/index.js";
import type { ToolOutcome } from "../execution/index.js";
import type { ProviderProfile } from "../providers/index.js";
import type { ContextEnvelope, ProviderProposal, PromptParts, UserIntent } from "./types.js";
import type { TaskState } from "../autonomy/index.js";
import type { ProjectGraphReader, ProjectGraphRecorder } from "./project-graph.js";
import type { ContextRequirementManifest, DeclareRequirementsInput } from "../prompts/requirements.js";
export interface BuildContextInput {
    readonly taskState: TaskState;
    readonly userIntent: UserIntent;
    readonly providerProfile: ProviderProfile;
    /**
     * ADR-174: advisory manifest declared by the PromptComposer. The
     * assembler MUST treat this as a wishlist — it MAY satisfy fewer
     * kinds than requested (sparse mode, budget pressure) but MUST NOT
     * fetch beyond the declared kinds without an ADR amendment. May be
     * undefined when the orchestrator runs without a composer (rare).
     */
    readonly requirements?: ContextRequirementManifest;
    /**
     * Slice 8A.5: explicit total token window the assembler must size
     * the envelope against. The host resolves this from
     * providerProfile.<resolved model>.contextWindow once at session
     * start; the builder treats it as authoritative when present and
     * falls back to a conservative internal default otherwise.
     */
    readonly windowTokens?: number;
}
export interface ContextBuilderPort {
    /**
     * Build a context envelope sized to the provider window. Implementations
     * MUST be MCP-first (ADR-144) and MUST respect ADR-097 reserves.
     */
    buildContext(input: BuildContextInput): Promise<ContextEnvelope>;
}
export interface ComposePromptInput {
    readonly contextEnvelope: ContextEnvelope;
    readonly userIntent: UserIntent;
    readonly providerProfile: ProviderProfile;
    readonly autonomyContract: string;
}
export interface PromptComposerPort {
    /**
     * ADR-174: declare context requirements before the assembler runs.
     * Pure: same inputs → deeply-equal manifest. No I/O.
     */
    declareRequirements(input: DeclareRequirementsInput): ContextRequirementManifest;
    composePrompt(input: ComposePromptInput): Promise<PromptParts>;
}
export interface CallProviderInput {
    readonly prompt: PromptParts;
    readonly providerProfile: ProviderProfile;
    readonly inventory: CapabilityInventory;
}
export interface ExecuteCapabilityInput {
    readonly capabilityId: CapabilityId;
    /**
     * When the provider explicitly named a tool, pass it here. The
     * executor MUST validate the tool belongs to a tier covering the
     * capability's intent set (Slice 4 invariant). When omitted, the
     * executor resolves a tool via Slice 6 chooseCapabilityPath +
     * Slice 4 selectExecutor.
     */
    readonly toolName?: string;
    readonly toolArgs?: Readonly<Record<string, unknown>>;
    /**
     * Reason the orchestrator is invoking this capability. Verification
     * invocations carry the kind (build/test/...) so the executor can
     * stamp `VerificationEvidence` correctly on the outcome.
     */
    readonly invocationReason: {
        kind: "user_action";
    } | {
        kind: "verification";
        verificationKind: "build" | "test" | "type" | "lint" | "mcp_verify" | "invariant";
    } | {
        kind: "enrichment";
    };
}
export interface ExecutorPort {
    /** Send the composed prompt to the provider; returns ranked candidates. */
    callProvider(input: CallProviderInput): Promise<ProviderProposal>;
    /**
     * Execute a single capability: handles Slice 6 path selection + Slice 4
     * tier walk + tool invocation; returns the canonical Slice 4 outcome.
     */
    executeCapability(input: ExecuteCapabilityInput): Promise<ToolOutcome>;
}
export interface MemoryPort {
    /** Persist a task state snapshot at end-of-pass. */
    saveTaskState(state: TaskState): Promise<void>;
    /** Load a task by id (used to resume across reloads). */
    loadTaskState(id: string): Promise<TaskState | undefined>;
    /** Append a pass-end record (cards, outcomes) to the task's chat log. */
    appendPassLog(taskId: string, log: PassLog): Promise<void>;
}
export interface PassLog {
    readonly passIndex: number;
    readonly endedAtEpochMs: number;
    /** Card ids emitted this pass; full card bodies live in cards persistence. */
    readonly cardIds: readonly string[];
    /** Tool names invoked this pass (for audit). */
    readonly toolsInvoked: readonly string[];
}
export interface ClockPort {
    nowEpochMs(): number;
}
export declare const SYSTEM_CLOCK: ClockPort;
export interface OrchestratorPorts {
    readonly contextBuilder: ContextBuilderPort;
    readonly promptComposer: PromptComposerPort;
    readonly executor: ExecutorPort;
    readonly memory: MemoryPort;
    readonly clock: ClockPort;
    /**
     * ADR-171: graph reads go through this abstraction. The orchestrator
     * MUST NOT depend on any specific backend (DreamGraph, LSP, Sourcegraph,
     * filesystem, etc.) directly. Use NullProjectGraphReader when no
     * backend is wired — sparse-mode is a first-class operating mode.
     */
    readonly projectGraphReader: ProjectGraphReader;
    /**
     * ADR-171: cognition writes go through this abstraction. May be
     * NullProjectGraphRecorder when no durable backend is wired; the
     * orchestrator still produces complete passes.
     */
    readonly projectGraphRecorder: ProjectGraphRecorder;
}
//# sourceMappingURL=ports.d.ts.map