import type { ComposePromptInput, PromptComposerPort } from "../orchestrator/ports.js";
import type { PromptParts } from "../orchestrator/types.js";
import { type ContextRequirementManifest, type DeclareRequirementsInput } from "./requirements.js";
/**
 * Default prompt composer. Stateless and reusable. Tests can construct
 * directly; production wires this into OrchestratorPorts via 8A.5.
 */
export declare class DefaultPromptComposer implements PromptComposerPort {
    /**
     * ADR-174: declare context requirements *before* the assembler runs.
     * Pure, no I/O. The orchestrator threads the resulting manifest into
     * ContextBuilderPort.buildContext, then calls composePrompt with the
     * envelope the assembler returned.
     */
    declareRequirements(input: DeclareRequirementsInput): ContextRequirementManifest;
    composePrompt(input: ComposePromptInput): Promise<PromptParts>;
}
/**
 * Synchronous formatter exposed for golden-file tests. The async port
 * method delegates here. Keep this name stable: tests import it directly.
 */
export declare function composePromptSync(input: ComposePromptInput): PromptParts;
//# sourceMappingURL=composer.d.ts.map