/**
 * DreamGraph MCP Server — direct validated-edge mutation tools.
 *
 * Provides an operator-facing escape hatch for maintaining the validated
 * edge store when legacy/speculative edges should be retired or redirected.
 *
 * Scope in v1:
 *   - mutate VALIDATED edges only (validated_edges.json)
 *   - actions: delete, retarget
 *
 * Why not entity visibility here?
 *   Graph-entity visibility is not currently a first-class persisted concept
 *   in the fact graph schema. Direct validated-edge mutation is the strongly
 *   grounded capability the system already models and persists.
 */

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { engine } from "../cognitive/engine.js";
import { invalidateCache, loadJsonArray } from "../utils/cache.js";
import { success, error, safeExecute } from "../utils/errors.js";
import { logger } from "../utils/logger.js";
import type {
  Feature,
  Workflow,
  DataModelEntity,
  CapabilityEntity,
  ToolResponse,
  ValidatedEdge,
} from "../types/index.js";

interface GraphEdgeMutationResult {
  action: "delete" | "retarget";
  edge_id: string;
  affected_ids: string[];
  updated?: ValidatedEdge;
  removed?: ValidatedEdge;
  total_validated: number;
  message: string;
}

async function loadKnownEntityIds(): Promise<Set<string>> {
  const [features, workflows, dataModel, capabilities] = await Promise.all([
    loadJsonArray<Feature>("features.json"),
    loadJsonArray<Workflow>("workflows.json"),
    loadJsonArray<DataModelEntity>("data_model.json"),
    loadJsonArray<CapabilityEntity>("capabilities.json"),
  ]);

  return new Set([
    ...features.map((x) => x.id),
    ...workflows.map((x) => x.id),
    ...dataModel.map((x) => x.id),
    ...capabilities.map((x) => x.id),
  ].filter(Boolean));
}

function normalizeRelation(input?: string | null): string | undefined {
  const s = typeof input === "string" ? input.trim() : "";
  return s.length > 0 ? s : undefined;
}

export async function executeGraphEdgeMutation(params: {
  action: "delete" | "retarget";
  edge_id: string;
  new_from?: string;
  new_to?: string;
  relation?: string;
  allow_dangling_target?: boolean;
}): Promise<ToolResponse<GraphEdgeMutationResult>> {
  return safeExecute<GraphEdgeMutationResult>(async () => {
    const { action, edge_id, new_from, new_to, relation, allow_dangling_target } = params;

    const validated = await engine.loadValidatedEdges();
    const idx = validated.edges.findIndex((e) => e.id === edge_id);
    if (idx === -1) {
      return error("NOT_FOUND", `Validated edge not found: ${edge_id}`);
    }

    const knownIds = await loadKnownEntityIds();
    const existing = validated.edges[idx];

    if (action === "delete") {
      const [removed] = validated.edges.splice(idx, 1);
      validated.metadata.last_validation = new Date().toISOString();
      validated.metadata.total_validated = validated.edges.length;
      await engine.saveValidatedEdges(validated);
      invalidateCache("validated_edges.json");

      logger.info(`graph_edge_mutation: deleted validated edge ${edge_id}`);
      return success({
        action,
        edge_id,
        removed,
        affected_ids: [removed.from, removed.to].filter(Boolean),
        total_validated: validated.edges.length,
        message: `Deleted validated edge ${edge_id}`,
      });
    }

    const nextFrom = (new_from ?? existing.from).trim();
    const nextTo = (new_to ?? existing.to).trim();
    const nextRelation = normalizeRelation(relation) ?? existing.relation;

    if (!nextFrom || !nextTo) {
      return error("VALIDATION_ERROR", "retarget requires a non-empty resulting from/to endpoint set");
    }

    if (!knownIds.has(nextFrom)) {
      return error("UNKNOWN_ENTITY", `Unknown from entity: ${nextFrom}`);
    }

    if (!allow_dangling_target && !knownIds.has(nextTo)) {
      return error(
        "UNKNOWN_ENTITY",
        `Unknown to entity: ${nextTo}. Pass allow_dangling_target=true only when intentionally pointing to a non-seed external id.`,
      );
    }

    const duplicate = validated.edges.find(
      (edge, i) =>
        i !== idx &&
        edge.from === nextFrom &&
        edge.to === nextTo &&
        edge.relation === nextRelation,
    );
    if (duplicate) {
      return error(
        "DUPLICATE_EDGE",
        `Retarget would duplicate existing validated edge ${duplicate.id} (${nextFrom} -> ${nextTo} / ${nextRelation})`,
      );
    }

    const updated: ValidatedEdge = {
      ...existing,
      from: nextFrom,
      to: nextTo,
      relation: nextRelation,
      validated_at: new Date().toISOString(),
    };

    validated.edges[idx] = updated;
    validated.metadata.last_validation = updated.validated_at;
    validated.metadata.total_validated = validated.edges.length;
    await engine.saveValidatedEdges(validated);
    invalidateCache("validated_edges.json");

    logger.info(
      `graph_edge_mutation: retargeted ${edge_id} ${existing.from}->${existing.to} to ${updated.from}->${updated.to}`,
    );
    return success({
      action,
      edge_id,
      updated,
      affected_ids: [existing.from, existing.to, updated.from, updated.to].filter(Boolean),
      total_validated: validated.edges.length,
      message: `Retargeted validated edge ${edge_id}`,
    });
  }, "executeGraphEdgeMutation");
}

export function registerGraphEdgeMutationTools(server: McpServer): void {
  server.tool(
    "mutate_validated_edge",
    "Directly mutate a validated graph edge in validated_edges.json. Supports deleting a stale edge or retargeting an existing edge to new canonical endpoints. Use sparingly for graph hygiene and ADR-backed canonicalization work.",
    {
      action: z.enum(["delete", "retarget"]).describe("Mutation to apply to the validated edge."),
      edge_id: z.string().min(1).describe("Validated edge id to mutate."),
      new_from: z.string().optional().describe("New source entity id for retarget action."),
      new_to: z.string().optional().describe("New target entity id for retarget action."),
      relation: z.string().optional().describe("Optional replacement relation for retarget action."),
      allow_dangling_target: z.boolean().optional().describe("Allow new_to to point outside known seed entities. Defaults to false."),
    },
    async ({ action, edge_id, new_from, new_to, relation, allow_dangling_target }) => {
      if (action === "retarget" && !new_from && !new_to && !normalizeRelation(relation)) {
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(
                error("VALIDATION_ERROR", "retarget requires at least one of new_from, new_to, or relation"),
                null,
                2,
              ),
            },
          ],
        };
      }

      const result = await executeGraphEdgeMutation({
        action,
        edge_id,
        new_from,
        new_to,
        relation,
        allow_dangling_target,
      });

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(result, null, 2),
          },
        ],
      };
    },
  );
}
