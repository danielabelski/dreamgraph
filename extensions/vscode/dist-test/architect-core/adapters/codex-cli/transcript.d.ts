import type { CodexCliTranscript, CodexToolCallWitness } from "./types.js";
export declare function normalizeCodexTranscript(input: {
    readonly stdout: string;
    readonly stderr: string;
    readonly exitCode?: number | null;
}): CodexCliTranscript;
export declare function projectCodexToolCallWitnesses(events: readonly unknown[], sequenceOffset?: number): readonly CodexToolCallWitness[];
export declare function projectCodexToolCallWitnessesFromDiagnostics(diagnostics: readonly string[], sequenceOffset?: number): readonly CodexToolCallWitness[];
//# sourceMappingURL=transcript.d.ts.map