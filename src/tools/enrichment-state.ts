import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { atomicWriteFile } from "../utils/atomic-write.js";
import type { SemanticState } from "./coverage-ledger.js";

export const ENRICHMENT_RUN_SCHEMA = "dreamgraph.enrichment_run.v1" as const;

export type EnrichmentFailureKind =
  | "provider_unavailable"
  | "context_overflow"
  | "unsupported_evidence"
  | "transient_timeout"
  | "validation_failure"
  | "cancelled";

export interface EnrichmentAttempt {
  state: SemanticState;
  attempts: number;
  updated_at: string;
  reason?: EnrichmentFailureKind | string;
}

export interface EnrichmentRunState {
  schema: typeof ENRICHMENT_RUN_SCHEMA;
  run_id: string;
  scan_revision: string;
  provider_fingerprint: string;
  created_at: string;
  updated_at: string;
  nodes: Record<string, EnrichmentAttempt>;
}

export function createEnrichmentRun(scanRevision: string, providerFingerprint: string, eligibleIds: string[]): EnrichmentRunState {
  const now = new Date().toISOString();
  return {
    schema: ENRICHMENT_RUN_SCHEMA,
    run_id: randomUUID(),
    scan_revision: scanRevision,
    provider_fingerprint: providerFingerprint,
    created_at: now,
    updated_at: now,
    nodes: Object.fromEntries([...new Set(eligibleIds)].sort().map((id) => [id, { state: "pending" as const, attempts: 0, updated_at: now }])),
  };
}

export function resumableNodeIds(state: EnrichmentRunState, maxAttempts = 3): string[] {
  return Object.entries(state.nodes)
    .filter(([, node]) => node.state === "pending" || (node.state === "failed_retryable" && node.attempts < maxAttempts))
    .map(([id]) => id)
    .sort();
}

export function classifyEnrichmentFailure(error: unknown): { state: "failed_retryable" | "failed_terminal"; reason: EnrichmentFailureKind } {
  const message = String(error instanceof Error ? error.message : error).toLowerCase();
  if (/abort|cancel/.test(message)) return { state: "failed_retryable", reason: "cancelled" };
  if (/timeout|timed out|econnreset|temporar/.test(message)) return { state: "failed_retryable", reason: "transient_timeout" };
  if (/unavailable|econnrefused|no provider|model.*not.*loaded/.test(message)) return { state: "failed_retryable", reason: "provider_unavailable" };
  if (/context|token.*limit|too large/.test(message)) return { state: "failed_terminal", reason: "context_overflow" };
  if (/unsupported|no evidence/.test(message)) return { state: "failed_terminal", reason: "unsupported_evidence" };
  return { state: "failed_terminal", reason: "validation_failure" };
}

export function recordEnrichmentOutcome(
  state: EnrichmentRunState,
  id: string,
  outcome: { state: "enriched" | "skipped" | "failed_retryable" | "failed_terminal"; reason?: string },
  now = new Date().toISOString(),
): EnrichmentRunState {
  const prior = state.nodes[id];
  if (!prior) throw new Error(`ENRICHMENT_NODE_NOT_ELIGIBLE: ${id}`);
  if (prior.state === "enriched") return state;
  return {
    ...state,
    updated_at: now,
    nodes: {
      ...state.nodes,
      [id]: { state: outcome.state, attempts: prior.attempts + 1, updated_at: now, ...(outcome.reason ? { reason: outcome.reason } : {}) },
    },
  };
}

export async function persistEnrichmentRun(filePath: string, state: EnrichmentRunState): Promise<void> {
  await atomicWriteFile(filePath, JSON.stringify(state, null, 2));
}

export async function loadEnrichmentRun(filePath: string): Promise<EnrichmentRunState | null> {
  try {
    const parsed = JSON.parse(await readFile(filePath, "utf-8")) as Partial<EnrichmentRunState>;
    return parsed.schema === ENRICHMENT_RUN_SCHEMA && parsed.nodes && parsed.scan_revision && parsed.provider_fingerprint
      ? parsed as EnrichmentRunState : null;
  } catch {
    return null;
  }
}
