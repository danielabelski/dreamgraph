export interface CopilotCliTranscript {
    /** ANSI-stripped, CR-stripped, trimmed assistant output. */
    readonly assistantText: string;
    /** Non-empty stderr lines, ANSI-stripped, in original order. */
    readonly diagnostics: readonly string[];
    /**
     * True when stderr contains any line that matches the conservative
     * error heuristic (`error`, `failed`, `fatal`, `panic`, case-
     * insensitive, with word boundaries). Used by the orchestrator to
     * flag a run as degraded even when the exit code was zero.
     */
    readonly hasStderrErrors: boolean;
}
export declare function normalizeCopilotTranscript(input: {
    readonly stdout: string;
    readonly stderr: string;
}): CopilotCliTranscript;
//# sourceMappingURL=transcript.d.ts.map