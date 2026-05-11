"use strict";
// STRICT ISOLATION (ADR-140): no import from v1.
// Slice 5 — Card factories. Pure constructors; no I/O, no Date.now() inside —
// callers pass nowEpochMs (mirrors Slice 3 ADR-153).
Object.defineProperty(exports, "__esModule", { value: true });
exports.createGoalCard = createGoalCard;
exports.createPlanCard = createPlanCard;
exports.createContextCard = createContextCard;
exports.createDecisionCard = createDecisionCard;
exports.createEditCard = createEditCard;
exports.createVerificationCard = createVerificationCard;
exports.createBlockerCard = createBlockerCard;
exports.createCompletionCard = createCompletionCard;
exports.createNextStepCard = createNextStepCard;
exports.createFallbackCard = createFallbackCard;
exports.createOutcomeCard = createOutcomeCard;
const types_js_1 = require("./types.js");
const pills_js_1 = require("./pills.js");
function base(c, kind) {
    if (!c.id)
        throw new Error('Card.id required');
    if (!c.taskId)
        throw new Error('Card.taskId required');
    if (!Number.isFinite(c.nowEpochMs) || c.nowEpochMs <= 0) {
        throw new Error('Card.nowEpochMs must be a positive epoch ms');
    }
    return {
        id: c.id,
        schemaVersion: types_js_1.CARD_SCHEMA_VERSION,
        taskId: c.taskId,
        kind,
        createdAtEpochMs: c.nowEpochMs,
        parentCardId: c.parentCardId,
        pills: c.pills,
    };
}
function createGoalCard(c, body) {
    return Object.freeze({ ...base(c, 'goal'), body: Object.freeze(body) });
}
function createPlanCard(c, steps) {
    return Object.freeze({
        ...base(c, 'plan'),
        body: Object.freeze({ steps: Object.freeze([...steps]) }),
    });
}
function createContextCard(c, body) {
    return Object.freeze({
        ...base(c, 'context'),
        body: Object.freeze({
            sources: Object.freeze([...body.sources]),
            summary: body.summary,
        }),
    });
}
function createDecisionCard(c, body) {
    return Object.freeze({
        ...base(c, 'decision'),
        body: Object.freeze({
            ...body,
            alternatives: Object.freeze([...body.alternatives]),
        }),
    });
}
function createEditCard(c, body) {
    return Object.freeze({
        ...base(c, 'edit'),
        body: Object.freeze({
            artifacts: Object.freeze([...body.artifacts]),
            diffSummary: body.diffSummary,
        }),
    });
}
function createVerificationCard(c, evidence) {
    return Object.freeze({
        ...base(c, 'verification'),
        body: Object.freeze({ evidence }),
    });
}
function createBlockerCard(c, body) {
    return Object.freeze({
        ...base(c, 'blocker'),
        body: Object.freeze({
            ...body,
            blockedBy: Object.freeze([...body.blockedBy]),
        }),
    });
}
function createCompletionCard(c, body) {
    return Object.freeze({
        ...base(c, 'completion'),
        body: Object.freeze({
            summary: body.summary,
            artifacts: Object.freeze([...body.artifacts]),
        }),
    });
}
/**
 * `next-step` card embeds the `ContinuationNeed` verbatim — toolName, args,
 * and reason are preserved (Slice 3 ADR-154 invariant).
 */
function createNextStepCard(c, continuation) {
    const tool = continuation?.selectedAction?.tool;
    if (!tool || typeof tool !== 'string') {
        throw new Error('next-step card requires ContinuationNeed with selectedAction.tool');
    }
    return Object.freeze({
        ...base(c, 'next-step'),
        body: Object.freeze({ continuation }),
    });
}
/**
 * Fallback card — derives `pills.fallbackReason` from the justification so
 * renderers never see a null reason on a fallback card.
 */
function createFallbackCard(c, pillsInput, plan, justification) {
    const pills = (0, pills_js_1.computePills)({ ...pillsInput, plan });
    if (pills.fallbackReason === null) {
        // Defensive: if caller passed a plan without a justification, force the
        // pill from the explicit justification arg.
        throw new Error('createFallbackCard requires plan.fallbackJustification to be present');
    }
    return Object.freeze({
        ...base({ ...c, pills }, 'fallback'),
        body: Object.freeze({ plan, justification }),
    });
}
/**
 * Outcome card — derives `pills.tier` and `pills.verificationStatus` from the
 * outcome so callers don't have to plumb both.
 */
function createOutcomeCard(c, pillsInput, outcome) {
    const pills = (0, pills_js_1.computePills)({ ...pillsInput, outcome });
    return Object.freeze({
        ...base({ ...c, pills }, 'outcome'),
        body: Object.freeze({ outcome }),
    });
}
//# sourceMappingURL=factory.js.map