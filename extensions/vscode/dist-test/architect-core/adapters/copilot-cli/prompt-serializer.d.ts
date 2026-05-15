import type { ArchitectMessage } from "../../../architect-llm.js";
export interface SerializeConversationOptions {
    /**
     * Override the role headers used between turns. The defaults match
     * the inline documentation above (`[system]`, `[user]`, `[assistant]`).
     * Provided for tests that want to assert exact byte output.
     */
    readonly roleHeaders?: Readonly<Record<ArchitectMessage["role"], string>>;
}
/**
 * Flatten an architect-core conversation into a single prompt string
 * suitable for passing to `runCopilotCli({ prompt })`.
 *
 * Throws when the conversation is empty (the caller must always
 * include at least the user turn the architect-core driver composed).
 */
export declare function serializeConversationForCopilotCli(conversation: readonly ArchitectMessage[], options?: SerializeConversationOptions): string;
//# sourceMappingURL=prompt-serializer.d.ts.map