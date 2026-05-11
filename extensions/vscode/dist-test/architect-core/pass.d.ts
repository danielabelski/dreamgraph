import type { ArchitectMessage, ArchitectProvider, ArchitectTask, PassGoal, PassResult, TaskGoal, ToolDefinition, UserIntent } from "./types.js";
import type { ArchitectCorePorts } from "./ports.js";
/** Default cap for inner agentic-loop iterations within one pass.
 *  Matches chat-panel's existing `maxPasses = 12` ceiling so behavior
 *  stays identical when the seam is wired in Phase 3. */
export declare const DEFAULT_MAX_INNER_ITERATIONS = 12;
export interface RunPassInput {
    readonly userIntent: UserIntent;
    readonly ports: ArchitectCorePorts;
    /** Bounded prior-conversation slice (already truncated by caller). */
    readonly priorMessages: readonly ArchitectMessage[];
    /** Architect task type — `chat` for normal turns. */
    readonly task: ArchitectTask;
    /** Active provider name; passed to the composer for discipline framing. */
    readonly provider: ArchitectProvider;
    /** Tool catalog made available to the provider on every iteration. */
    readonly tools?: readonly ToolDefinition[];
    /** Optional turn-scoped budget coordinator (opaque to the driver). */
    readonly budgetCoordinator?: unknown;
    /** Streaming sink for assistant tokens; forwarded verbatim each iteration. */
    readonly onStreamChunk?: (chunk: string) => void;
    /** Cancellation signal forwarded to every provider call. */
    readonly abortSignal?: AbortSignal;
    /** Per-pass goal; framed into the prompt and echoed in PassResult. */
    readonly passGoal?: PassGoal;
    /** Task this pass contributes to; framed into the prompt and echoed back. */
    readonly taskGoal?: TaskGoal;
    /** Override for the inner-iteration cap (defaults to DEFAULT_MAX_INNER_ITERATIONS). */
    readonly maxIterations?: number;
}
export declare function runPass(input: RunPassInput): Promise<PassResult>;
//# sourceMappingURL=pass.d.ts.map