/**
 * True when the tool's name semantically denotes a state-mutating action
 * (file write, MCP graph mutation). Provider/server-agnostic and
 * tolerant of MCP namespacing.
 */
export declare function isWriteToolName(name: string): boolean;
/**
 * True when the tool's name semantically denotes a verification step
 * after a write — running the build/tests, inspecting errors, executing
 * a command, or reading the file back to confirm the write landed.
 */
export declare function isVerifyToolName(name: string): boolean;
/**
 * Lever 1 — narrow a live tool catalog to write + verify tools only.
 *
 * Called on the second consecutive sticky-anchor locate-only pass to
 * mechanically eliminate the ability of the model to spend another
 * turn on pure reads. Falls back to the original catalog when the
 * narrowing would produce an empty set (the loop must never deadlock
 * because of an unfortunate filter — "no failure: keep going until done").
 */
export declare function narrowToWriteAndVerify<T extends {
    readonly name: string;
}>(tools: readonly T[]): T[];
/**
 * Lever 2 — pick the strongest write tool available in `tools` for an
 * apply/patch-style recommended action. Preference order matches the
 * host's own examples in the agentic-loop write-reservation prompt.
 * Returns `undefined` when no write tool is available.
 */
export declare function pickPreferredWriteTool<T extends {
    readonly name: string;
}>(tools: readonly T[]): string | undefined;
/**
 * Pattern that identifies a recommended-action label as an "apply / patch /
 * implement / write / fix / edit"-style step that should be bound to a
 * concrete write tool when no tool is set (Lever 2).
 */
export declare const APPLY_LABEL_PATTERN: RegExp;
//# sourceMappingURL=tool-classification.d.ts.map