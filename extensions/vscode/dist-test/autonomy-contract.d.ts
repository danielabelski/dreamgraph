export interface StructuredActionEnvelope {
    summary?: string;
    goal_status?: 'complete' | 'partial' | 'blocked';
    progress_status?: 'advancing' | 'slowing' | 'stalled';
    uncertainty?: 'low' | 'medium' | 'high';
    recommended_next_steps?: Array<{
        id?: string;
        label: string;
        rationale?: string;
        priority?: number;
        eligible?: boolean;
        within_scope?: boolean;
        mutually_exclusive_with?: string[];
        batch_group?: string;
        /**
         * Exact MCP/local tool name that should run this step. When present,
         * the host primes this tool for the next turn so brief follow-ups
         * ("yes", "do it") still expose it to the agentic loop. Omit when
         * the step is not a single-tool action.
         */
        tool?: string;
        /** Optional pre-bound arguments for `tool`. Shape is tool-specific. */
        tool_args?: Record<string, unknown>;
    }>;
}
export declare function getStructuredResponseContractBlock(): string;
export declare function extractJsonEnvelopeBlocks(content: string): StructuredActionEnvelope[];
export declare function extractPrimaryJsonEnvelope(content: string): StructuredActionEnvelope | undefined;
export declare function hasStructuredEnvelope(content: string): boolean;
//# sourceMappingURL=autonomy-contract.d.ts.map