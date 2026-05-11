"use strict";
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
Object.defineProperty(exports, "__esModule", { value: true });
exports.NullMemoryPort = exports.DefaultMemoryAdapter = exports.InMemoryKeyValueStore = void 0;
class InMemoryKeyValueStore {
    map = new Map();
    get(key) {
        return this.map.has(key) ? this.map.get(key) : undefined;
    }
    async update(key, value) {
        if (value === undefined)
            this.map.delete(key);
        else
            this.map.set(key, value);
    }
}
exports.InMemoryKeyValueStore = InMemoryKeyValueStore;
const TASK_PREFIX = "architectV2:task:";
const PASSLOG_PREFIX = "architectV2:passlog:";
class DefaultMemoryAdapter {
    store;
    maxPassLogEntries;
    constructor(options) {
        this.store = options.store;
        this.maxPassLogEntries = options.maxPassLogEntries ?? 200;
    }
    async saveTaskState(state) {
        await this.store.update(taskKey(state.id), state);
    }
    async loadTaskState(id) {
        return this.store.get(taskKey(id));
    }
    async appendPassLog(taskId, log) {
        const key = passLogKey(taskId);
        const existing = this.store.get(key) ?? [];
        const next = existing.concat(log);
        if (next.length > this.maxPassLogEntries) {
            next.splice(0, next.length - this.maxPassLogEntries);
        }
        await this.store.update(key, next);
    }
}
exports.DefaultMemoryAdapter = DefaultMemoryAdapter;
function taskKey(id) {
    return `${TASK_PREFIX}${id}`;
}
function passLogKey(id) {
    return `${PASSLOG_PREFIX}${id}`;
}
// ---------------------------------------------------------------------------
// Null implementation — no persistence, used in tests and dry-runs.
// ---------------------------------------------------------------------------
exports.NullMemoryPort = Object.freeze({
    async saveTaskState(_state) {
        /* no-op */
    },
    async loadTaskState(_id) {
        return undefined;
    },
    async appendPassLog(_taskId, _log) {
        /* no-op */
    },
});
//# sourceMappingURL=storage.js.map