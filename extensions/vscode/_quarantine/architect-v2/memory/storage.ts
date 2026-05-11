// STRICT ISOLATION (ADR-140 + ADR-171): no v1 imports; no
// mcp_dreamgraph_* imports; no vscode/fs/http imports here. Storage
// transport is abstracted behind KeyValueStore so the host wires it
// against vscode.ExtensionContext.workspaceState in 8A.5 and tests use
// the in-memory implementation.
//
// Slice 8A.4 — Default MemoryPort.
//
// Persistence model:
//   task:<id>          -> serialized TaskState
//   passlog:<id>       -> append-only array of PassLog entries
//
// Serialization is deliberately structural-clone-safe (vscode.Memento
// requires it). We pass values straight through and rely on TaskState
// already being a plain object tree.

import type { TaskState } from "../autonomy/index.js";
import type { MemoryPort, PassLog } from "../orchestrator/ports.js";

// ---------------------------------------------------------------------------
// Transport seam
// ---------------------------------------------------------------------------

/**
 * Tiny key/value transport. Mirrors the surface of
 * `vscode.Memento` (workspaceState/globalState) so the host wiring in
 * 8A.5 is a one-line bind. Tests use InMemoryKeyValueStore.
 */
export interface KeyValueStore {
  get<T>(key: string): T | undefined;
  update<T>(key: string, value: T | undefined): Promise<void>;
}

export class InMemoryKeyValueStore implements KeyValueStore {
  private readonly map = new Map<string, unknown>();
  get<T>(key: string): T | undefined {
    return this.map.has(key) ? (this.map.get(key) as T) : undefined;
  }
  async update<T>(key: string, value: T | undefined): Promise<void> {
    if (value === undefined) this.map.delete(key);
    else this.map.set(key, value);
  }
}

// ---------------------------------------------------------------------------
// Adapter
// ---------------------------------------------------------------------------

export interface DefaultMemoryAdapterOptions {
  readonly store: KeyValueStore;
  /**
   * Hard cap on stored PassLog entries per task. Older entries are
   * dropped on append. Default 200.
   */
  readonly maxPassLogEntries?: number;
}

const TASK_PREFIX = "architectV2:task:";
const PASSLOG_PREFIX = "architectV2:passlog:";

export class DefaultMemoryAdapter implements MemoryPort {
  private readonly store: KeyValueStore;
  private readonly maxPassLogEntries: number;

  constructor(options: DefaultMemoryAdapterOptions) {
    this.store = options.store;
    this.maxPassLogEntries = options.maxPassLogEntries ?? 200;
  }

  async saveTaskState(state: TaskState): Promise<void> {
    await this.store.update(taskKey(state.id), state);
  }

  async loadTaskState(id: string): Promise<TaskState | undefined> {
    return this.store.get<TaskState>(taskKey(id));
  }

  async appendPassLog(taskId: string, log: PassLog): Promise<void> {
    const key = passLogKey(taskId);
    const existing = this.store.get<PassLog[]>(key) ?? [];
    const next = existing.concat(log);
    if (next.length > this.maxPassLogEntries) {
      next.splice(0, next.length - this.maxPassLogEntries);
    }
    await this.store.update(key, next);
  }
}

function taskKey(id: string): string {
  return `${TASK_PREFIX}${id}`;
}

function passLogKey(id: string): string {
  return `${PASSLOG_PREFIX}${id}`;
}

// ---------------------------------------------------------------------------
// Null implementation — no persistence, used in tests and dry-runs.
// ---------------------------------------------------------------------------

export const NullMemoryPort: MemoryPort = Object.freeze({
  async saveTaskState(_state: TaskState): Promise<void> {
    /* no-op */
  },
  async loadTaskState(_id: string): Promise<TaskState | undefined> {
    return undefined;
  },
  async appendPassLog(_taskId: string, _log: PassLog): Promise<void> {
    /* no-op */
  },
});
