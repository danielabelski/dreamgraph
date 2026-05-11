"use strict";
/**
 * DreamGraph Chat Memory — Per-instance persistent conversation history.
 *
 * Stores chat messages keyed by DreamGraph instance UUID using VS Code globalState.
 * Each instance keeps its own history so switching instances does not leak chat
 * state across workspaces or daemon targets.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.ChatMemory = void 0;
class ChatMemory {
    context;
    static storageKeyPrefix = 'dreamgraph.chat.';
    static budgetStorageKeyPrefix = 'dreamgraph.budget.';
    constructor(context) {
        this.context = context;
    }
    async load(instanceId) {
        const key = this.getStorageKey(instanceId);
        const state = this.context.globalState.get(key);
        if (!state) {
            return [];
        }
        if (Array.isArray(state)) {
            return state;
        }
        return Array.isArray(state.messages) ? state.messages : [];
    }
    async save(instanceId, messages) {
        const key = this.getStorageKey(instanceId);
        const state = {
            version: 1,
            messages,
        };
        await this.context.globalState.update(key, state);
    }
    async clear(instanceId) {
        const key = this.getStorageKey(instanceId);
        await this.context.globalState.update(key, undefined);
        const budgetKey = this.getBudgetStorageKey(instanceId);
        await this.context.globalState.update(budgetKey, undefined);
    }
    /**
     * Phase 2: load the per-instance BudgetSnapshot + turn counter, if any.
     * Returns `null` for fresh instances. Malformed entries are treated as
     * absent — the coordinator handles `null` cleanly.
     */
    async loadBudgetState(instanceId) {
        const key = this.getBudgetStorageKey(instanceId);
        const state = this.context.globalState.get(key);
        if (!state || state.version !== 1 || !state.snapshot) {
            return null;
        }
        const turnCounter = typeof state.turnCounter === 'number' && state.turnCounter >= 0
            ? Math.floor(state.turnCounter)
            : 0;
        return { snapshot: state.snapshot, turnCounter };
    }
    async saveBudgetState(instanceId, snapshot, turnCounter) {
        const key = this.getBudgetStorageKey(instanceId);
        const state = {
            version: 1,
            turnCounter: Math.max(0, Math.floor(turnCounter)),
            snapshot,
        };
        await this.context.globalState.update(key, state);
    }
    async clearBudgetState(instanceId) {
        const key = this.getBudgetStorageKey(instanceId);
        await this.context.globalState.update(key, undefined);
    }
    getStorageKey(instanceId) {
        const normalized = instanceId && instanceId.trim().length > 0 ? instanceId.trim() : 'default';
        return `${ChatMemory.storageKeyPrefix}${normalized}`;
    }
    getBudgetStorageKey(instanceId) {
        const normalized = instanceId && instanceId.trim().length > 0 ? instanceId.trim() : 'default';
        return `${ChatMemory.budgetStorageKeyPrefix}${normalized}`;
    }
}
exports.ChatMemory = ChatMemory;
//# sourceMappingURL=chat-memory.js.map