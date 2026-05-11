// Architect-v2 — deterministic markdown renderer tests.
// Purpose: lock the byte-identity contract for renderCard / renderCards.
// Same Card → same markdown, no clock/random/locale dependencies.

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  renderCard,
  renderCards,
  renderTrailingNote,
  renderPass,
} from '../architect-v2/cards/render.js';
import type {
  Card,
  GoalCard,
  PlanCard,
  ContextCard,
  DecisionCard,
  EditCard,
  VerificationCard,
  BlockerCard,
  NextStepCard,
  CompletionCard,
  FallbackCard,
  OutcomeCard,
} from '../architect-v2/cards/types.js';
import { CARD_SCHEMA_VERSION } from '../architect-v2/cards/types.js';
import type { PillSet } from '../architect-v2/cards/pills.js';
import { success, failure, partial } from '../architect-v2/execution/outcome.js';

const PILLS: PillSet = Object.freeze({
  certainty: 'high',
  mode: 'eager',
  provider: 'anthropic',
  graphBound: 'yes',
  autonomyState: 'running',
  tier: 1,
  fallbackReason: null,
  verificationStatus: null,
});

function base(id: string): {
  id: string;
  schemaVersion: typeof CARD_SCHEMA_VERSION;
  taskId: string;
  createdAtEpochMs: number;
  pills: PillSet;
} {
  return {
    id,
    schemaVersion: CARD_SCHEMA_VERSION,
    taskId: 'task-1',
    createdAtEpochMs: 1_000,
    pills: PILLS,
  };
}

const goal: GoalCard = {
  ...base('c-goal'),
  kind: 'goal',
  body: { statement: 'Ship v10', acceptance: ['build green', 'tests pass'] },
};

const plan: PlanCard = {
  ...base('c-plan'),
  kind: 'plan',
  body: {
    steps: [
      { id: 's1', description: 'Write code', intent: 'file.patch' },
      { id: 's2', description: 'Run tests' },
    ],
  },
};

const ctx: ContextCard = {
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

const decision: DecisionCard = {
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

const edit: EditCard = {
  ...base('c-edit'),
  kind: 'edit',
  body: {
    diffSummary: '+10 -2 across 1 file',
    artifacts: [{ kind: 'file', id: 'src/a.ts' }],
  },
};

const verification: VerificationCard = {
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

const blocker: BlockerCard = {
  ...base('c-blk'),
  kind: 'blocker',
  body: {
    reason: 'Missing capability',
    blockedBy: ['fs.write'],
    suggestedRecovery: 'Enable workspace trust',
  },
};

const nextStep: NextStepCard = {
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

const completion: CompletionCard = {
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

const fallback: FallbackCard = {
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

const outcomeSuccess: OutcomeCard = {
  ...base('c-out-s'),
  kind: 'outcome',
  body: {
    outcome: success({
      tool: 'shell.run',
      tier: 5,
      intent: 'shell.run',
      executedAtEpochMs: 1_000,
      durationMs: 42,
      artifacts: [{ kind: 'file', id: 'dist/extension.js' }],
    }),
  },
};

const outcomeFailure: OutcomeCard = {
  ...base('c-out-f'),
  kind: 'outcome',
  body: {
    outcome: failure({
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

const outcomePartial: OutcomeCard = {
  ...base('c-out-p'),
  kind: 'outcome',
  body: {
    outcome: partial({
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

const ALL_KINDS: readonly Card[] = [
  goal, plan, ctx, decision, edit, verification, blocker,
  nextStep, completion, fallback, outcomeSuccess, outcomeFailure, outcomePartial,
];

test('renderCard handles every kind without throwing', () => {
  for (const c of ALL_KINDS) {
    const md = renderCard(c);
    assert.equal(typeof md, 'string');
    assert.ok(md.length > 0, `empty render for kind=${c.kind}`);
  }
});

test('renderCard is deterministic — same input → byte-identical output', () => {
  for (const c of ALL_KINDS) {
    const a = renderCard(c);
    const b = renderCard(c);
    assert.equal(a, b, `non-deterministic render for kind=${c.kind}`);
  }
});

test('renderCard headers carry kind label and id', () => {
  assert.match(renderCard(goal), /^### Goal `c-goal`/);
  assert.match(renderCard(plan), /^### Plan `c-plan`/);
  assert.match(renderCard(ctx), /^### Context `c-ctx`/);
  assert.match(renderCard(decision), /^### Decision `c-dec`/);
  assert.match(renderCard(edit), /^### Edit `c-edit`/);
  assert.match(renderCard(verification), /^### Verification `c-ver`/);
  assert.match(renderCard(blocker), /^### Blocker `c-blk`/);
  assert.match(renderCard(nextStep), /^### Next step `c-next`/);
  assert.match(renderCard(completion), /^### Completion `c-cmp`/);
  assert.match(renderCard(fallback), /^### Fallback `c-fb`/);
  assert.match(renderCard(outcomeSuccess), /^### Outcome `c-out-s`/);
});

test('renderCard pills line includes mandatory pills', () => {
  const md = renderCard(goal);
  assert.match(md, /`certainty:high`/);
  assert.match(md, /`mode:eager`/);
  assert.match(md, /`provider:anthropic`/);
  assert.match(md, /`graph:yes`/);
  assert.match(md, /`status:running`/);
  assert.match(md, /`tier:T1`/);
});

test('renderCard omits null tier/fallback/verification pills', () => {
  const noTier: GoalCard = {
    ...goal,
    pills: { ...PILLS, tier: null },
  };
  const md = renderCard(noTier);
  assert.ok(!/`tier:/.test(md), 'tier pill should be omitted when null');
  assert.ok(!/`fallback:/.test(md), 'fallback pill should be omitted when null');
  assert.ok(!/`verify:/.test(md), 'verify pill should be omitted when null');
});

test('renderCard ContinuationNeed embeds exact tool name (ADR-154)', () => {
  const md = renderCard(nextStep);
  assert.match(md, /`shell\.run`/);
  assert.match(md, /Run build/);
  assert.match(md, /\*\*Alternatives considered:\*\*/);
  assert.match(md, /`shell\.test`/);
});

test('renderCard outcome shows kind, tool, tier, intent and duration', () => {
  const ms = renderCard(outcomeSuccess);
  assert.match(ms, /\*\*SUCCESS\*\* `shell\.run` \(Tier 5, shell\.run\)/);
  assert.match(ms, /Duration: 42ms/);
  assert.match(ms, /\[file\] `dist\/extension\.js`/);

  const mf = renderCard(outcomeFailure);
  assert.match(mf, /\*\*FAILURE\*\* `shell\.run`/);
  assert.match(mf, /\*\*Reason:\*\* exit code 1/);
  assert.match(mf, /Recoverable: no/);

  const mp = renderCard(outcomePartial);
  assert.match(mp, /\*\*PARTIAL\*\* `mcp\.read`/);
  assert.match(mp, /Blocked by: truncated at 100KB/);
});

test('renderCards joins with horizontal-rule separator', () => {
  const md = renderCards([goal, plan]);
  assert.equal(md.split('\n\n---\n\n').length, 2);
  assert.ok(md.startsWith('### Goal `c-goal`'));
  assert.ok(md.includes('### Plan `c-plan`'));
});

test('renderCards on empty array yields empty string', () => {
  assert.equal(renderCards([]), '');
});

test('renderCards preserves input order verbatim', () => {
  const ordered = renderCards([plan, goal]);
  const planIdx = ordered.indexOf('### Plan');
  const goalIdx = ordered.indexOf('### Goal');
  assert.ok(planIdx < goalIdx, 'plan should render before goal');
});

test('renderTrailingNote returns empty string for undefined / blank input', () => {
  assert.equal(renderTrailingNote(undefined), '');
  assert.equal(renderTrailingNote(''), '');
  assert.equal(renderTrailingNote('   \n  \t '), '');
});

test('renderTrailingNote formats prose as labelled blockquote', () => {
  const md = renderTrailingNote('By the way, I noticed X');
  assert.match(md, /^_Note from model:_/);
  assert.match(md, /> By the way, I noticed X/);
});

test('renderTrailingNote preserves multi-line prose, prefixing every line', () => {
  const md = renderTrailingNote('Line one.\nLine two.\nLine three.');
  const quoted = md.split('\n').filter((l) => l.startsWith('> '));
  assert.equal(quoted.length, 3);
});

test('renderTrailingNote is deterministic', () => {
  const sample = 'By the way, the build is green.';
  assert.equal(renderTrailingNote(sample), renderTrailingNote(sample));
});

test('renderPass concatenates cards then trailing note with separator', () => {
  const md = renderPass({ cards: [goal], trailingNote: 'By the way, X.' });
  assert.match(md, /^### Goal `c-goal`/);
  assert.match(md, /\n\n---\n\n_Note from model:_/);
  assert.match(md, /> By the way, X\./);
});

test('renderPass omits separator when one side is empty', () => {
  // Cards only.
  const cardsOnly = renderPass({ cards: [goal] });
  assert.ok(!cardsOnly.includes('_Note from model:_'));

  // Trailing note only — separator still absent.
  const noteOnly = renderPass({ cards: [], trailingNote: 'just a note' });
  assert.match(noteOnly, /^_Note from model:_/);
  assert.ok(!noteOnly.startsWith('---'));

  // Both empty → empty string, no stray separator.
  assert.equal(renderPass({ cards: [], trailingNote: '' }), '');
  assert.equal(renderPass({ cards: [] }), '');
});

test('renderPass is deterministic for combined cards+note input', () => {
  const input = { cards: [goal, plan], trailingNote: 'By the way.' };
  assert.equal(renderPass(input), renderPass(input));
});
