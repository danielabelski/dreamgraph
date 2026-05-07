import test from 'node:test';
import assert from 'node:assert/strict';
import { ChatMemory } from '../chat-memory';
import { BudgetCoordinator } from '../budget-coordinator';

class FakeGlobalState {
  private readonly data = new Map<string, unknown>();

  public get<T>(key: string): T | undefined {
    return this.data.get(key) as T | undefined;
  }

  public async update(key: string, value: unknown): Promise<void> {
    if (typeof value === 'undefined') {
      this.data.delete(key);
      return;
    }
    this.data.set(key, value);
  }
}

test('ChatMemory persists messages per instance', async () => {
  const context = { globalState: new FakeGlobalState() } as any;
  const memory = new ChatMemory(context);

  await memory.save('instance-a', [
    { role: 'user', content: 'hello', timestamp: '2026-04-10T00:00:00.000Z' },
  ]);
  await memory.save('instance-b', [
    { role: 'assistant', content: 'world', timestamp: '2026-04-10T00:00:01.000Z' },
  ]);

  assert.deepStrictEqual(await memory.load('instance-a'), [
    { role: 'user', content: 'hello', timestamp: '2026-04-10T00:00:00.000Z' },
  ]);
  assert.deepStrictEqual(await memory.load('instance-b'), [
    { role: 'assistant', content: 'world', timestamp: '2026-04-10T00:00:01.000Z' },
  ]);
});

test('ChatMemory clears a single instance history', async () => {
  const context = { globalState: new FakeGlobalState() } as any;
  const memory = new ChatMemory(context);

  await memory.save('instance-a', [
    { role: 'user', content: 'keep?', timestamp: '2026-04-10T00:00:00.000Z' },
  ]);

  await memory.clear('instance-a');

  assert.deepStrictEqual(await memory.load('instance-a'), []);
});

test('ChatMemory preserves canonical anchor identity across save and restore', async () => {
  const context = { globalState: new FakeGlobalState() } as any;
  const memory = new ChatMemory(context);

  const messages = [
    {
      role: 'user' as const,
      content: 'Explain this function',
      timestamp: '2026-04-10T00:00:00.000Z',
      anchor: {
        path: 'extensions/vscode/src/context-builder.ts',
        kind: 'symbol' as const,
        symbolPath: 'ContextBuilder._resolveGraphContext',
        label: 'Graph Relevance Propagation',
        confidence: 0.92,
        canonicalId: 'graph-relevance-propagation',
        canonicalKind: 'entity' as const,
        migrationStatus: 'promoted' as const,
        symbolRange: { startLine: 700, endLine: 890 },
      },
    },
  ];

  await memory.save('instance-a', messages);

  const restored = await memory.load('instance-a');
  assert.equal(restored.length, 1);
  assert.equal(restored[0]?.anchor?.canonicalId, 'graph-relevance-propagation');
  assert.equal(restored[0]?.anchor?.canonicalKind, 'entity');
  assert.equal(restored[0]?.anchor?.migrationStatus, 'promoted');
  assert.equal(restored[0]?.anchor?.symbolPath, 'ContextBuilder._resolveGraphContext');
  assert.deepStrictEqual(restored[0]?.anchor?.symbolRange, { startLine: 700, endLine: 890 });
});

test('ChatMemory round-trip preserves canonical anchor fields written by ChatPanel refresh flow', async () => {
  const context = { globalState: new FakeGlobalState() } as any;
  const memory = new ChatMemory(context);

  const prePromotionUserMessage = {
    role: 'user' as const,
    content: 'Explain this function',
    timestamp: '2026-04-10T00:00:00.000Z',
    instanceId: 'instance-a',
    anchor: {
      path: 'extensions/vscode/src/context-builder.ts',
      kind: 'symbol' as const,
      symbolPath: 'ContextBuilder._resolveGraphContext',
      label: '_resolveGraphContext',
      confidence: 0.41,
      migrationStatus: 'native' as const,
      symbolRange: { startLine: 700, endLine: 890 },
    },
  };

  const postRefreshPersistedMessage = {
    ...prePromotionUserMessage,
    anchor: {
      ...prePromotionUserMessage.anchor,
      canonicalId: 'graph-relevance-propagation',
      canonicalKind: 'entity' as const,
      migrationStatus: 'promoted' as const,
      confidence: 0.92,
      label: 'Graph Relevance Propagation',
    },
  };

  await memory.save('instance-a', [postRefreshPersistedMessage]);

  const restored = await memory.load('instance-a');
  assert.equal(restored.length, 1);
  assert.equal(restored[0]?.anchor?.canonicalId, 'graph-relevance-propagation');
  assert.equal(restored[0]?.anchor?.canonicalKind, 'entity');
  assert.equal(restored[0]?.anchor?.migrationStatus, 'promoted');
  assert.equal(restored[0]?.anchor?.label, 'Graph Relevance Propagation');
  assert.equal(restored[0]?.anchor?.symbolPath, 'ContextBuilder._resolveGraphContext');
  assert.equal(restored[0]?.anchor?.confidence, 0.92);
  assert.deepStrictEqual(restored[0]?.anchor?.symbolRange, { startLine: 700, endLine: 890 });
});

test('Phase 2 � ChatMemory persists and restores BudgetSnapshot per instance', async () => {
  const context = { globalState: new FakeGlobalState() } as any;
  const memory = new ChatMemory(context);

  assert.equal(await memory.loadBudgetState('instance-a'), null);

  const c = new BudgetCoordinator(null, {
    expectedTokensPerTurn: 16_000,
    transportCeilingTokens: 180_000,
    debtCarryFraction: 1.0,
    turnNumber: 1,
    modelId: 'test-model',
  });
  c.recordComponentActual('tool:read_source_code', 6_500);
  c.recordComponentActual('context:graph', 4_000);
  c.recordComponentActual('context:evidence', 2_000);
  const snap = c.finalizeTurn();

  await memory.saveBudgetState('instance-a', snap, 1);
  const restored = await memory.loadBudgetState('instance-a');
  assert.ok(restored);
  assert.equal(restored!.turnCounter, 1);
  assert.deepStrictEqual(restored!.snapshot, snap);

  assert.equal(await memory.loadBudgetState('instance-b'), null);

  await memory.clear('instance-a');
  assert.equal(await memory.loadBudgetState('instance-a'), null);
});

test('Phase 2 � restored BudgetSnapshot rehydrates a coordinator with identical pressure', async () => {
  const context = { globalState: new FakeGlobalState() } as any;
  const memory = new ChatMemory(context);

  const c = new BudgetCoordinator(null, {
    expectedTokensPerTurn: 16_000,
    transportCeilingTokens: 180_000,
    debtCarryFraction: 1.0,
    turnNumber: 1,
    modelId: 'test-model',
  });
  c.recordComponentActual('tool:big', 25_000);
  const snap = c.finalizeTurn();

  await memory.saveBudgetState('instance-x', snap, 1);
  const restored = await memory.loadBudgetState('instance-x');
  assert.ok(restored);

  const live = new BudgetCoordinator(snap, {
    expectedTokensPerTurn: 16_000,
    transportCeilingTokens: 180_000,
    debtCarryFraction: 1.0,
    turnNumber: 2,
    modelId: 'test-model',
  });
  const reloaded = new BudgetCoordinator(restored!.snapshot, {
    expectedTokensPerTurn: 16_000,
    transportCeilingTokens: 180_000,
    debtCarryFraction: 1.0,
    turnNumber: 2,
    modelId: 'test-model',
  });
  assert.equal(reloaded.getPressure(), live.getPressure());
  assert.equal(reloaded.getContextPressureLabel(), live.getContextPressureLabel());
  assert.equal(reloaded.getRemainingTargetTokens(), live.getRemainingTargetTokens());
});
