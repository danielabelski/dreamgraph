import { describe, expect, it } from "vitest";
import { claimForEntity, reconcileAddedModifiedEntities, updateDerivedHubStates, withdrawStructuralEvidence } from "../../src/tools/incremental-reconciliation.js";

describe("Slice 5 added/modified structural reconciliation", () => {
  it("preserves governed semantic fields and accumulates source supporters", () => {
    const result = reconcileAddedModifiedEntities({
      revision: "r2",
      existing: [{
        id: "repo_src", name: "Src", description: "curated meaning",
        source_repo: "repo", source_files: ["src/a.ts"],
        tags: ["human"], links: [{ target: "manual", type: "governed" }],
        governed_note: "keep",
      }],
      incoming: [{
        repo: "repo", target: "features", kind: "features",
        file_hashes: { "src/b.ts": "sha256:b" },
        entity: {
          id: "repo_src", name: "Src", description: "Src — 1 source file(s) in src/",
          source_repo: "repo", source_files: ["src/b.ts"], tags: ["scanner"], links: [],
        },
      }],
    });
    expect(result.updated).toBe(1);
    expect(result.entities[0].source_files).toEqual(["src/a.ts", "src/b.ts"]);
    expect(result.entities[0].governed_note).toBe("keep");
    expect(result.entities[0].description).toBe("curated meaning");
    expect(result.entities[0].tags).toEqual(["human"]);
    expect(result.entities[0].links).toEqual([{ target: "manual", type: "governed" }]);
    expect(result.ledger.claims[result.claim_ids[0]].supports).toEqual([
      { repo: "repo", path: "src/b.ts", content_hash: "sha256:b" },
    ]);
  });

  it("produces no churn when the normalized incoming entity is unchanged", () => {
    const entity = {
      id: "repo_models_user", name: "User", source_repo: "repo",
      source_files: ["src/models/user.ts"], status: "active", links: [],
    };
    const result = reconcileAddedModifiedEntities({
      revision: "r2", existing: [entity],
      incoming: [{
        repo: "repo", target: "data_model", kind: "data_model",
        file_hashes: { "src/models/user.ts": "sha256:a" }, entity: { ...entity },
      }],
    });
    expect(result).toMatchObject({ inserted: 0, updated: 0, unchanged: 1 });
    expect(result.entities).toEqual([entity]);
  });

  it("does not infer deletion for claims absent from a Slice 5 changed-file parse", () => {
    const oldClaim = {
      claim_id: "old", semantic_key: "repo:features:features:old", legacy_entity_id: "old",
      target: "features" as const, kind: "features", structural_fingerprint: "s",
      materiality_fingerprint: "m", supports: [{ repo: "repo", path: "old.ts", content_hash: "h" }],
      lifecycle: "active" as const,
    };
    const result = reconcileAddedModifiedEntities({
      revision: "r2", existing: [], incoming: [],
      previous_ledger: { schema: "dreamgraph.structural_evidence.v1", revision: "r1", claims: { old: oldClaim } },
    });
    expect(result.ledger.claims.old).toEqual(oldClaim);
  });

  it("withdraws one supporter without deprecating a multi-source claim", () => {
    const claim = {
      claim_id: "shared", semantic_key: "repo:features:features:shared", legacy_entity_id: "shared",
      target: "features" as const, kind: "features", structural_fingerprint: "s",
      materiality_fingerprint: "m", lifecycle: "active" as const,
      supports: [
        { repo: "repo", path: "a.ts", content_hash: "a" },
        { repo: "repo", path: "b.ts", content_hash: "b" },
      ],
    };
    const result = withdrawStructuralEvidence({
      revision: "r2", ledger: { schema: "dreamgraph.structural_evidence.v1", revision: "r1", claims: { shared: claim } },
      entities: [{ id: "shared", source_files: ["a.ts", "b.ts"], governed_note: "keep" }],
      changes: [{ repo: "repo", deleted: ["a.ts"], renamed: [] }],
    });
    expect(result.ledger.claims.shared.lifecycle).toBe("active");
    expect(result.entities[0]).toMatchObject({ source_files: ["b.ts"], governed_note: "keep" });
  });

  it("tracks derived hubs from contributors without treating them as missing-source entities", () => {
    const ledger = {
      schema: "dreamgraph.structural_evidence.v1" as const, revision: "r2",
      claims: {
        active: {
          claim_id: "active", semantic_key: "repo:features:features:a", legacy_entity_id: "a",
          target: "features" as const, kind: "features", structural_fingerprint: "s",
          materiality_fingerprint: "m", lifecycle: "active" as const,
          supports: [{ repo: "repo", path: "a.ts", content_hash: "a" }],
        },
      },
    };
    const result = updateDerivedHubStates([
      { id: "hub", provenance_class: "derived_hub", derived_from_node_ids: ["a", "b"], governed_note: "retain" },
      { id: "adr", provenance_class: "human_asserted", governed_note: "untouched" },
    ], ledger);
    expect(result.entities[0]).toMatchObject({ derived_state: "degraded", grounded_contributor_ids: ["a"], governed_note: "retain" });
    expect(result.entities[1]).toEqual({ id: "adr", provenance_class: "human_asserted", governed_note: "untouched" });
  });

  it("withdraws a modified file claim that the authoritative reparse no longer emits", () => {
    const claim = {
      claim_id: "removed-member", semantic_key: "repo:features:features:removed-member", legacy_entity_id: "removed-member",
      target: "features" as const, kind: "features", structural_fingerprint: "s",
      materiality_fingerprint: "m", lifecycle: "active" as const,
      supports: [{ repo: "repo", path: "changed.ts", content_hash: "old" }],
    };
    const result = reconcileAddedModifiedEntities({
      revision: "r2",
      existing: [{ id: "removed-member", source_files: ["changed.ts"], governed_note: "retain" }],
      incoming: [],
      reconciliation_target: "features",
      replaced_support_paths: [{ repo: "repo", path: "changed.ts" }],
      previous_ledger: { schema: "dreamgraph.structural_evidence.v1", revision: "r1", claims: { "removed-member": claim } },
    });
    expect(result.ledger.claims["removed-member"]).toMatchObject({ supports: [], lifecycle: "deprecated" });
    expect(result.entities).toEqual([{ id: "removed-member", source_files: ["changed.ts"], governed_note: "retain" }]);
  });

  it("preserves unchanged-file supporters when a shared claim is regenerated", () => {
    const claim = claimForEntity({
      repo: "repo", target: "features", kind: "features",
      file_hashes: { "unchanged.ts": "u", "changed.ts": "old" },
      entity: { id: "shared", name: "Shared", source_files: ["unchanged.ts", "changed.ts"] },
    });
    const result = reconcileAddedModifiedEntities({
      revision: "r2",
      existing: [{ id: "shared", name: "Shared", source_files: ["unchanged.ts", "changed.ts"] }],
      incoming: [{
        repo: "repo", target: "features", kind: "features",
        file_hashes: { "changed.ts": "new" },
        entity: { id: "shared", name: "Shared", source_files: ["changed.ts"] },
      }],
      reconciliation_target: "features",
      replaced_support_paths: [{ repo: "repo", path: "changed.ts" }],
      previous_ledger: { schema: "dreamgraph.structural_evidence.v1", revision: "r1", claims: { [claim.claim_id]: claim } },
    });
    expect(Object.values(result.ledger.claims)[0].supports).toEqual([
      { repo: "repo", path: "unchanged.ts", content_hash: "u" },
      { repo: "repo", path: "changed.ts", content_hash: "new" },
    ]);
  });

  it("deprecates but never purges the last-source entity", () => {
    const claim = {
      claim_id: "solo", semantic_key: "repo:features:features:solo", legacy_entity_id: "solo",
      target: "features" as const, kind: "features", structural_fingerprint: "s",
      materiality_fingerprint: "m", lifecycle: "active" as const,
      supports: [{ repo: "repo", path: "solo.ts", content_hash: "a" }],
    };
    const result = withdrawStructuralEvidence({
      revision: "r2", ledger: { schema: "dreamgraph.structural_evidence.v1", revision: "r1", claims: { solo: claim } },
      entities: [{ id: "solo", source_files: ["solo.ts"], manual_contract: "retain" }],
      changes: [{ repo: "repo", deleted: ["solo.ts"], renamed: [] }],
    });
    expect(result.entities).toHaveLength(1);
    expect(result.entities[0]).toMatchObject({ status: "deprecated", source_files: [], manual_contract: "retain" });
    expect(result.ledger.claims.solo.lifecycle).toBe("deprecated");
  });
});
