/**
 * Event-loop lag watchdog.
 *
 * Per `plans/DREAMGRAPH_SDK_ROADMAP.md` §11 M3 exit criteria:
 *   "A `setImmediate` heartbeat samples loop lag; if lag exceeds
 *   `DG_EVENT_LOOP_LAG_MS` (default 250 ms) while a plugin handler is on
 *   the call stack, the handler is marked `event_loop_stall`, the plugin
 *   is quarantined as soon as the event loop becomes responsive again,
 *   and `plugin.errored` is emitted with the measured lag."
 *
 * This detects stalls *after* they occur. It cannot preempt or interrupt
 * synchronous CPU-bound plugin code. Stronger isolation is deferred to M8
 * via worker-thread runtime.
 */
export interface ActiveHandler {
  pluginId: string;
  /** Monotonic timestamp (ms since epoch via Date.now) when the handler started. */
  startedAt: number;
}

export interface WatchdogStallReport {
  pluginId: string;
  lagMs: number;
  startedAt: number;
}

export interface WatchdogOptions {
  /** Lag threshold in ms beyond which a stall is reported. Default 250. */
  lagMs?: number;
  /** Sampling cadence in ms. Default = lagMs. */
  intervalMs?: number;
  /** Called once per detected stall after the loop becomes responsive. */
  onStall: (report: WatchdogStallReport) => void;
}

export class EventLoopWatchdog {
  private readonly lagMs: number;
  private readonly intervalMs: number;
  private readonly onStall: (report: WatchdogStallReport) => void;
  private timer: NodeJS.Timeout | null = null;
  private active: ActiveHandler | null = null;
  private lastTick: number = 0;

  constructor(options: WatchdogOptions) {
    this.lagMs = options.lagMs ?? this.envDefault("DG_EVENT_LOOP_LAG_MS", 250);
    this.intervalMs = options.intervalMs ?? this.lagMs;
    this.onStall = options.onStall;
  }

  private envDefault(name: string, fallback: number): number {
    const raw = process.env[name];
    if (!raw) return fallback;
    const parsed = Number.parseInt(raw, 10);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
  }

  start(): void {
    if (this.timer !== null) return;
    this.lastTick = Date.now();
    this.timer = setInterval(() => this.tick(), this.intervalMs);
    // Avoid keeping the Node process alive on the watchdog alone.
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.active = null;
  }

  /**
   * Mark the start of a plugin handler. The next `tick()` after the handler
   * returns will compute lag = (now - lastTick) - intervalMs and report it
   * if the threshold was exceeded while `active` was set.
   */
  enter(pluginId: string): void {
    this.active = { pluginId, startedAt: Date.now() };
  }

  exit(): void {
    this.active = null;
  }

  private tick(): void {
    const now = Date.now();
    const lag = now - this.lastTick - this.intervalMs;
    this.lastTick = now;
    if (lag > this.lagMs && this.active) {
      this.onStall({
        pluginId: this.active.pluginId,
        lagMs: lag,
        startedAt: this.active.startedAt,
      });
      // Clear so we do not double-report on the very next sample.
      this.active = null;
    }
  }
}
