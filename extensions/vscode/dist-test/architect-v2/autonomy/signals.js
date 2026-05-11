"use strict";
// architect-v2/autonomy/signals.ts
// Slice 3 — Decision-layer signals and result shapes.
//
// STRICT ISOLATION (ADR-140): no import from v1.
//
// All discriminated unions on this module use `kind` for the discriminator
// (matches `architect-v2/providers/adapter.ts`).
Object.defineProperty(exports, "__esModule", { value: true });
exports.createContinuationNeed = createContinuationNeed;
/**
 * Constructor that enforces the ADR-154 invariant. Throws if the prompt does
 * not contain the selected action's tool name. This is intentional — silent
 * tool-name drift is the failure mode v1 made too easy.
 */
function createContinuationNeed(args) {
    if (!args.continuationPrompt.includes(args.selectedAction.tool)) {
        throw new Error(`ADR-154 violation: continuationPrompt must embed the exact tool name '${args.selectedAction.tool}'. ` +
            `Received prompt: ${truncate(args.continuationPrompt, 160)}`);
    }
    return {
        selectedAction: args.selectedAction,
        continuationPrompt: args.continuationPrompt,
        reasoningTrace: args.reasoningTrace,
        alternativesConsidered: args.alternativesConsidered,
    };
}
function truncate(s, n) {
    return s.length <= n ? s : s.slice(0, n) + "…";
}
//# sourceMappingURL=signals.js.map