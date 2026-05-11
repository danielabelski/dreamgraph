// Slice 8A.5 — VS Code Memento → KeyValueStore adapter.
//
// vscode.Memento exposes (get, update). The architect-v2 KeyValueStore
// port is shaped identically; this file is the trivial bridge.

import type * as vscode from "vscode";
import type { KeyValueStore } from "../memory/index.js";

export class VSCodeMementoStore implements KeyValueStore {
  constructor(private readonly memento: vscode.Memento) {}
  get<T>(key: string): T | undefined {
    return this.memento.get<T>(key);
  }
  async update<T>(key: string, value: T | undefined): Promise<void> {
    await this.memento.update(key, value);
  }
}
