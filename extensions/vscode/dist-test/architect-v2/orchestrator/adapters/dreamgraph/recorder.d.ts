import type { Card as ArchitectCard } from "../../../cards/index.js";
import type { ContinuationNeed } from "../../../autonomy/index.js";
import type { DecisionRecord, OutcomeRecord, ProjectGraphRecorder } from "../../project-graph.js";
import type { ContextDiscovery, ContextDiscoveryRecorder } from "../../../context/discovery-recorder.js";
import type { McpClient } from "./reader.js";
export interface DreamGraphRecorderAdapterOptions {
    readonly client: McpClient;
    /**
     * When true, console.warn on transport errors. Defaults to false so
     * production runs stay quiet; tests opt in for visibility.
     */
    readonly logErrors?: boolean;
}
export declare class DreamGraphRecorderAdapter implements ProjectGraphRecorder, ContextDiscoveryRecorder {
    private readonly client;
    private readonly logErrors;
    constructor(options: DreamGraphRecorderAdapterOptions);
    recordCards(cards: readonly ArchitectCard[]): Promise<void>;
    recordDecision(decision: DecisionRecord): Promise<void>;
    recordOutcome(outcome: OutcomeRecord): Promise<void>;
    recordContinuation(continuation: ContinuationNeed): Promise<void>;
    recordDiscoveries(discoveries: readonly ContextDiscovery[]): Promise<void>;
    private safeCall;
}
//# sourceMappingURL=recorder.d.ts.map