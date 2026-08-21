import { createHash } from "node:crypto";

export const COVERAGE_LEDGER_SCHEMA = "dreamgraph.scan_coverage.v1" as const;

export type ParseOutcome =
  | "parsed"
  | "excluded"
  | "generated"
  | "binary"
  | "unsupported"
  | "parse_failed";

export type SemanticState =
  | "not_eligible"
  | "pending"
  | "enriched"
  | "skipped"
  | "failed_retryable"
  | "failed_terminal";

export interface CoverageFile {
  repo: string;
  path: string;
  target: string;
  extractor: string | null;
  outcome: ParseOutcome;
  reason?: string;
  emitted_entity_ids: string[];
}

export interface CoverageNode {
  id: string;
  target: string;
  supports: Array<{ repo: string; path: string }>;
  eligible: boolean;
  semantic_state: SemanticState;
  reason?: string;
  attempt_count?: number;
  last_attempt_at?: string;
  provider_fingerprint?: string;
}

export interface ScanCoverageLedger {
  schema: typeof COVERAGE_LEDGER_SCHEMA;
  revision: string;
  files: Record<string, CoverageFile>;
  nodes: Record<string, CoverageNode>;
}

export function coverageFileKey(repo: string, path: string, target: string): string {
  return `${repo}\0${path.replace(/\\/g, "/")}\0${target}`;
}

export function validateCoverageLedger(ledger: ScanCoverageLedger): string[] {
  const errors: string[] = [];
  for (const [key, file] of Object.entries(ledger.files)) {
    if (!file.repo || !file.path || !file.target) errors.push(`file ${key} lacks repository/path/target`);
    if (file.outcome !== "parsed" && !file.reason) errors.push(`file ${key} requires a stable reason for ${file.outcome}`);
    for (const id of file.emitted_entity_ids) {
      const node = ledger.nodes[id];
      if (!node) errors.push(`file ${key} emits unclassified node ${id}`);
      else if (!node.supports.some((support) => support.repo === file.repo && support.path === file.path)) {
        errors.push(`node ${id} does not reference emitting file ${key}`);
      }
    }
  }
  for (const [id, node] of Object.entries(ledger.nodes)) {
    if (node.eligible && node.semantic_state === "not_eligible") errors.push(`eligible node ${id} is not_eligible`);
    if (!node.eligible && node.semantic_state !== "not_eligible" && node.semantic_state !== "skipped") {
      errors.push(`ineligible node ${id} has actionable state ${node.semantic_state}`);
    }
    if (["not_eligible", "skipped", "failed_retryable", "failed_terminal"].includes(node.semantic_state) && !node.reason) {
      errors.push(`node ${id} requires a reason for ${node.semantic_state}`);
    }
  }
  return errors;
}

export function coverageRevision(input: Omit<ScanCoverageLedger, "revision">): string {
  const stable = JSON.stringify({
    schema: input.schema,
    files: Object.fromEntries(Object.entries(input.files).sort(([a], [b]) => a.localeCompare(b))),
    nodes: Object.fromEntries(Object.entries(input.nodes).sort(([a], [b]) => a.localeCompare(b))),
  });
  return `sha256:${createHash("sha256").update(stable).digest("hex")}`;
}

export interface CoveragePublicationInput {
  committed_revision: string;
  repos: Record<string, { files: Record<string, unknown> }>;
  evidence_ledger?: {
    claims: Record<string, {
      legacy_entity_id: string;
      target: string;
      lifecycle: string;
      supports: Array<{ repo: string; path: string }>;
    }>;
  };
}

/**
 * Build the coverage artifact from the exact structural claims being
 * published. Active source-backed claims are eligible; withdrawn claims and
 * canonical knowledge without live source support are classified explicitly
 * without manufacturing enrichment debt.
 */
export function buildCoverageLedger(
  scan: CoveragePublicationInput,
  canonical: Array<{ target: string; entity: Record<string, unknown> }>,
): ScanCoverageLedger {
  const files: Record<string, CoverageFile> = {};
  for (const [repo, snapshot] of Object.entries(scan.repos)) {
    for (const path of Object.keys(snapshot.files).sort()) {
      for (const target of [...new Set(canonical.filter((entry) =>
        entry.entity.source_repo === repo &&
        Array.isArray(entry.entity.source_files) &&
        (entry.entity.source_files as unknown[]).includes(path),
      ).map((entry) => entry.target))].sort()) {
        files[coverageFileKey(repo, path, target)] = {
          repo, path, target, extractor: target, outcome: "parsed",
          emitted_entity_ids: [],
        };
      }
    }
  }

  const activeClaims = new Map<string, Array<{ repo: string; path: string }>>();
  for (const claim of Object.values(scan.evidence_ledger?.claims ?? {})) {
    if (claim.lifecycle !== "active") continue;
    const supports = claim.supports.filter((support) => scan.repos[support.repo]?.files[support.path]);
    if (supports.length > 0) activeClaims.set(claim.legacy_entity_id, supports.map(({ repo, path }) => ({ repo, path })));
  }

  const nodes: Record<string, CoverageNode> = {};
  for (const { target, entity } of canonical) {
    const id = typeof entity.id === "string" ? entity.id : "";
    if (!id) continue;
    const supports = activeClaims.get(id) ?? [];
    const eligible = supports.length > 0;
    const enriched = (entity.enrichment as { enriched?: boolean } | undefined)?.enriched === true;
    nodes[id] = {
      id, target, supports, eligible,
      semantic_state: eligible ? (enriched ? "enriched" : "pending") : "not_eligible",
      ...(!eligible ? { reason: "no_active_source_support" } : {}),
    };
    for (const support of supports) {
      const key = coverageFileKey(support.repo, support.path, target);
      const file = files[key] ?? (files[key] = {
        repo: support.repo, path: support.path, target,
        extractor: target, outcome: "parsed", emitted_entity_ids: [],
      });
      if (!file.emitted_entity_ids.includes(id)) file.emitted_entity_ids.push(id);
    }
  }
  for (const file of Object.values(files)) file.emitted_entity_ids.sort();
  return { schema: COVERAGE_LEDGER_SCHEMA, revision: scan.committed_revision, files, nodes };
}

export function summarizeCoverage(ledger: ScanCoverageLedger): {
  files_terminal: number;
  files_total: number;
  nodes_classified: number;
  nodes_total: number;
  eligible: number;
  enriched: number;
  pending: number;
  retryable: number;
  terminal: number;
} {
  const nodes = Object.values(ledger.nodes);
  return {
    files_terminal: Object.values(ledger.files).filter((file) => Boolean(file.outcome)).length,
    files_total: Object.keys(ledger.files).length,
    nodes_classified: nodes.filter((node) => Boolean(node.semantic_state)).length,
    nodes_total: nodes.length,
    eligible: nodes.filter((node) => node.eligible).length,
    enriched: nodes.filter((node) => node.eligible && node.semantic_state === "enriched").length,
    pending: nodes.filter((node) => node.eligible && node.semantic_state === "pending").length,
    retryable: nodes.filter((node) => node.eligible && node.semantic_state === "failed_retryable").length,
    terminal: nodes.filter((node) => node.eligible && ["enriched", "skipped", "failed_terminal"].includes(node.semantic_state)).length,
  };
}
