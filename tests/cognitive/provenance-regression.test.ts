import { describe, expect, it } from "vitest";

type ProvenanceKind = "source_backed" | "derived_hub" | "human_asserted" | "speculative";

type ProvenanceNode = {
  id: string;
  source_repo?: string | string[];
  source_files?: string[];
  provenance_kind?: ProvenanceKind;
  derived_from_node_ids?: string[];
  human_asserted?: boolean;
};

function repos(node: ProvenanceNode): string[] {
  if (Array.isArray(node.source_repo)) return node.source_repo.filter((repo) => repo.trim().length > 0);
  if (typeof node.source_repo === "string" && node.source_repo.trim().length > 0) return [node.source_repo];
  return [];
}

function isDirectlyGrounded(node: ProvenanceNode): boolean {
  if (repos(node).length === 0) return false;
  if ((node.source_files ?? []).some((file) => file.trim().length > 0)) return true;
  return node.provenance_kind === "human_asserted" || node.human_asserted === true;
}

function groundedNodeIds(nodes: ProvenanceNode[]): Set<string> {
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const grounded = new Set(nodes.filter(isDirectlyGrounded).map((node) => node.id));

  let changed = true;
  while (changed) {
    changed = false;
    for (const node of nodes) {
      if (grounded.has(node.id)) continue;
      if (repos(node).length === 0) continue;
      if (node.provenance_kind !== "derived_hub") continue;

      const supports = node.derived_from_node_ids ?? [];
      if (supports.length === 0) continue;
      if (supports.every((supportId) => byId.has(supportId) && grounded.has(supportId))) {
        grounded.add(node.id);
        changed = true;
      }
    }
  }

  return grounded;
}

describe("canonical provenance regression invariants", () => {
  it("rejects self-consistent fictional clusters with no repository provenance", () => {
    const nodes: ProvenanceNode[] = [
      { id: "auth:login", provenance_kind: "derived_hub", derived_from_node_ids: ["auth:session"] },
      { id: "auth:session", provenance_kind: "derived_hub", derived_from_node_ids: ["auth:jwt"] },
      { id: "auth:jwt", provenance_kind: "derived_hub", derived_from_node_ids: ["auth:login"] },
    ];

    const grounded = groundedNodeIds(nodes);

    expect(grounded.size).toBe(0);
  });

  it("preserves repo-scoped hubs derived from source-backed project nodes", () => {
    const nodes: ProvenanceNode[] = [
      {
        id: "feature:scanner",
        source_repo: "managed-project",
        source_files: ["src/scanner.ts"],
        provenance_kind: "source_backed",
      },
      {
        id: "feature:indexer",
        source_repo: "managed-project",
        source_files: ["src/indexer.ts"],
        provenance_kind: "source_backed",
      },
      {
        id: "hub:graph-assembly",
        source_repo: "managed-project",
        provenance_kind: "derived_hub",
        derived_from_node_ids: ["feature:scanner", "feature:indexer"],
      },
    ];

    const grounded = groundedNodeIds(nodes);

    expect(grounded.has("hub:graph-assembly")).toBe(true);
  });

  it("preserves hub-to-hub chains only when they ultimately reach grounded repo nodes", () => {
    const nodes: ProvenanceNode[] = [
      {
        id: "workflow:scan",
        source_repo: "managed-project",
        source_files: ["src/scan.ts"],
        provenance_kind: "source_backed",
      },
      {
        id: "hub:ingestion",
        source_repo: "managed-project",
        provenance_kind: "derived_hub",
        derived_from_node_ids: ["workflow:scan"],
      },
      {
        id: "hub:platform-surface",
        source_repo: ["managed-project", "integration-plugin"],
        provenance_kind: "derived_hub",
        derived_from_node_ids: ["hub:ingestion"],
      },
      {
        id: "hub:fictional-security",
        source_repo: "managed-project",
        provenance_kind: "derived_hub",
        derived_from_node_ids: ["hub:missing-auth"],
      },
    ];

    const grounded = groundedNodeIds(nodes);

    expect(grounded.has("hub:platform-surface")).toBe(true);
    expect(grounded.has("hub:fictional-security")).toBe(false);
  });
});
