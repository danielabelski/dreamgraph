import { type ActionCandidate, type TaskState } from "../autonomy/index.js";
import { type CapabilityId } from "../capabilities/index.js";
import type { ProviderProfile } from "../providers/index.js";
import type { OrchestratorPorts } from "./ports.js";
import type { PassResult, UserIntent } from "./types.js";
import type { GraphRichness } from "./project-graph.js";
export interface RunPassInput {
    readonly taskState: TaskState;
    readonly userIntent: UserIntent;
    readonly providerProfile: ProviderProfile;
    readonly ports: OrchestratorPorts;
    /**
     * Slice 8A.5: explicit token window. Host resolves once from the
     * provider profile's default model and threads it through every pass.
     * Optional so tests and dry runs can omit and let the builder use its
     * conservative default.
     */
    readonly windowTokens?: number;
}
/**
 * Map a global GraphRichness signal into the GraphBound pill value.
 * Graph-first invariant: if the project graph reports any usable
 * richness, every downstream card MUST advertise graph:yes/partial so
 * the user can see the agent is grounded.
 */
export declare function richnessToGraphBound(richness: GraphRichness | undefined): "yes" | "no" | "partial";
export declare function runPass(input: RunPassInput): Promise<PassResult>;
export declare function resolveCapabilityFromAction(action: ActionCandidate): CapabilityId | undefined;
//# sourceMappingURL=loop.d.ts.map