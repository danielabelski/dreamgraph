export type TimeoutLayer = "connect" | "discovery" | "queue" | "tool" | "idle" | "wall" | "user";

export interface GovernedTimeoutError {
  code: "DREAMGRAPH_TIMEOUT" | "DREAMGRAPH_CANCELLED";
  owner: TimeoutLayer;
  stage: string;
  elapsed_ms: number;
  tool?: string;
  correlation_id: string;
  retryable: boolean;
}

const RETRYABLE = new Set<TimeoutLayer>(["connect", "discovery", "queue", "idle"]);

export function timeoutError(input: {
  owner: TimeoutLayer;
  stage?: string;
  elapsedMs: number;
  correlationId: string;
  tool?: string;
}): GovernedTimeoutError {
  return {
    code: input.owner === "user" ? "DREAMGRAPH_CANCELLED" : "DREAMGRAPH_TIMEOUT",
    owner: input.owner,
    stage: input.stage ?? input.owner,
    elapsed_ms: Math.max(0, Math.trunc(input.elapsedMs)),
    ...(input.tool ? { tool: input.tool } : {}),
    correlation_id: input.correlationId,
    retryable: input.owner !== "user" && RETRYABLE.has(input.owner),
  };
}

export function isGovernedTimeoutError(value: unknown): value is GovernedTimeoutError {
  if (!value || typeof value !== "object") return false;
  const item = value as Partial<GovernedTimeoutError>;
  return (item.code === "DREAMGRAPH_TIMEOUT" || item.code === "DREAMGRAPH_CANCELLED")
    && typeof item.owner === "string"
    && typeof item.elapsed_ms === "number"
    && typeof item.correlation_id === "string";
}

export async function withOwnedDeadline<T>(
  operation: (signal: AbortSignal) => Promise<T>,
  input: { owner: Exclude<TimeoutLayer, "user">; timeoutMs: number; correlationId: string; stage?: string; tool?: string; signal?: AbortSignal },
): Promise<T> {
  const controller = new AbortController();
  const started = Date.now();
  let userCancelled = false;
  const onAbort = (): void => { userCancelled = true; controller.abort(input.signal?.reason); };
  input.signal?.addEventListener("abort", onAbort, { once: true });
  const timer = setTimeout(() => controller.abort(), input.timeoutMs);
  timer.unref?.();
  try {
    return await Promise.race([
      operation(controller.signal),
      new Promise<never>((_, reject) => controller.signal.addEventListener("abort", () => reject(timeoutError({
        owner: userCancelled ? "user" : input.owner,
        stage: input.stage,
        elapsedMs: Date.now() - started,
        correlationId: input.correlationId,
        tool: input.tool,
      })), { once: true })),
    ]);
  } finally {
    clearTimeout(timer);
    input.signal?.removeEventListener("abort", onAbort);
  }
}
