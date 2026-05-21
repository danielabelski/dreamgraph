import type { ArchitectMessage } from "../../../architect-llm.js";
/**
 * Stable markers wrapping the final user turn. Single-shot CLI runs
 * read the FULL conversation; without unambiguous delimiters the
 * model can latch onto an earlier `[user]` block in the history
 * (manifests as the assistant answering the previous turn's prompt
 * for the new turn). The closing marker mirrors the opener so the
 * region is parseable in audit dumps.
 */
export declare const CURRENT_TURN_OPEN_MARKER = "===== CURRENT TURN \u2014 RESPOND ONLY TO THIS MESSAGE =====";
export declare const CURRENT_TURN_CLOSE_MARKER = "===== END CURRENT TURN =====";
export interface CliToolsManifest {
    readonly server: string;
    readonly tools: readonly string[];
    readonly nativeCommandTools?: readonly string[];
    readonly commandExecutionDisabledReason?: string;
}
export interface SerializeConversationOptions {
    /**
     * Override the role headers used between turns. The defaults match
     * the inline documentation above (`[system]`, `[user]`, `[assistant]`).
     * Provided for tests that want to assert exact byte output.
     */
    readonly roleHeaders?: Readonly<Record<ArchitectMessage["role"], string>>;
    /**
     * Maximum number of NON-system messages to retain (most recent
     * kept). System messages are always preserved verbatim and in
     * order. When omitted, no truncation is applied.
     */
    readonly historyKeepLast?: number;
    /**
     * When true the final `[user]` turn is wrapped in
     * `CURRENT_TURN_OPEN_MARKER` / `CURRENT_TURN_CLOSE_MARKER` so the
     * single-shot CLI model can identify the active request even when
     * the file contains many prior user turns.
     */
    readonly markCurrentTurn?: boolean;
    /**
     * When provided, an addendum is appended to the (last) system
     * message — or a synthetic leading system block is inserted if
     * none exists — listing the MCP server + tool names available
     * to the CLI surface and instructing the model to prefer them
     * for repo/graph/code queries over its inline native tools.
     * Provider-agnostic shape: the caller decides which tools to
     * advertise.
     */
    readonly cliToolsManifest?: CliToolsManifest;
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