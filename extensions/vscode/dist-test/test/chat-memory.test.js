"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const node_test_1 = __importDefault(require("node:test"));
const strict_1 = __importDefault(require("node:assert/strict"));
const chat_memory_1 = require("../chat-memory");
const budget_coordinator_1 = require("../budget-coordinator");
class FakeGlobalState {
    data = new Map();
    get(key) {
        return this.data.get(key);
    }
    async update(key, value) {
        if (typeof value === 'undefined') {
            this.data.delete(key);
            return;
        }
        this.data.set(key, value);
    }
}
(0, node_test_1.default)('ChatMemory persists messages per instance', async () => {
    const context = { globalState: new FakeGlobalState() };
    const memory = new chat_memory_1.ChatMemory(context);
    await memory.save('instance-a', [
        { role: 'user', content: 'hello', timestamp: '2026-04-10T00:00:00.000Z' },
    ]);
    await memory.save('instance-b', [
        { role: 'assistant', content: 'world', timestamp: '2026-04-10T00:00:01.000Z' },
    ]);
    strict_1.default.deepStrictEqual(await memory.load('instance-a'), [
        { role: 'user', content: 'hello', timestamp: '2026-04-10T00:00:00.000Z' },
    ]);
    strict_1.default.deepStrictEqual(await memory.load('instance-b'), [
        { role: 'assistant', content: 'world', timestamp: '2026-04-10T00:00:01.000Z' },
    ]);
});
(0, node_test_1.default)('ChatMemory clears a single instance history', async () => {
    const context = { globalState: new FakeGlobalState() };
    const memory = new chat_memory_1.ChatMemory(context);
    await memory.save('instance-a', [
        { role: 'user', content: 'keep?', timestamp: '2026-04-10T00:00:00.000Z' },
    ]);
    await memory.clear('instance-a');
    strict_1.default.deepStrictEqual(await memory.load('instance-a'), []);
});
(0, node_test_1.default)('ChatMemory preserves canonical anchor identity across save and restore', async () => {
    const context = { globalState: new FakeGlobalState() };
    const memory = new chat_memory_1.ChatMemory(context);
    const messages = [
        {
            role: 'user',
            content: 'Explain this function',
            timestamp: '2026-04-10T00:00:00.000Z',
            anchor: {
                path: 'extensions/vscode/src/context-builder.ts',
                kind: 'symbol',
                symbolPath: 'ContextBuilder._resolveGraphContext',
                label: 'Graph Relevance Propagation',
                confidence: 0.92,
                canonicalId: 'graph-relevance-propagation',
                canonicalKind: 'entity',
                migrationStatus: 'promoted',
                symbolRange: { startLine: 700, endLine: 890 },
            },
        },
    ];
    await memory.save('instance-a', messages);
    const restored = await memory.load('instance-a');
    strict_1.default.equal(restored.length, 1);
    strict_1.default.equal(restored[0]?.anchor?.canonicalId, 'graph-relevance-propagation');
    strict_1.default.equal(restored[0]?.anchor?.canonicalKind, 'entity');
    strict_1.default.equal(restored[0]?.anchor?.migrationStatus, 'promoted');
    strict_1.default.equal(restored[0]?.anchor?.symbolPath, 'ContextBuilder._resolveGraphContext');
    strict_1.default.deepStrictEqual(restored[0]?.anchor?.symbolRange, { startLine: 700, endLine: 890 });
});
(0, node_test_1.default)('ChatMemory round-trip preserves canonical anchor fields written by ChatPanel refresh flow', async () => {
    const context = { globalState: new FakeGlobalState() };
    const memory = new chat_memory_1.ChatMemory(context);
    const prePromotionUserMessage = {
        role: 'user',
        content: 'Explain this function',
        timestamp: '2026-04-10T00:00:00.000Z',
        instanceId: 'instance-a',
        anchor: {
            path: 'extensions/vscode/src/context-builder.ts',
            kind: 'symbol',
            symbolPath: 'ContextBuilder._resolveGraphContext',
            label: '_resolveGraphContext',
            confidence: 0.41,
            migrationStatus: 'native',
            symbolRange: { startLine: 700, endLine: 890 },
        },
    };
    const postRefreshPersistedMessage = {
        ...prePromotionUserMessage,
        anchor: {
            ...prePromotionUserMessage.anchor,
            canonicalId: 'graph-relevance-propagation',
            canonicalKind: 'entity',
            migrationStatus: 'promoted',
            confidence: 0.92,
            label: 'Graph Relevance Propagation',
        },
    };
    await memory.save('instance-a', [postRefreshPersistedMessage]);
    const restored = await memory.load('instance-a');
    strict_1.default.equal(restored.length, 1);
    strict_1.default.equal(restored[0]?.anchor?.canonicalId, 'graph-relevance-propagation');
    strict_1.default.equal(restored[0]?.anchor?.canonicalKind, 'entity');
    strict_1.default.equal(restored[0]?.anchor?.migrationStatus, 'promoted');
    strict_1.default.equal(restored[0]?.anchor?.label, 'Graph Relevance Propagation');
    strict_1.default.equal(restored[0]?.anchor?.symbolPath, 'ContextBuilder._resolveGraphContext');
    strict_1.default.equal(restored[0]?.anchor?.confidence, 0.92);
    strict_1.default.deepStrictEqual(restored[0]?.anchor?.symbolRange, { startLine: 700, endLine: 890 });
});
(0, node_test_1.default)('Phase 2 � ChatMemory persists and restores BudgetSnapshot per instance', async () => {
    const context = { globalState: new FakeGlobalState() };
    const memory = new chat_memory_1.ChatMemory(context);
    strict_1.default.equal(await memory.loadBudgetState('instance-a'), null);
    const c = new budget_coordinator_1.BudgetCoordinator(null, {
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
    strict_1.default.ok(restored);
    strict_1.default.equal(restored.turnCounter, 1);
    strict_1.default.deepStrictEqual(restored.snapshot, snap);
    strict_1.default.equal(await memory.loadBudgetState('instance-b'), null);
    await memory.clear('instance-a');
    strict_1.default.equal(await memory.loadBudgetState('instance-a'), null);
});
(0, node_test_1.default)('Phase 2 � restored BudgetSnapshot rehydrates a coordinator with identical pressure', async () => {
    const context = { globalState: new FakeGlobalState() };
    const memory = new chat_memory_1.ChatMemory(context);
    const c = new budget_coordinator_1.BudgetCoordinator(null, {
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
    strict_1.default.ok(restored);
    const live = new budget_coordinator_1.BudgetCoordinator(snap, {
        expectedTokensPerTurn: 16_000,
        transportCeilingTokens: 180_000,
        debtCarryFraction: 1.0,
        turnNumber: 2,
        modelId: 'test-model',
    });
    const reloaded = new budget_coordinator_1.BudgetCoordinator(restored.snapshot, {
        expectedTokensPerTurn: 16_000,
        transportCeilingTokens: 180_000,
        debtCarryFraction: 1.0,
        turnNumber: 2,
        modelId: 'test-model',
    });
    strict_1.default.equal(reloaded.getPressure(), live.getPressure());
    strict_1.default.equal(reloaded.getContextPressureLabel(), live.getContextPressureLabel());
    strict_1.default.equal(reloaded.getRemainingTargetTokens(), live.getRemainingTargetTokens());
});
//# sourceMappingURL=chat-memory.test.js.map