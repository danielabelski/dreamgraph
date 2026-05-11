/**
 * DreamGraph Chat Memory — Per-instance persistent conversation history.
 *
 * Stores chat messages keyed by DreamGraph instance UUID using VS Code globalState.
 * Each instance keeps its own history so switching instances does not leak chat
 * state across workspaces or daemon targets.
 */
import * as vscode from 'vscode';
import type { BudgetSnapshot } from './budget-coordinator.js';
export interface PersistedMessage {
    role: 'user' | 'assistant' | 'system';
    content: string;
    timestamp: string;
    verdict?: {
        level: string;
        summary: string;
    };
    toolTrace?: {
        tool: string;
        argsSummary: string;
        filesAffected: string[];
        durationMs: number;
        status: string;
    }[];
    anchor?: import('./types.js').SemanticAnchor;
}
export declare class ChatMemory {
    private readonly context;
    private static readonly storageKeyPrefix;
    private static readonly budgetStorageKeyPrefix;
    constructor(context: vscode.ExtensionContext);
    load(instanceId: string): Promise<PersistedMessage[]>;
    save(instanceId: string, messages: PersistedMessage[]): Promise<void>;
    clear(instanceId: string): Promise<void>;
    /**
     * Phase 2: load the per-instance BudgetSnapshot + turn counter, if any.
     * Returns `null` for fresh instances. Malformed entries are treated as
     * absent — the coordinator handles `null` cleanly.
     */
    loadBudgetState(instanceId: string): Promise<{
        snapshot: BudgetSnapshot;
        turnCounter: number;
    } | null>;
    saveBudgetState(instanceId: string, snapshot: BudgetSnapshot, turnCounter: number): Promise<void>;
    clearBudgetState(instanceId: string): Promise<void>;
    private getStorageKey;
    private getBudgetStorageKey;
}
//# sourceMappingURL=chat-memory.d.ts.map