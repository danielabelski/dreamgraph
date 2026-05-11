import type * as vscode from "vscode";
import type { KeyValueStore } from "../memory/index.js";
export declare class VSCodeMementoStore implements KeyValueStore {
    private readonly memento;
    constructor(memento: vscode.Memento);
    get<T>(key: string): T | undefined;
    update<T>(key: string, value: T | undefined): Promise<void>;
}
//# sourceMappingURL=vscode-memento-store.d.ts.map