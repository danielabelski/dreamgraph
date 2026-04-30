/**
 * Main-thread bridge to layoutWorker.
 *
 * - Lazy-spawns a single Worker on first request and re-uses it.
 * - One in-flight request at a time; concurrent calls reject the prior
 *   promise so callers always observe the latest snapshot's layout.
 * - Falls back to a synchronous run on the main thread when Worker is
 *   unavailable (e.g. some test environments) — slow but correct.
 *
 * plans/EXPLORER_3D_MODE.md §4.
 */

import { runLayout } from "./layoutEngine";
import type {
  LayoutEdgeInput,
  LayoutNodeInput,
  LayoutNodeOutput,
  LayoutOptions,
} from "./layoutEngine";
import type { LayoutWorkerMessage } from "./layoutWorker";

export class LayoutBridge {
  private worker: Worker | null = null;
  private pending: {
    resolve(out: LayoutNodeOutput[]): void;
    reject(err: Error): void;
  } | null = null;

  /**
   * Compute final positions for the given graph. Returns a fresh array.
   * Subsequent calls supersede in-flight ones.
   */
  compute(
    nodes: LayoutNodeInput[],
    edges: LayoutEdgeInput[],
    options?: LayoutOptions,
  ): Promise<LayoutNodeOutput[]> {
    // Cancel any prior request — the snapshot it was computing for is
    // already stale, so its result would be ignored anyway.
    if (this.pending) {
      this.pending.reject(new Error("layout-superseded"));
      this.pending = null;
    }

    if (typeof Worker === "undefined") {
      // Fallback: do it inline. Acceptable in tests and small graphs.
      return Promise.resolve(runLayout(nodes, edges, options));
    }

    if (!this.worker) {
      this.worker = new Worker(
        new URL("./layoutWorker.ts", import.meta.url),
        { type: "module" },
      );
      this.worker.onmessage = (ev: MessageEvent<LayoutWorkerMessage>) => {
        const cur = this.pending;
        if (!cur) return;
        this.pending = null;
        if (ev.data.type === "layout-done") {
          cur.resolve(ev.data.positions);
        } else {
          cur.reject(new Error(ev.data.message));
        }
      };
      this.worker.onerror = (ev: ErrorEvent) => {
        const cur = this.pending;
        if (!cur) return;
        this.pending = null;
        cur.reject(new Error(ev.message || "layout worker crashed"));
      };
    }

    return new Promise<LayoutNodeOutput[]>((resolve, reject) => {
      this.pending = { resolve, reject };
      this.worker!.postMessage({ type: "layout", nodes, edges, options });
    });
  }

  dispose(): void {
    if (this.pending) {
      this.pending.reject(new Error("layout-bridge-disposed"));
      this.pending = null;
    }
    if (this.worker) {
      this.worker.terminate();
      this.worker = null;
    }
  }
}
