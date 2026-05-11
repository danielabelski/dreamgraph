"use strict";
// Slice 8A.5 — VS Code Memento → KeyValueStore adapter.
//
// vscode.Memento exposes (get, update). The architect-v2 KeyValueStore
// port is shaped identically; this file is the trivial bridge.
Object.defineProperty(exports, "__esModule", { value: true });
exports.VSCodeMementoStore = void 0;
class VSCodeMementoStore {
    memento;
    constructor(memento) {
        this.memento = memento;
    }
    get(key) {
        return this.memento.get(key);
    }
    async update(key, value) {
        await this.memento.update(key, value);
    }
}
exports.VSCodeMementoStore = VSCodeMementoStore;
//# sourceMappingURL=vscode-memento-store.js.map