import path from "node:path";
import type { StructuralEvidenceClaim, StructuralEvidenceLedger, StructuralEvidenceSupport, EvidenceTarget } from "./scan-state.js";
import { buildStructuralClaim, reconcileStructuralLedger } from "./scan-state.js";

export const SCANNER_OWNED_FIELDS = new Set([
  "id", "name", "source_repo", "source_files", "status", "semantic_validity",
]);

export interface IncrementalEntityInput {
  repo: string;
  target: EvidenceTarget;
  kind: string;
  entity: Record<string, unknown>;
  file_hashes: Record<string, string>;
}

export interface IncrementalReconciliationResult {
  entities: Record<string, unknown>[];
  ledger: StructuralEvidenceLedger;
  inserted: number;
  updated: number;
  unchanged: number;
  claim_ids: string[];
  semantic_metrics: {
    retained: number;
    invalidated: number;
    eligible: number;
    reviewed_manual: number;
    reasons: Record<string, number>;
  };
}

function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${stable(record[key])}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "undefined";
}

function supporters(input: IncrementalEntityInput): StructuralEvidenceSupport[] {
  return strings(input.entity.source_files)
    .filter((file) => input.file_hashes[file])
    .map((file) => ({ repo: input.repo, path: file, content_hash: input.file_hashes[file] }));
}

export function claimForEntity(input: IncrementalEntityInput): StructuralEvidenceClaim {
  const id = String(input.entity.id ?? "");
  const name = String(input.entity.name ?? id);
  const structural = Object.fromEntries(
    Object.entries(input.entity).filter(([key]) => SCANNER_OWNED_FIELDS.has(key) && key !== "semantic_validity"),
  );
  const material = {
    source_files: strings(input.entity.source_files).sort(),
    support_hashes: supporters(input).map((support) => ({ path: support.path, content_hash: support.content_hash })),
    structural,
  };
  return buildStructuralClaim({
    repo: input.repo,
    target: input.target,
    kind: input.kind,
    name,
    legacy_entity_id: id,
    structural,
    material,
    supports: supporters(input),
  });
}

function mergeOwned(
  existing: Record<string, unknown>,
  incoming: Record<string, unknown>,
): Record<string, unknown> {
  const next = { ...existing };
  for (const [key, value] of Object.entries(incoming)) {
    if (key === "source_files") {
      next.source_files = [...new Set([...strings(existing.source_files), ...strings(value)])].sort();
      continue;
    }
    if (SCANNER_OWNED_FIELDS.has(key) || !(key in existing)) next[key] = value;
  }
  if (typeof next.description === "string" && /source file\(s\) in/.test(next.description)) {
    next.description = next.description.replace(/— \d+ source file\(s\) in/, `— ${strings(next.source_files).length} source file(s) in`);
  }
  return next;
}

/**
 * Reconciles claims produced by added/materially modified files.
 * Slice 5 deliberately performs no absent-path lifecycle inference.
 */
export function reconcileAddedModifiedEntities(input: {
  existing: Record<string, unknown>[];
  incoming: IncrementalEntityInput[];
  previous_ledger?: StructuralEvidenceLedger;
  /** Target authoritatively reconciled, required when a reparse emits no claims. */
  reconciliation_target?: EvidenceTarget;
  /** Files authoritatively reparsed for this target in this pass. */
  replaced_support_paths?: Array<{ repo: string; path: string }>;
  revision: string;
}): IncrementalReconciliationResult {
  const map = new Map(input.existing.map((entity) => [String(entity.id), entity]));
  const claims = input.incoming.map(claimForEntity);
  let inserted = 0;
  let updated = 0;
  let unchanged = 0;
  const semantic_metrics = {
    retained: 0, invalidated: 0, eligible: 0, reviewed_manual: 0,
    reasons: {} as Record<string, number>,
  };
  const previousClaims = input.previous_ledger?.claims ?? {};
  const replacedSupports = new Set((input.replaced_support_paths ?? []).map((support) => `${support.repo}:${support.path}`));
  const reason = (value: string) => { semantic_metrics.reasons[value] = (semantic_metrics.reasons[value] ?? 0) + 1; };

  // A changed file is authoritative for the target being reconciled. Preserve
  // supporters from unchanged files, but withdraw claims that the reparsed file
  // no longer emits. This is target-scoped and never infers across other domains.
  const incomingClaimIds = new Set(claims.map((claim) => claim.claim_id));
  const retainedClaims = Object.values(previousClaims).flatMap((claim) => {
    if (incomingClaimIds.has(claim.claim_id)) return [];
    const target = input.reconciliation_target ?? input.incoming[0]?.target;
    if (!target || claim.target !== target) return [claim];
    const supports = claim.supports.filter((support) => !replacedSupports.has(`${support.repo}:${support.path}`));
    return [{ ...claim, supports, lifecycle: supports.length > 0 ? "active" as const : "deprecated" as const }];
  });

  for (let index = 0; index < input.incoming.length; index++) {
    const item = input.incoming[index];
    const claim = claims[index];
    const id = String(item.entity.id ?? "");
    if (!id) continue;
    const prior = map.get(id);
    const priorClaim = previousClaims[claim.claim_id];
    if (!prior) {
      map.set(id, { ...item.entity, semantic_validity: { state: "eligible", reason: "new_structural_claim" } });
      inserted++;
      semantic_metrics.eligible++;
      reason("new_structural_claim");
      continue;
    }
    const materiallyChanged = !priorClaim || priorClaim.materiality_fingerprint !== claim.materiality_fingerprint;
    const hasHumanAssertion = Object.keys(prior).some((key) =>
      key.startsWith("manual_") || key.startsWith("governed_") || key === "human_asserted",
    );
    const hasSemanticEnrichment = Boolean(prior.enrichment || prior.enriched_at || prior.semantic_cache);
    let validity: { state: string; reason: string } | undefined;
    if (materiallyChanged && hasHumanAssertion) {
      validity = { state: "review", reason: "manual_assertion_requires_review" };
      semantic_metrics.reviewed_manual++;
    } else if (materiallyChanged && hasSemanticEnrichment) {
      validity = { state: "invalidated", reason: "direct_material_change" };
      semantic_metrics.invalidated++;
    } else if (materiallyChanged) {
      semantic_metrics.eligible++;
    } else {
      semantic_metrics.retained++;
    }
    const outcomeReason = validity?.reason ?? (materiallyChanged ? "parser_or_fallback_eligible" : "support_and_materiality_unchanged");
    const merged = mergeOwned(prior, validity ? { ...item.entity, semantic_validity: validity } : item.entity);
    reason(outcomeReason);
    if (stable(merged) === stable(prior)) unchanged++;
    else {
      map.set(id, merged);
      updated++;
    }
  }

  const mergedClaims = claims.map((claim) => {
    const prior = previousClaims[claim.claim_id];
    if (!prior) return claim;
    const preserved = prior.supports.filter((support) => !replacedSupports.has(`${support.repo}:${support.path}`));
    const supports = [...preserved, ...claim.supports].filter((support, index, all) =>
      all.findIndex((candidate) =>
        candidate.repo === support.repo && candidate.path === support.path && candidate.content_hash === support.content_hash
      ) === index
    );
    return { ...claim, supports, lifecycle: supports.length > 0 ? "active" as const : "deprecated" as const };
  });
  const ledger = reconcileStructuralLedger(undefined, [...retainedClaims, ...mergedClaims], input.revision);

  return {
    entities: [...map.values()],
    ledger,
    inserted,
    updated,
    unchanged,
    claim_ids: claims.map((claim) => claim.claim_id),
    semantic_metrics,
  };
}

export function updateDerivedHubStates(
  entities: Record<string, unknown>[],
  ledger: StructuralEvidenceLedger,
): { entities: Record<string, unknown>[]; states: Record<string, number> } {
  const activeIds = new Set(Object.values(ledger.claims)
    .filter((claim) => claim.lifecycle === "active" && claim.supports.length > 0)
    .map((claim) => claim.legacy_entity_id));
  const states: Record<string, number> = { retained: 0, recomputed: 0, degraded: 0, deprecated: 0 };
  return {
    entities: entities.map((entity) => {
      const provenance = entity.provenance_class ?? (entity.provenance as Record<string, unknown> | undefined)?.class;
      if (provenance !== "derived_hub") return entity;
      const contributors = strings(entity.derived_from_node_ids);
      const grounded = contributors.filter((id) => activeIds.has(id));
      const state = grounded.length === 0 ? "deprecated"
        : grounded.length < contributors.length ? "degraded"
        : "retained";
      states[state]++;
      return {
        ...entity,
        derived_state: state,
        grounded_contributor_ids: grounded,
        ...(state !== "retained" ? { evidence_review: `Derived hub ${state}: ${grounded.length}/${contributors.length} contributors remain grounded.` } : {}),
      };
    }),
    states,
  };
}

export interface EvidenceWithdrawal {
  repo: string;
  deleted: string[];
  renamed: Array<{ from: string; to: string; content_hash: string }>;
}

export function withdrawStructuralEvidence(input: {
  ledger: StructuralEvidenceLedger;
  entities: Record<string, unknown>[];
  changes: EvidenceWithdrawal[];
  revision: string;
}): { ledger: StructuralEvidenceLedger; entities: Record<string, unknown>[]; withdrawn: number; deprecated: number } {
  const deleted = new Set(input.changes.flatMap((change) => change.deleted.map((file) => `${change.repo}:${file}`)));
  const renames = new Map(input.changes.flatMap((change) =>
    change.renamed.map((move) => [`${change.repo}:${move.from}:${move.content_hash}`, move.to] as const),
  ));
  let withdrawn = 0;
  let deprecated = 0;
  const claims = Object.fromEntries(Object.values(input.ledger.claims).map((claim) => {
    const supports = claim.supports.flatMap((support) => {
      const moved = renames.get(`${support.repo}:${support.path}:${support.content_hash}`);
      if (moved) {
        // A same-identity incoming claim already replaced this claim with the new
        // supporter. Reaching this old supporter means continuity was not evidenced.
        withdrawn++;
        return [];
      }
      if (deleted.has(`${support.repo}:${support.path}`)) {
        withdrawn++;
        return [];
      }
      return [support];
    });
    const lifecycle = supports.length > 0 ? "active" : "deprecated";
    if (lifecycle === "deprecated" && claim.lifecycle !== "deprecated") deprecated++;
    return [claim.claim_id, { ...claim, supports, lifecycle } satisfies StructuralEvidenceClaim];
  }));
  const activeFilesByEntity = new Map<string, Set<string>>();
  for (const claim of Object.values(claims)) {
    const files = activeFilesByEntity.get(claim.legacy_entity_id) ?? new Set<string>();
    for (const support of claim.supports) files.add(support.path);
    activeFilesByEntity.set(claim.legacy_entity_id, files);
  }
  const entities = input.entities.map((entity) => {
    const id = String(entity.id ?? "");
    if (!activeFilesByEntity.has(id)) return entity;
    const files = [...activeFilesByEntity.get(id)!].sort();
    return {
      ...entity,
      source_files: files,
      ...(files.length === 0 ? {
        status: "deprecated",
        evidence_review: "Source support withdrawn; governed and historical knowledge retained.",
      } : {}),
    };
  });
  return {
    ledger: { schema: "dreamgraph.structural_evidence.v1", revision: input.revision, claims },
    entities, withdrawn, deprecated,
  };
}

export function makeScannedFile(repoRoot: string, relativePath: string, size: number) {
  const rel = relativePath.replace(/\\/g, "/");
  const name = path.posix.basename(rel);
  const ext = path.posix.extname(name).toLowerCase();
  return {
    abs: path.resolve(repoRoot, ...rel.split("/")),
    rel,
    name,
    ext,
    dirParts: path.posix.dirname(rel).split("/").filter((part) => part && part !== "."),
    size,
  };
}
