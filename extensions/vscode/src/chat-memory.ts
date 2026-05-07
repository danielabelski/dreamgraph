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
  verdict?: { level: string; summary: string };
  toolTrace?: { tool: string; argsSummary: string; filesAffected: string[]; durationMs: number; status: string }[];
  anchor?: import('./types.js').SemanticAnchor;
}

interface PersistedChatState {
  version: 1;
  messages: PersistedMessage[];
}

/**
 * Phase 2 of NEVER_FAIL_BUDGET_DEBT_PLAN — per-instance budget state.
 * Stored under a separate globalState key so chat history and budget state
 * evolve independently. The §9 reload invariant requires byte-for-byte
 * round-trip; we wrap in a versioned envelope and persist `BudgetSnapshot`
 * (which is plain JSON) plus the `turnCounter` so the next coordinator
 * starts at the right turn number.
 */
interface PersistedBudgetState {
  version: 1;
  turnCounter: number;
  snapshot: BudgetSnapshot;
}

export class ChatMemory {
  private static readonly storageKeyPrefix = 'dreamgraph.chat.';
  private static readonly budgetStorageKeyPrefix = 'dreamgraph.budget.';

  constructor(private readonly context: vscode.ExtensionContext) {}

  public async load(instanceId: string): Promise<PersistedMessage[]> {
    const key = this.getStorageKey(instanceId);
    const state = this.context.globalState.get<PersistedChatState | PersistedMessage[]>(key);

    if (!state) {
      return [];
    }

    if (Array.isArray(state)) {
      return state;
    }

    return Array.isArray(state.messages) ? state.messages : [];
  }

  public async save(instanceId: string, messages: PersistedMessage[]): Promise<void> {
    const key = this.getStorageKey(instanceId);
    const state: PersistedChatState = {
      version: 1,
      messages,
    };

    await this.context.globalState.update(key, state);
  }

  public async clear(instanceId: string): Promise<void> {
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
  public async loadBudgetState(
    instanceId: string,
  ): Promise<{ snapshot: BudgetSnapshot; turnCounter: number } | null> {
    const key = this.getBudgetStorageKey(instanceId);
    const state = this.context.globalState.get<PersistedBudgetState>(key);
    if (!state || state.version !== 1 || !state.snapshot) {
      return null;
    }
    const turnCounter = typeof state.turnCounter === 'number' && state.turnCounter >= 0
      ? Math.floor(state.turnCounter)
      : 0;
    return { snapshot: state.snapshot, turnCounter };
  }

  public async saveBudgetState(
    instanceId: string,
    snapshot: BudgetSnapshot,
    turnCounter: number,
  ): Promise<void> {
    const key = this.getBudgetStorageKey(instanceId);
    const state: PersistedBudgetState = {
      version: 1,
      turnCounter: Math.max(0, Math.floor(turnCounter)),
      snapshot,
    };
    await this.context.globalState.update(key, state);
  }

  public async clearBudgetState(instanceId: string): Promise<void> {
    const key = this.getBudgetStorageKey(instanceId);
    await this.context.globalState.update(key, undefined);
  }

  private getStorageKey(instanceId: string): string {
    const normalized = instanceId && instanceId.trim().length > 0 ? instanceId.trim() : 'default';
    return `${ChatMemory.storageKeyPrefix}${normalized}`;
  }

  private getBudgetStorageKey(instanceId: string): string {
    const normalized = instanceId && instanceId.trim().length > 0 ? instanceId.trim() : 'default';
    return `${ChatMemory.budgetStorageKeyPrefix}${normalized}`;
  }
}
