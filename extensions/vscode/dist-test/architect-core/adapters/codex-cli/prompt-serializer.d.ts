import type { ArchitectMessage } from "../../../architect-llm.js";
export declare const CURRENT_TURN_OPEN_MARKER = "===== CURRENT TURN \u2014 RESPOND ONLY TO THIS MESSAGE =====";
export declare const CURRENT_TURN_CLOSE_MARKER = "===== END CURRENT TURN =====";
export interface CliToolsManifest {
    readonly server: string;
    readonly tools: readonly string[];
    readonly commandExecutionDisabledReason?: string;
}
export interface SerializeConversationOptions {
    readonly roleHeaders?: Readonly<Record<ArchitectMessage["role"], string>>;
    readonly historyKeepLast?: number;
    readonly markCurrentTurn?: boolean;
    readonly cliToolsManifest?: CliToolsManifest;
}
export declare function serializeConversationForCodexCli(conversation: readonly ArchitectMessage[], options?: SerializeConversationOptions): string;
//# sourceMappingURL=prompt-serializer.d.ts.map