import type { TaskState } from "../autonomy/index.js";
import type { MemoryPort, PassLog } from "../orchestrator/ports.js";
/**
 * Tiny key/value transport. Mirrors the surface of
 * `vscode.Memento` (workspaceState/globalState) so the host wiring in
 * 8A.5 is a one-line bind. Tests use InMemoryKeyValueStore.
 */
export interface KeyValueStore {
    get<T>(key: string): T | undefined;
    update<T>(key: string, value: T | undefined): Promise<void>;
}
export declare class InMemoryKeyValueStore implements KeyValueStore {
    private readonly map;
    get<T>(key: string): T | undefined;
    update<T>(key: string, value: T | undefined): Promise<void>;
}
export interface DefaultMemoryAdapterOptions {
    readonly store: KeyValueStore;
    /**
     * Hard cap on stored PassLog entries per task. Older entries are
     * dropped on append. Default 200.
     */
    readonly maxPassLogEntries?: number;
}
export declare class DefaultMemoryAdapter implements MemoryPort {
    private readonly store;
    private readonly maxPassLogEntries;
    constructor(options: DefaultMemoryAdapterOptions);
    saveTaskState(state: TaskState): Promise<void>;
    loadTaskState(id: string): Promise<TaskState | undefined>;
    appendPassLog(taskId: string, log: PassLog): Promise<void>;
}
export declare const NullMemoryPort: MemoryPort;
//# sourceMappingURL=storage.d.ts.map