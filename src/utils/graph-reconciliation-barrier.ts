import { AsyncLocalStorage } from "node:async_hooks";
import { resolve } from "node:path";

import { getDataDir } from "./paths.js";

type BarrierMode = "read" | "write";
interface Waiter { mode: BarrierMode; resolve: () => void }

class ReadWriteBarrier {
  private readers = 0;
  private writer = false;
  private readonly queue: Waiter[] = [];

  async acquire(mode: BarrierMode): Promise<() => void> {
    if (mode === "read" && !this.writer && !this.queue.some((waiter) => waiter.mode === "write")) {
      this.readers++;
      return () => this.releaseRead();
    }
    if (mode === "write" && !this.writer && this.readers === 0 && this.queue.length === 0) {
      this.writer = true;
      return () => this.releaseWrite();
    }
    await new Promise<void>((resolveWaiter) => this.queue.push({ mode, resolve: resolveWaiter }));
    return mode === "read" ? () => this.releaseRead() : () => this.releaseWrite();
  }

  private releaseRead(): void {
    this.readers--;
    if (this.readers === 0) this.drain();
  }

  private releaseWrite(): void {
    this.writer = false;
    this.drain();
  }

  private drain(): void {
    if (this.writer || this.readers > 0 || this.queue.length === 0) return;
    const first = this.queue[0];
    if (first.mode === "write") {
      this.queue.shift();
      this.writer = true;
      first.resolve();
      return;
    }
    while (this.queue[0]?.mode === "read") {
      this.readers++;
      this.queue.shift()!.resolve();
    }
  }
}

const barriers = new Map<string, ReadWriteBarrier>();
const ownership = new AsyncLocalStorage<{ key: string; mode: BarrierMode }>();

function barrierKey(dataDir = getDataDir()): string {
  return resolve(dataDir).toLowerCase();
}

function barrierFor(key: string): ReadWriteBarrier {
  let barrier = barriers.get(key);
  if (!barrier) {
    barrier = new ReadWriteBarrier();
    barriers.set(key, barrier);
  }
  return barrier;
}

async function withBarrier<T>(mode: BarrierMode, fn: () => Promise<T>): Promise<T> {
  const key = barrierKey();
  const held = ownership.getStore();
  if (held?.key === key && (held.mode === "write" || held.mode === mode)) return fn();
  const release = await barrierFor(key).acquire(mode);
  try {
    return await ownership.run({ key, mode }, fn);
  } finally {
    release();
  }
}

/** Hold a stable committed graph view across every canonical store read in fn. */
export function withGraphRead<T>(fn: () => Promise<T>): Promise<T> {
  return withBarrier("read", fn);
}

/** Serialize one ordinary graph mutation against reconciliation and stable readers. */
export function withGraphMutation<T>(fn: () => Promise<T>): Promise<T> {
  return withBarrier("write", fn);
}

/** Exclusive instance-level boundary for a journaled multi-store reconciliation. */
export function withGraphReconciliation<T>(fn: () => Promise<T>): Promise<T> {
  return withBarrier("write", fn);
}
