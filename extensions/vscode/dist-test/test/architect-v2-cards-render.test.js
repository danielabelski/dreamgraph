"use strict";
// Architect-v2 — deterministic markdown renderer tests.
// Purpose: lock the byte-identity contract for renderCard / renderCards.
// Same Card → same markdown, no clock/random/locale dependencies.
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const node_test_1 = __importDefault(require("node:test"));
const strict_1 = __importDefault(require("node:assert/strict"));
const render_js_1 = require("../architect-v2/cards/render.js");
const types_js_1 = require("../architect-v2/cards/types.js");
const outcome_js_1 = require("../architect-v2/execution/outcome.js");
const PILLS = Object.freeze({
    certainty: 'high',
    mode: 'eager',
    provider: 'anthropic',
    graphBound: 'yes',
    autonomyState: 'running',
    tier: 1,
    fallbackReason: null,
    verificationStatus: null,
});
function base(id) {
    return {
        id,
        schemaVersion: types_js_1.CARD_SCHEMA_VERSION,
        taskId: 'task-1',
        createdAtEpochMs: 1_000,
        pills: PILLS,
    };
}
const goal = {
    ...base('c-goal'),
    kind: 'goal',
    body: { statement: 'Ship v10', acceptance: ['build green', 'tests pass'] },
};
const plan = {
    ...base('c-plan'),
    kind: 'plan',
    body: {
        steps: [
            { id: 's1', description: 'Write code', intent: 'file.patch' },
            { id: 's2', description: 'Run tests' },
        ],
    },
};
const ctx = {
    ...base('c-ctx'),
    kind: 'context',
    body: {
        summary: 'Found relevant code',
        sources: [
            { kind: 'file', id: 'src/a.ts' },
            { kind: 'mcp_entity', id: 'Foo' },
        ],
    },
};
const decision = {
    ...base('c-dec'),
    kind: 'decision',
    body: {
        question: 'Which lib?',
        chosen: 'libA',
        alternatives: ['libB', 'libC'],
        rationale: 'libA has better support',
        adrRef: 'ADR-141',
    },
};
const edit = {
    ...base('c-edit'),
    kind: 'edit',
    body: {
        diffSummary: '+10 -2 across 1 file',
        artifacts: [{ kind: 'file', id: 'src/a.ts' }],
    },
};
const verification = {
    ...base('c-ver'),
    kind: 'verification',
    body: {
        evidence: {
            kind: 'build',
            passed: true,
            summary: 'TypeScript: 73 files, 0 errors',
        },
    },
};
const blocker = {
    ...base('c-blk'),
    kind: 'blocker',
    body: {
        reason: 'Missing capability',
        blockedBy: ['fs.write'],
        suggestedRecovery: 'Enable workspace trust',
    },
};
const nextStep = {
    ...base('c-next'),
    kind: 'next-step',
    body: {
        continuation: {
            selectedAction: {
                id: 'a1',
                label: 'Run build',
                rationale: 'verify changes',
                tool: 'shell.run',
                requiresCapabilities: ['shell.exec'],
                confidence: 0.8,
            },
            continuationPrompt: 'Please run shell.run to verify',
            reasoningTrace: 'Build is the cheapest verification',
            alternativesConsidered: [
                {
                    id: 'a2',
                    label: 'Run tests',
                    rationale: 'stronger verification',
                    tool: 'shell.test',
                    requiresCapabilities: ['shell.exec'],
                    confidence: 0.6,
                },
            ],
        },
    },
};
const completion = {
    ...base('c-cmp'),
    kind: 'completion',
    body: {
        summary: 'All steps done',
        artifacts: [
            { kind: 'file', id: 'src/a.ts' },
            { kind: 'verification', id: 'build-1' },
        ],
    },
};
const fallback = {
    ...base('c-fb'),
    kind: 'fallback',
    body: {
        plan: {
            intent: 'file.patch',
            chosen: {
                intent: 'file.patch',
                tier: 4,
                kind: 'vscode',
                tool: 'workspace.applyEdit',
            },
            tier: 4,
            alternativesByTier: new Map(),
            fallbackJustification: {
                reason: 'mcp_tool_unavailable',
                preferredTier: 1,
                chosenTier: 4,
                note: 'MCP patch unavailable, used VS Code workspace edit',
            },
        },
        justification: {
            reason: 'mcp_tool_unavailable',
            preferredTier: 1,
            chosenTier: 4,
            note: 'MCP patch unavailable, used VS Code workspace edit',
        },
    },
};
const outcomeSuccess = {
    ...base('c-out-s'),
    kind: 'outcome',
    body: {
        outcome: (0, outcome_js_1.success)({
            tool: 'shell.run',
            tier: 5,
            intent: 'shell.run',
            executedAtEpochMs: 1_000,
            durationMs: 42,
            artifacts: [{ kind: 'file', id: 'dist/extension.js' }],
        }),
    },
};
const outcomeFailure = {
    ...base('c-out-f'),
    kind: 'outcome',
    body: {
        outcome: (0, outcome_js_1.failure)({
            tool: 'shell.run',
            tier: 5,
            intent: 'shell.run',
            executedAtEpochMs: 1_000,
            durationMs: 7,
            failureReason: 'exit code 1',
            recoverable: false,
        }),
    },
};
const outcomePartial = {
    ...base('c-out-p'),
    kind: 'outcome',
    body: {
        outcome: (0, outcome_js_1.partial)({
            tool: 'mcp.read',
            tier: 1,
            intent: 'file.read',
            executedAtEpochMs: 1_000,
            durationMs: 12,
            artifacts: [{ kind: 'file', id: 'src/a.ts' }],
            blockedBy: 'truncated at 100KB',
        }),
    },
};
const ALL_KINDS = [
    goal, plan, ctx, decision, edit, verification, blocker,
    nextStep, completion, fallback, outcomeSuccess, outcomeFailure, outcomePartial,
];
(0, node_test_1.default)('renderCard handles every kind without throwing', () => {
    for (const c of ALL_KINDS) {
        const md = (0, render_js_1.renderCard)(c);
        strict_1.default.equal(typeof md, 'string');
        strict_1.default.ok(md.length > 0, `empty render for kind=${c.kind}`);
    }
});
(0, node_test_1.default)('renderCard is deterministic — same input → byte-identical output', () => {
    for (const c of ALL_KINDS) {
        const a = (0, render_js_1.renderCard)(c);
        const b = (0, render_js_1.renderCard)(c);
        strict_1.default.equal(a, b, `non-deterministic render for kind=${c.kind}`);
    }
});
(0, node_test_1.default)('renderCard headers carry kind label and id', () => {
    strict_1.default.match((0, render_js_1.renderCard)(goal), /^### Goal `c-goal`/);
    strict_1.default.match((0, render_js_1.renderCard)(plan), /^### Plan `c-plan`/);
    strict_1.default.match((0, render_js_1.renderCard)(ctx), /^### Context `c-ctx`/);
    strict_1.default.match((0, render_js_1.renderCard)(decision), /^### Decision `c-dec`/);
    strict_1.default.match((0, render_js_1.renderCard)(edit), /^### Edit `c-edit`/);
    strict_1.default.match((0, render_js_1.renderCard)(verification), /^### Verification `c-ver`/);
    strict_1.default.match((0, render_js_1.renderCard)(blocker), /^### Blocker `c-blk`/);
    strict_1.default.match((0, render_js_1.renderCard)(nextStep), /^### Next step `c-next`/);
    strict_1.default.match((0, render_js_1.renderCard)(completion), /^### Completion `c-cmp`/);
    strict_1.default.match((0, render_js_1.renderCard)(fallback), /^### Fallback `c-fb`/);
    strict_1.default.match((0, render_js_1.renderCard)(outcomeSuccess), /^### Outcome `c-out-s`/);
});
(0, node_test_1.default)('renderCard pills line includes mandatory pills', () => {
    const md = (0, render_js_1.renderCard)(goal);
    strict_1.default.match(md, /`certainty:high`/);
    strict_1.default.match(md, /`mode:eager`/);
    strict_1.default.match(md, /`provider:anthropic`/);
    strict_1.default.match(md, /`graph:yes`/);
    strict_1.default.match(md, /`status:running`/);
    strict_1.default.match(md, /`tier:T1`/);
});
(0, node_test_1.default)('renderCard omits null tier/fallback/verification pills', () => {
    const noTier = {
        ...goal,
        pills: { ...PILLS, tier: null },
    };
    const md = (0, render_js_1.renderCard)(noTier);
    strict_1.default.ok(!/`tier:/.test(md), 'tier pill should be omitted when null');
    strict_1.default.ok(!/`fallback:/.test(md), 'fallback pill should be omitted when null');
    strict_1.default.ok(!/`verify:/.test(md), 'verify pill should be omitted when null');
});
(0, node_test_1.default)('renderCard ContinuationNeed embeds exact tool name (ADR-154)', () => {
    const md = (0, render_js_1.renderCard)(nextStep);
    strict_1.default.match(md, /`shell\.run`/);
    strict_1.default.match(md, /Run build/);
    strict_1.default.match(md, /\*\*Alternatives considered:\*\*/);
    strict_1.default.match(md, /`shell\.test`/);
});
(0, node_test_1.default)('renderCard outcome shows kind, tool, tier, intent and duration', () => {
    const ms = (0, render_js_1.renderCard)(outcomeSuccess);
    strict_1.default.match(ms, /\*\*SUCCESS\*\* `shell\.run` \(Tier 5, shell\.run\)/);
    strict_1.default.match(ms, /Duration: 42ms/);
    strict_1.default.match(ms, /\[file\] `dist\/extension\.js`/);
    const mf = (0, render_js_1.renderCard)(outcomeFailure);
    strict_1.default.match(mf, /\*\*FAILURE\*\* `shell\.run`/);
    strict_1.default.match(mf, /\*\*Reason:\*\* exit code 1/);
    strict_1.default.match(mf, /Recoverable: no/);
    const mp = (0, render_js_1.renderCard)(outcomePartial);
    strict_1.default.match(mp, /\*\*PARTIAL\*\* `mcp\.read`/);
    strict_1.default.match(mp, /Blocked by: truncated at 100KB/);
});
(0, node_test_1.default)('renderCards joins with horizontal-rule separator', () => {
    const md = (0, render_js_1.renderCards)([goal, plan]);
    strict_1.default.equal(md.split('\n\n---\n\n').length, 2);
    strict_1.default.ok(md.startsWith('### Goal `c-goal`'));
    strict_1.default.ok(md.includes('### Plan `c-plan`'));
});
(0, node_test_1.default)('renderCards on empty array yields empty string', () => {
    strict_1.default.equal((0, render_js_1.renderCards)([]), '');
});
(0, node_test_1.default)('renderCards preserves input order verbatim', () => {
    const ordered = (0, render_js_1.renderCards)([plan, goal]);
    const planIdx = ordered.indexOf('### Plan');
    const goalIdx = ordered.indexOf('### Goal');
    strict_1.default.ok(planIdx < goalIdx, 'plan should render before goal');
});
(0, node_test_1.default)('renderTrailingNote returns empty string for undefined / blank input', () => {
    strict_1.default.equal((0, render_js_1.renderTrailingNote)(undefined), '');
    strict_1.default.equal((0, render_js_1.renderTrailingNote)(''), '');
    strict_1.default.equal((0, render_js_1.renderTrailingNote)('   \n  \t '), '');
});
(0, node_test_1.default)('renderTrailingNote formats prose as labelled blockquote', () => {
    const md = (0, render_js_1.renderTrailingNote)('By the way, I noticed X');
    strict_1.default.match(md, /^_Note from model:_/);
    strict_1.default.match(md, /> By the way, I noticed X/);
});
(0, node_test_1.default)('renderTrailingNote preserves multi-line prose, prefixing every line', () => {
    const md = (0, render_js_1.renderTrailingNote)('Line one.\nLine two.\nLine three.');
    const quoted = md.split('\n').filter((l) => l.startsWith('> '));
    strict_1.default.equal(quoted.length, 3);
});
(0, node_test_1.default)('renderTrailingNote is deterministic', () => {
    const sample = 'By the way, the build is green.';
    strict_1.default.equal((0, render_js_1.renderTrailingNote)(sample), (0, render_js_1.renderTrailingNote)(sample));
});
(0, node_test_1.default)('renderPass concatenates cards then trailing note with separator', () => {
    const md = (0, render_js_1.renderPass)({ cards: [goal], trailingNote: 'By the way, X.' });
    strict_1.default.match(md, /^### Goal `c-goal`/);
    strict_1.default.match(md, /\n\n---\n\n_Note from model:_/);
    strict_1.default.match(md, /> By the way, X\./);
});
(0, node_test_1.default)('renderPass omits separator when one side is empty', () => {
    // Cards only.
    const cardsOnly = (0, render_js_1.renderPass)({ cards: [goal] });
    strict_1.default.ok(!cardsOnly.includes('_Note from model:_'));
    // Trailing note only — separator still absent.
    const noteOnly = (0, render_js_1.renderPass)({ cards: [], trailingNote: 'just a note' });
    strict_1.default.match(noteOnly, /^_Note from model:_/);
    strict_1.default.ok(!noteOnly.startsWith('---'));
    // Both empty → empty string, no stray separator.
    strict_1.default.equal((0, render_js_1.renderPass)({ cards: [], trailingNote: '' }), '');
    strict_1.default.equal((0, render_js_1.renderPass)({ cards: [] }), '');
});
(0, node_test_1.default)('renderPass is deterministic for combined cards+note input', () => {
    const input = { cards: [goal, plan], trailingNote: 'By the way.' };
    strict_1.default.equal((0, render_js_1.renderPass)(input), (0, render_js_1.renderPass)(input));
});
//# sourceMappingURL=architect-v2-cards-render.test.js.map