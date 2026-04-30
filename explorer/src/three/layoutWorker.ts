/**
 * Off-main-thread bridge for `runLayout`.
 *
 * Vite spawns this as a module worker via:
 *   new Worker(new URL("./layoutWorker.ts", import.meta.url), { type: "module" })
 *
 * Protocol:
 *   main → worker: { type: "layout", nodes, edges, options? }
 *   worker → main: { type: "layout-done", positions }
 *   worker → main: { type: "layout-error", message }
 *
 * One request in flight at a time — the bridge in `layout3d.ts` enforces
 * that with a queue. Keeping the worker stateless makes restarts trivial.
 */

import {
  runLayout,
  type LayoutEdgeInput,
  type LayoutNodeInput,
  type LayoutNodeOutput,
  type LayoutOptions,
} from "./layoutEngine";

export interface LayoutRequest {
  type: "layout";
  nodes: LayoutNodeInput[];
  edges: LayoutEdgeInput[];
  options?: LayoutOptions;
}

export interface LayoutDoneMessage {
  type: "layout-done";
  positions: LayoutNodeOutput[];
}

export interface LayoutErrorMessage {
  type: "layout-error";
  message: string;
}

export type LayoutWorkerMessage = LayoutDoneMessage | LayoutErrorMessage;

self.onmessage = (ev: MessageEvent<LayoutRequest>) => {
  const msg = ev.data;
  if (!msg || msg.type !== "layout") return;
  try {
    const positions = runLayout(msg.nodes, msg.edges, msg.options);
    const done: LayoutDoneMessage = { type: "layout-done", positions };
    (self as unknown as Worker).postMessage(done);
  } catch (err) {
    const out: LayoutErrorMessage = {
      type: "layout-error",
      message: err instanceof Error ? err.message : String(err),
    };
    (self as unknown as Worker).postMessage(out);
  }
};
