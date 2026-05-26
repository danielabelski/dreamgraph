/**
 * DreamGraph MCP Server — Semantic UI Registry tools.
 *
 * Tools for managing platform-independent UI element definitions:
 *   register_ui_element — Register or update a semantic element
 *   query_ui_elements — Search by category, platform, purpose, or feature
 *   generate_ui_migration_plan — Gap analysis between source and target platforms
 *
 * The registry describes WHAT elements are (purpose, data contract,
 * interaction model, abstract visual/layout intent), not HOW they look.
 *
 * Data file: data/ui_registry.json
 */

import { z } from "zod";
import { readFile } from "node:fs/promises";
import { atomicWriteFile } from "../utils/atomic-write.js";
import { existsSync } from "node:fs";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { dataPath } from "../utils/paths.js";
import { success, error, safeExecute } from "../utils/errors.js";
import { logger } from "../utils/logger.js";
import { withFileLock } from "../utils/mutex.js";
import { selectLlmRoute } from "../cognitive/llm.js";
import type { LlmMessage } from "../cognitive/llm.js";
import type {
  UIRegistryFile,
  SemanticElement,
  SemanticElementCategory,
  RegisterUIElementOutput,
  QueryUIElementsOutput,
  GenerateUIMigrationOutput,
  MigrationPortedElement,
  MigrationGapElement,
  UIMigrationAdaptivePlan,
  UIMigrationElementMapping,
  UIMigrationFutureKind,
  UIMigrationPlanStep,
  UIMigrationPlanningMetadata,
  ToolResponse,
} from "../types/index.js";

const registryPath = () => dataPath("ui_registry.json");

type ElementStatus = "active" | "transitional" | "deprecated";

async function loadRegistry(): Promise<UIRegistryFile> {
  try {
    if (!existsSync(registryPath())) return emptyRegistry();
    const raw = await readFile(registryPath(), "utf-8");
    const parsed = JSON.parse(raw);

    const empty = emptyRegistry();
    const rawElements = Array.isArray(parsed.elements) ? parsed.elements : [];
    const elements = rawElements.map(normalizeElement);

    return {
      metadata: {
        ...empty.metadata,
        ...(parsed.metadata && typeof parsed.metadata === "object"
          ? parsed.metadata
          : {}),
        schema_version: "1.2.0",
      },
      elements,
      ...(parsed._schema_notes &&
        typeof parsed._schema_notes === "object" && {
          _schema_notes: parsed._schema_notes,
        }),
    };
  } catch {
    return emptyRegistry();
  }
}

async function saveRegistry(data: UIRegistryFile): Promise<void> {
  data.metadata.total_elements = data.elements.length;
  const categories = new Set(data.elements.map((e) => e.category));
  data.metadata.total_categories = categories.size;
  data.metadata.last_updated = new Date().toISOString();
  data.metadata.schema_version = "1.2.0";
  data._schema_notes = {
    ...(data._schema_notes ?? {}),
    visual_semantics:
      "Abstract visual language: role, emphasis, density, chrome, and state-driven treatments. Never store CSS classes, Tailwind tokens, or pixel values here.",
    layout_semantics:
      "Abstract layout contract: pattern, alignment, sizing, responsive behavior, and hierarchy. Keep framework-agnostic and implementation-independent.",
    lifecycle_fields:
      "status, superseded_by, and deprecation_reason support non-destructive registry retirement. Omitted status means active for backward compatibility.",
  };
  await atomicWriteFile(registryPath(), JSON.stringify(data, null, 2));
  logger.debug("UI registry saved to disk");
}

/* ------------------------------------------------------------------ */
/*  M6 — Plugin UI seam helpers                                       */
/* ------------------------------------------------------------------ */

export interface PluginUiElementInput {
  id: string;
  name: string;
  purpose: string;
  category: SemanticElementCategory;
  inputs: SemanticElement["data_contract"]["inputs"];
  outputs: SemanticElement["data_contract"]["outputs"];
  interactions: SemanticElement["interactions"];
  children?: string[];
  implementations?: SemanticElement["implementations"];
  used_by?: string[];
  tags?: string[];
}

/**
 * Host-side upsert used by the M6 plugin UI seam. Performs the same
 * file-locked merge the `register_ui_element` MCP tool performs, but
 * with the minimal field set the seam exposes. Plugin-owned elements
 * carry an automatic `plugin:<plugin-id>` tag so they are easy to
 * identify and prune on plugin unload.
 */
export async function applyPluginUiElement(
  pluginId: string,
  input: PluginUiElementInput,
): Promise<{ merged: boolean }> {
  const tagSet = new Set(input.tags ?? []);
  tagSet.add(`plugin:${pluginId}`);
  return withFileLock("ui_registry.json", async () => {
    const registry = await loadRegistry();
    const existing = registry.elements.find((e) => e.id === input.id);
    let merged = false;
    if (existing) {
      existing.name = input.name;
      existing.purpose = input.purpose;
      existing.category = input.category;
      existing.data_contract = { inputs: input.inputs, outputs: input.outputs };
      existing.interactions = input.interactions;
      if (input.children !== undefined) existing.children = input.children;
      const newImpls = input.implementations ?? [];
      for (const impl of newImpls) {
        const idx = existing.implementations.findIndex((i) => i.platform === impl.platform);
        if (idx >= 0) existing.implementations[idx] = impl;
        else existing.implementations.push(impl);
      }
      existing.used_by = [...new Set([...existing.used_by, ...(input.used_by ?? [])])];
      existing.tags = [...new Set([...(existing.tags ?? []), ...tagSet])];
      // Slice 1 — do not downgrade existing provenance (e.g. scanner-emitted
      // element later updated by a plugin keeps its `scanner` source_kind).
      if (!existing.source_kind) existing.source_kind = "sdk";
      merged = true;
    } else {
      const element: SemanticElement = {
        id: input.id,
        name: input.name,
        purpose: input.purpose,
        category: input.category,
        data_contract: { inputs: input.inputs, outputs: input.outputs },
        interactions: input.interactions,
        ...(input.children !== undefined ? { children: input.children } : {}),
        implementations: input.implementations ?? [],
        used_by: input.used_by ?? [],
        tags: [...tagSet],
        // Slice 1 — plugin-originated elements are stamped as `sdk` provenance.
        // No source_repo is set automatically (plugins are not project-bound),
        // so they remain in the registry but are NOT indexed in index.json.
        source_kind: "sdk",
      };
      registry.elements.push(element);
    }
    await saveRegistry(registry);
    return { merged };
  });
}

/**
 * Host-side removal used when a plugin is unloaded. Drops every element
 * tagged `plugin:<plugin-id>`. Returns the number of removed entries.
 */
export async function removePluginUiElements(pluginId: string): Promise<{ removed: number }> {
  const tag = `plugin:${pluginId}`;
  return withFileLock("ui_registry.json", async () => {
    const registry = await loadRegistry();
    const before = registry.elements.length;
    registry.elements = registry.elements.filter((e) => !(e.tags ?? []).includes(tag));
    const removed = before - registry.elements.length;
    if (removed > 0) await saveRegistry(registry);
    return { removed };
  });
}

/* ------------------------------------------------------------------ */
/*  Slice 2 — Scanner UI bulk-merge helper                            */
/* ------------------------------------------------------------------ */

export interface ScannerUiMergeResult {
  /** Newly inserted scanner-origin elements. */
  inserted: number;
  /** Existing scanner-origin elements whose detection fields were refreshed. */
  updated: number;
  /** Elements skipped because the existing entry has non-scanner provenance (manual/sdk/user_guidance). */
  skipped_protected: number;
  /** Total scanner-origin element count for `repoName` after the merge. */
  total_for_repo: number;
}

/**
 * Bulk-merge scanner-origin SemanticElement records into `ui_registry.json`.
 *
 * Provenance discipline (slice 2 invariant):
 *   - New ids are inserted as-is (already stamped `source_kind: "scanner"`).
 *   - Existing entries with `source_kind === "scanner"` (or absent, treated
 *     as legacy scanner) are refreshed for detection-time fields:
 *     `name`, `purpose`, `tags`, `implementations`, `source_repo`,
 *     `source_file`, `source_kind`. Enrichment fields
 *     (`intent`, `description_raw`, `enrichment`, `links`,
 *     `visual_semantics`, etc.) are preserved across re-scans so the
 *     scanner never erases LLM enrichment work.
 *   - Existing entries with `source_kind` in {"manual", "sdk",
 *     "user_guidance", "generated"} are SKIPPED. The scanner never
 *     overwrites human- or plugin-authored entries.
 *
 * Returns counters that scan_project can fold into its scan_quality
 * summary.
 */
export async function applyScannerUiElements(
  repoName: string,
  elements: SemanticElement[],
): Promise<ScannerUiMergeResult> {
  const result: ScannerUiMergeResult = {
    inserted: 0,
    updated: 0,
    skipped_protected: 0,
    total_for_repo: 0,
  };
  if (elements.length === 0) {
    return withFileLock("ui_registry.json", async () => {
      const registry = await loadRegistry();
      result.total_for_repo = registry.elements.filter(
        (e) => e.source_repo === repoName && e.source_kind === "scanner",
      ).length;
      return result;
    });
  }
  return withFileLock("ui_registry.json", async () => {
    const registry = await loadRegistry();
    for (const incoming of elements) {
      const idx = registry.elements.findIndex((e) => e.id === incoming.id);
      if (idx < 0) {
        registry.elements.push(incoming);
        result.inserted += 1;
        continue;
      }
      const existing = registry.elements[idx];
      const provenance = existing.source_kind;
      const isScannerOwned = provenance === undefined || provenance === "scanner";
      if (!isScannerOwned) {
        result.skipped_protected += 1;
        continue;
      }
      // Refresh detection-time fields only. Preserve enrichment work and
      // any non-scanner fields a curator may have set on a previously
      // scanner-emitted entry.
      existing.name = incoming.name;
      existing.purpose = incoming.purpose;
      existing.implementations = incoming.implementations;
      existing.source_repo = incoming.source_repo;
      existing.source_file = incoming.source_file;
      existing.source_kind = "scanner";
      const mergedTags = new Set([...(existing.tags ?? []), ...(incoming.tags ?? [])]);
      existing.tags = [...mergedTags];
      result.updated += 1;
    }
    result.total_for_repo = registry.elements.filter(
      (e) => e.source_repo === repoName && e.source_kind === "scanner",
    ).length;
    await saveRegistry(registry);
    return result;
  });
}

function emptyRegistry(): UIRegistryFile {
  return {
    metadata: {
      description:
        "Semantic UI Registry — platform-independent element definitions with purpose, data contract, interaction model, abstract visual/layout semantics, and backward-compatible lifecycle governance.",
      schema_version: "1.2.0",
      total_elements: 0,
      total_categories: 0,
      last_updated: null,
    },
    elements: [],
    _schema_notes: {
      visual_semantics:
        "Abstract visual language only. Use semantic roles and hierarchy, not raw styling implementation details.",
      layout_semantics:
        "Abstract layout/composition only. Use patterns and responsive intent, not exact grid props or pixel spacing.",
      lifecycle_fields:
        "Use status/superseded_by/deprecation_reason to mark transitional or deprecated entries without deleting history.",
    },
  };
}

function normalizeElement(raw: any): SemanticElement {
  const normalized: SemanticElement = {
    ...raw,
    implementations: Array.isArray(raw?.implementations) ? raw.implementations : [],
    used_by: Array.isArray(raw?.used_by) ? raw.used_by : [],
    tags: Array.isArray(raw?.tags) ? raw.tags : [],
    interactions: Array.isArray(raw?.interactions) ? raw.interactions : [],
    data_contract: {
      inputs: Array.isArray(raw?.data_contract?.inputs) ? raw.data_contract.inputs : [],
      outputs: Array.isArray(raw?.data_contract?.outputs) ? raw.data_contract.outputs : [],
    },
  };

  if (
    raw?.status === "active" ||
    raw?.status === "transitional" ||
    raw?.status === "deprecated"
  ) {
    normalized.status = raw.status;
  }
  if (typeof raw?.superseded_by === "string") normalized.superseded_by = raw.superseded_by;
  if (typeof raw?.deprecation_reason === "string") normalized.deprecation_reason = raw.deprecation_reason;

  // Slice 1 — first-class graph citizenship: preserve provenance + enrichment
  // fields on round-trip so they survive any external edit / file reload.
  if (typeof raw?.source_repo === "string") normalized.source_repo = raw.source_repo;
  if (typeof raw?.source_file === "string") normalized.source_file = raw.source_file;
  if (
    raw?.source_kind === "scanner" ||
    raw?.source_kind === "manual" ||
    raw?.source_kind === "sdk" ||
    raw?.source_kind === "user_guidance" ||
    raw?.source_kind === "generated"
  ) {
    normalized.source_kind = raw.source_kind;
  }
  if (Array.isArray(raw?.evidence_refs)) {
    normalized.evidence_refs = raw.evidence_refs.filter((r: unknown) => typeof r === "string");
  }
  if (typeof raw?.intent === "string") normalized.intent = raw.intent;
  if (typeof raw?.description_raw === "string") normalized.description_raw = raw.description_raw;
  if (raw?.enrichment && typeof raw.enrichment === "object") {
    const e = raw.enrichment as Record<string, unknown>;
    if (typeof e.enriched === "boolean" && typeof e.enriched_at === "string" && typeof e.enricher === "string") {
      normalized.enrichment = {
        enriched: e.enriched,
        enriched_at: e.enriched_at,
        enricher: e.enricher,
        ...(typeof e.model === "string" ? { model: e.model } : {}),
        ...(typeof e.confidence === "number" ? { confidence: e.confidence } : {}),
      };
    }
  }
  if (Array.isArray(raw?.links)) {
    normalized.links = raw.links.filter(
      (l: unknown): l is NonNullable<SemanticElement["links"]>[number] =>
        !!l && typeof l === "object" &&
        typeof (l as { target?: unknown }).target === "string" &&
        typeof (l as { type?: unknown }).type === "string",
    );
  }

  return normalized;
}

function effectiveStatus(el: SemanticElement): ElementStatus {
  return el.status ?? "active";
}

function estimateComplexity(
  el: SemanticElement
): "trivial" | "moderate" | "complex" {
  const inputCount = el.data_contract.inputs.length;
  const outputCount = el.data_contract.outputs.length;
  const hasChildren = (el.children?.length ?? 0) > 0;

  if (el.category === "composite") return "complex";
  if (inputCount + outputCount >= 5) return "complex";
  if (inputCount + outputCount >= 2 || hasChildren) return "moderate";
  return "trivial";
}

interface GenerateUIMigrationParams {
  source_platform: string;
  target_platform: string;
  scope?: string[];
}

interface UIMigrationEvidence {
  sourcePlatform: string;
  targetPlatform: string;
  sourceElements: SemanticElement[];
  targetElements: SemanticElement[];
  deprecatedElements: SemanticElement[];
  ported: MigrationPortedElement[];
  gaps: MigrationGapElement[];
}

interface UIMigrationValidationContext {
  sourceElementIds: Set<string>;
  existingElementIds: Set<string>;
}

const UI_MIGRATION_FUTURES: UIMigrationFutureKind[] = [
  "direct_port",
  "refactor",
  "split_component",
  "defer",
  "redesign",
];

const UI_MIGRATION_FUTURE_SET = new Set<string>(UI_MIGRATION_FUTURES);

const UI_MIGRATION_PLAN_JSON_SCHEMA: Record<string, unknown> = {
  type: "object",
  additionalProperties: false,
  required: [
    "strategy_summary",
    "futures_compared",
    "element_mappings",
    "steps",
    "risks",
    "data_contract_changes",
    "verification",
    "graph_updates",
    "ui_registry_updates",
  ],
  properties: {
    strategy_summary: { type: "string", minLength: 1 },
    futures_compared: {
      type: "array",
      minItems: 1,
      items: { type: "string", enum: UI_MIGRATION_FUTURES },
    },
    element_mappings: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: [
          "source_element_id",
          "action",
          "rationale",
          "registry_constraints",
          "data_contract_changes",
          "interaction_model_changes",
          "composition_constraints",
        ],
        properties: {
          source_element_id: { type: "string" },
          target_element_id: { type: "string" },
          proposed_new_element_id: { type: "string" },
          action: { type: "string", enum: UI_MIGRATION_FUTURES },
          rationale: { type: "string", minLength: 1 },
          registry_constraints: { type: "array", minItems: 1, items: { type: "string" } },
          data_contract_changes: { type: "array", minItems: 1, items: { type: "string" } },
          interaction_model_changes: { type: "array", minItems: 1, items: { type: "string" } },
          composition_constraints: { type: "array", minItems: 1, items: { type: "string" } },
        },
      },
    },
    steps: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: [
          "id",
          "title",
          "future",
          "element_ids",
          "summary",
          "risks",
          "verification",
          "graph_updates",
          "ui_registry_updates",
        ],
        properties: {
          id: { type: "string" },
          title: { type: "string" },
          future: { type: "string", enum: UI_MIGRATION_FUTURES },
          element_ids: { type: "array", items: { type: "string" } },
          summary: { type: "string", minLength: 1 },
          risks: { type: "array", items: { type: "string" } },
          verification: { type: "array", items: { type: "string" } },
          graph_updates: { type: "array", items: { type: "string" } },
          ui_registry_updates: { type: "array", items: { type: "string" } },
        },
      },
    },
    risks: { type: "array", items: { type: "string" } },
    data_contract_changes: { type: "array", items: { type: "string" } },
    verification: { type: "array", items: { type: "string" } },
    graph_updates: { type: "array", items: { type: "string" } },
    ui_registry_updates: { type: "array", items: { type: "string" } },
  },
};

function dataContractSummary(el: SemanticElement): string {
  const inputs = el.data_contract.inputs.map((i) => `${i.name}: ${i.type}`).join(", ") || "none";
  const outputs = el.data_contract.outputs.map((o) => `${o.name}: ${o.type}`).join(", ") || "none";
  const interactions = el.interactions.map((i) => i.action).join(", ") || "none";
  return `inputs: ${inputs}; outputs: ${outputs}; interactions: ${interactions}`;
}

function buildUIMigrationEvidence(
  params: GenerateUIMigrationParams,
  registry: UIRegistryFile,
): UIMigrationEvidence {
  const sourcePlatform = params.source_platform.toLowerCase();
  const targetPlatform = params.target_platform.toLowerCase();

  let sourceElements = registry.elements.filter(
    (e) =>
      effectiveStatus(e) !== "deprecated" &&
      e.implementations.some((i) => i.platform.toLowerCase() === sourcePlatform),
  );

  if (params.scope && params.scope.length > 0) {
    const scopeSet = new Set(params.scope.map((s) => s.toLowerCase()));
    sourceElements = sourceElements.filter((e) =>
      e.used_by.some((u) => scopeSet.has(u.toLowerCase())),
    );
  }

  const targetElements = registry.elements.filter(
    (e) =>
      effectiveStatus(e) !== "deprecated" &&
      e.implementations.some((i) => i.platform.toLowerCase() === targetPlatform),
  );
  const deprecatedElements = registry.elements.filter((e) => effectiveStatus(e) === "deprecated");
  const ported: MigrationPortedElement[] = [];
  const gaps: MigrationGapElement[] = [];

  for (const el of sourceElements) {
    const srcImpl = el.implementations.find(
      (i) => i.platform.toLowerCase() === sourcePlatform,
    );
    const tgtImpl = el.implementations.find(
      (i) => i.platform.toLowerCase() === targetPlatform,
    );

    if (srcImpl && tgtImpl) {
      ported.push({
        element_id: el.id,
        name: el.name,
        source_component: srcImpl.component,
        target_component: tgtImpl.component,
      });
    } else if (srcImpl) {
      gaps.push({
        element_id: el.id,
        name: el.name,
        purpose: el.purpose,
        category: el.category,
        source_component: srcImpl.component,
        data_contract_summary: dataContractSummary(el),
        complexity_estimate: estimateComplexity(el),
      });
    }
  }

  return {
    sourcePlatform,
    targetPlatform,
    sourceElements,
    targetElements,
    deprecatedElements,
    ported,
    gaps,
  };
}

function elementEvidence(el: SemanticElement): Record<string, unknown> {
  return {
    id: el.id,
    name: el.name,
    purpose: el.purpose,
    category: el.category,
    status: effectiveStatus(el),
    data_contract: el.data_contract,
    interactions: el.interactions,
    children: el.children ?? [],
    implementations: el.implementations.map((i) => ({
      platform: i.platform,
      component: i.component,
      source_file: i.source_file,
      notes: i.notes,
    })),
    visual_semantics: el.visual_semantics,
    layout_semantics: el.layout_semantics,
    used_by: el.used_by,
    tags: el.tags,
  };
}

function buildUIMigrationPrompt(evidence: UIMigrationEvidence): LlmMessage[] {
  const system = [
    "You draft advisory UI migration candidate plans for DreamGraph.",
    "The UI registry is authoritative: do not bypass element purpose, data contracts, interactions, composition children, visual semantics, layout semantics, lifecycle status, or deprecated replacements.",
    "Compare direct_port, refactor, split_component, defer, and redesign futures where applicable.",
    "Every existing element id must come from the supplied registry evidence. Any new element id must be placed in proposed_new_element_id before it appears in a step.",
    "Return strict JSON only, with no markdown or prose outside the JSON object.",
  ].join(" ");

  const userPayload = {
    source_platform: evidence.sourcePlatform,
    target_platform: evidence.targetPlatform,
    source_elements: evidence.sourceElements.map(elementEvidence),
    already_ported: evidence.ported,
    target_gaps: evidence.gaps,
    target_platform_capabilities: {
      categories: [...new Set(evidence.targetElements.map((e) => e.category))],
      components: evidence.targetElements.flatMap((e) =>
        e.implementations
          .filter((i) => i.platform.toLowerCase() === evidence.targetPlatform)
          .map((i) => ({ element_id: e.id, component: i.component })),
      ),
    },
    deprecated_elements: evidence.deprecatedElements.map((e) => ({
      id: e.id,
      name: e.name,
      superseded_by: e.superseded_by,
      deprecation_reason: e.deprecation_reason,
    })),
    required_output: {
      strategy_summary: "string",
      futures_compared: UI_MIGRATION_FUTURES,
      element_mappings: [
        {
          source_element_id: "existing source element id",
          target_element_id: "optional existing target element id",
          proposed_new_element_id: "optional explicit new element id",
          action: "direct_port|refactor|split_component|defer|redesign",
          rationale: "string",
          registry_constraints: ["registry purpose/data/interaction/layout constraints preserved"],
          data_contract_changes: ["contract-preserving or explicit change"],
          interaction_model_changes: ["interaction-preserving or explicit change"],
          composition_constraints: ["children/layout/composition constraints preserved"],
        },
      ],
      steps: [
        {
          id: "string",
          title: "string",
          future: "direct_port|refactor|split_component|defer|redesign",
          element_ids: ["existing element id or proposed_new_element_id"],
          summary: "string",
          risks: ["string"],
          verification: ["string"],
          graph_updates: ["string"],
          ui_registry_updates: ["string"],
        },
      ],
      risks: ["string"],
      data_contract_changes: ["string"],
      verification: ["string"],
      graph_updates: ["string"],
      ui_registry_updates: ["string"],
    },
  };

  return [
    { role: "system", content: system },
    { role: "user", content: JSON.stringify(userPayload, null, 2) },
  ];
}

function parseJsonPayload(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    const fenced = text.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
    if (fenced) return JSON.parse(fenced[1]);
    const objectMatch = text.match(/\{[\s\S]*\}/);
    if (!objectMatch) throw new Error("LLM did not return parseable JSON");
    return JSON.parse(objectMatch[0]);
  }
}

function readString(obj: Record<string, unknown>, key: string, errors: string[], path: string): string {
  const value = obj[key];
  if (typeof value !== "string" || value.trim().length === 0) {
    errors.push(`${path}.${key} must be a non-empty string`);
    return "";
  }
  return value.trim();
}

function readStringArray(obj: Record<string, unknown>, key: string, errors: string[], path: string): string[] {
  const value = obj[key];
  if (!Array.isArray(value)) {
    errors.push(`${path}.${key} must be an array`);
    return [];
  }
  const strings = value.filter((item): item is string => typeof item === "string" && item.trim().length > 0).map((item) => item.trim());
  if (strings.length !== value.length) errors.push(`${path}.${key} must contain only non-empty strings`);
  return strings;
}

function readFuture(obj: Record<string, unknown>, key: string, errors: string[], path: string): UIMigrationFutureKind {
  const value = readString(obj, key, errors, path);
  if (!UI_MIGRATION_FUTURE_SET.has(value)) {
    errors.push(`${path}.${key} must be one of ${UI_MIGRATION_FUTURES.join(", ")}`);
    return "defer";
  }
  return value as UIMigrationFutureKind;
}

function containsBypassLanguage(values: string[]): boolean {
  return values.some((value) => /\b(bypass|ignore|skip)\b.*\b(registry|contract|interaction|composition|constraint)\b/i.test(value));
}

function validateNonBypassConstraints(
  mapping: UIMigrationElementMapping,
  errors: string[],
  path: string,
): void {
  const constraintGroups: Array<[keyof UIMigrationElementMapping, string[]]> = [
    ["registry_constraints", mapping.registry_constraints],
    ["data_contract_changes", mapping.data_contract_changes],
    ["interaction_model_changes", mapping.interaction_model_changes],
    ["composition_constraints", mapping.composition_constraints],
  ];
  for (const [key, values] of constraintGroups) {
    if (values.length === 0) errors.push(`${path}.${key} must document preserved constraints or explicit changes`);
    if (containsBypassLanguage(values)) errors.push(`${path}.${key} attempts to bypass UI registry authority`);
  }
}

export function parseUIMigrationPlanningDraft(
  text: string,
  context: UIMigrationValidationContext,
): { plan: UIMigrationAdaptivePlan | null; errors: string[] } {
  const errors: string[] = [];
  let payload: unknown;
  try {
    payload = parseJsonPayload(text);
  } catch (err) {
    return { plan: null, errors: [err instanceof Error ? err.message : String(err)] };
  }

  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return { plan: null, errors: ["LLM response must be a JSON object"] };
  }

  const root = payload as Record<string, unknown>;
  const strategy_summary = readString(root, "strategy_summary", errors, "plan");
  const futures_compared = readStringArray(root, "futures_compared", errors, "plan").filter((future) => {
    if (UI_MIGRATION_FUTURE_SET.has(future)) return true;
    errors.push(`plan.futures_compared contains invalid future ${future}`);
    return false;
  }) as UIMigrationFutureKind[];

  const proposedElementIds = new Set<string>();
  const rawMappings = Array.isArray(root.element_mappings) ? root.element_mappings : [];
  if (!Array.isArray(root.element_mappings)) errors.push("plan.element_mappings must be an array");
  const element_mappings: UIMigrationElementMapping[] = [];

  rawMappings.forEach((entry, index) => {
    const path = `plan.element_mappings[${index}]`;
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      errors.push(`${path} must be an object`);
      return;
    }
    const obj = entry as Record<string, unknown>;
    const source_element_id = readString(obj, "source_element_id", errors, path);
    if (source_element_id && !context.sourceElementIds.has(source_element_id)) {
      errors.push(`${path}.source_element_id references unknown source element ${source_element_id}`);
    }
    const target_element_id = typeof obj.target_element_id === "string" && obj.target_element_id.trim().length > 0
      ? obj.target_element_id.trim()
      : undefined;
    const proposed_new_element_id = typeof obj.proposed_new_element_id === "string" && obj.proposed_new_element_id.trim().length > 0
      ? obj.proposed_new_element_id.trim()
      : undefined;
    if (target_element_id && !context.existingElementIds.has(target_element_id)) {
      errors.push(`${path}.target_element_id references unknown UI element ${target_element_id}`);
    }
    if (proposed_new_element_id) proposedElementIds.add(proposed_new_element_id);
    if (!target_element_id && !proposed_new_element_id) {
      errors.push(`${path} must set target_element_id or proposed_new_element_id`);
    }

    const mapping: UIMigrationElementMapping = {
      source_element_id,
      ...(target_element_id ? { target_element_id } : {}),
      ...(proposed_new_element_id ? { proposed_new_element_id } : {}),
      action: readFuture(obj, "action", errors, path),
      rationale: readString(obj, "rationale", errors, path),
      registry_constraints: readStringArray(obj, "registry_constraints", errors, path),
      data_contract_changes: readStringArray(obj, "data_contract_changes", errors, path),
      interaction_model_changes: readStringArray(obj, "interaction_model_changes", errors, path),
      composition_constraints: readStringArray(obj, "composition_constraints", errors, path),
    };
    validateNonBypassConstraints(mapping, errors, path);
    element_mappings.push(mapping);
  });

  const validPlanElementIds = new Set([...context.existingElementIds, ...proposedElementIds]);
  const rawSteps = Array.isArray(root.steps) ? root.steps : [];
  if (!Array.isArray(root.steps)) errors.push("plan.steps must be an array");
  const steps: UIMigrationPlanStep[] = [];

  rawSteps.forEach((entry, index) => {
    const path = `plan.steps[${index}]`;
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      errors.push(`${path} must be an object`);
      return;
    }
    const obj = entry as Record<string, unknown>;
    const element_ids = readStringArray(obj, "element_ids", errors, path);
    for (const id of element_ids) {
      if (!validPlanElementIds.has(id)) errors.push(`${path}.element_ids references unregistered element ${id}`);
    }
    steps.push({
      id: readString(obj, "id", errors, path),
      title: readString(obj, "title", errors, path),
      future: readFuture(obj, "future", errors, path),
      element_ids,
      summary: readString(obj, "summary", errors, path),
      risks: readStringArray(obj, "risks", errors, path),
      verification: readStringArray(obj, "verification", errors, path),
      graph_updates: readStringArray(obj, "graph_updates", errors, path),
      ui_registry_updates: readStringArray(obj, "ui_registry_updates", errors, path),
    });
  });

  const plan: UIMigrationAdaptivePlan = {
    strategy_summary,
    futures_compared,
    element_mappings,
    steps,
    risks: readStringArray(root, "risks", errors, "plan"),
    data_contract_changes: readStringArray(root, "data_contract_changes", errors, "plan"),
    verification: readStringArray(root, "verification", errors, "plan"),
    graph_updates: readStringArray(root, "graph_updates", errors, "plan"),
    ui_registry_updates: readStringArray(root, "ui_registry_updates", errors, "plan"),
  };

  if (plan.futures_compared.length === 0) errors.push("plan.futures_compared must include at least one future");
  if (containsBypassLanguage([plan.strategy_summary, ...plan.risks, ...plan.data_contract_changes, ...plan.verification, ...plan.graph_updates, ...plan.ui_registry_updates])) {
    errors.push("plan contains language that bypasses registry, data-contract, interaction, or composition constraints");
  }

  return errors.length > 0 ? { plan: null, errors } : { plan, errors: [] };
}

function planningMetadata(
  route: Awaited<ReturnType<typeof selectLlmRoute>>,
  llmCalls: number,
  tokensUsed: number,
  rejectedReasons: string[],
): UIMigrationPlanningMetadata {
  return {
    route_layer: route.layer,
    ...(route.provenance.provider ? { provider: route.provenance.provider } : {}),
    ...(route.model ? { model: route.model } : {}),
    ...(route.provenance.fallback_reason ? { fallback_reason: route.provenance.fallback_reason } : {}),
    llm_calls: llmCalls,
    tokens_used: tokensUsed,
    rejected_reasons: rejectedReasons,
  };
}

export async function generateUiMigrationPlanFromRegistry(
  params: GenerateUIMigrationParams,
  registry: UIRegistryFile,
): Promise<ToolResponse<GenerateUIMigrationOutput>> {
  const evidence = buildUIMigrationEvidence(params, registry);
  const route = await selectLlmRoute({
    task: "generic",
    daemon_component: "normalizer",
    daemon_temperature: 0.1,
    max_tokens: 2500,
  });
  const rejectedReasons: string[] = [];
  let adaptivePlan: UIMigrationAdaptivePlan | null = null;
  let llmCalls = 0;
  let tokensUsed = 0;

  if (evidence.gaps.length === 0) {
    rejectedReasons.push("No migration gaps were found; deterministic registry diff is sufficient.");
  } else if (route.layer === "deterministic_fallback" || !route.provider) {
    rejectedReasons.push(
      `ADR-203 route=${route.layer} reason=${route.provenance.fallback_reason ?? "provider_unavailable"}; using deterministic UI registry diff fallback.`,
    );
  } else {
    try {
      const response = await route.provider.complete(buildUIMigrationPrompt(evidence), {
        ...route.options,
        maxTokens: Math.min(route.options.maxTokens ?? 2500, 2500),
        jsonSchema: {
          name: "ui_migration_candidate_plan",
          schema: UI_MIGRATION_PLAN_JSON_SCHEMA,
        },
      });
      llmCalls++;
      tokensUsed += response.tokensUsed ?? 0;
      const parsed = parseUIMigrationPlanningDraft(response.text, {
        sourceElementIds: new Set(evidence.sourceElements.map((e) => e.id)),
        existingElementIds: new Set(registry.elements.map((e) => e.id)),
      });
      if (parsed.errors.length > 0 || !parsed.plan) {
        rejectedReasons.push(`Rejected invalid UI migration draft: ${parsed.errors.join("; ")}`);
      } else {
        adaptivePlan = parsed.plan;
      }
    } catch (err) {
      rejectedReasons.push(`LLM UI migration planning failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  return success({
    source_platform: params.source_platform,
    target_platform: params.target_platform,
    already_ported: evidence.ported,
    migration_needed: evidence.gaps,
    total_elements: evidence.sourceElements.length,
    ported_count: evidence.ported.length,
    gap_count: evidence.gaps.length,
    coverage_percent:
      evidence.sourceElements.length === 0
        ? 100
        : Math.round((evidence.ported.length / evidence.sourceElements.length) * 100),
    adaptive_plan: adaptivePlan,
    planning_metadata: planningMetadata(route, llmCalls, tokensUsed, rejectedReasons),
  });
}

const VALID_CATEGORIES = [
  "data_display",
  "data_input",
  "navigation",
  "feedback",
  "layout",
  "action",
  "composite",
] as const;

const categorySchema = z.string().describe(
  "Category of UI element. Must be one of: " + VALID_CATEGORIES.join(", ") + "."
);

const lifecycleStatusSchema = z
  .enum(["active", "transitional", "deprecated"])
  .optional()
  .describe("Lifecycle status. Omit for active to preserve backward compatibility.");

const visualSemanticsSchema = z
  .object({
    visual_role: z.string().optional().describe("Semantic visual role, e.g. shell, card, inspector, banner"),
    emphasis: z
      .enum(["primary", "secondary", "muted", "warning", "danger", "success", "info"])
      .optional()
      .describe("Abstract emphasis level"),
    density: z
      .enum(["compact", "comfortable", "spacious"])
      .optional()
      .describe("Abstract information density"),
    chrome: z
      .enum(["minimal", "embedded", "panel", "full_shell"])
      .optional()
      .describe("Abstract chrome/container level"),
    state_styling: z
      .array(
        z.object({
          state: z.string().describe("Named UI state"),
          treatment: z.string().describe("Abstract visual treatment for that state"),
        })
      )
      .optional()
      .describe("State-driven styling semantics without raw CSS/framework details"),
  })
  .optional();

const layoutSemanticsSchema = z
  .object({
    pattern: z
      .enum(["stack", "split_view", "grid", "table", "toolbar", "flow", "inspector", "shell", "dialog"])
      .optional()
      .describe("Abstract layout pattern"),
    alignment: z
      .enum(["leading", "centered", "distributed"])
      .optional()
      .describe("Primary alignment model"),
    sizing_behavior: z
      .enum(["fixed", "fluid", "content_sized", "fill_parent"])
      .optional()
      .describe("Sizing behavior abstraction"),
    responsive_behavior: z
      .array(z.enum(["wrap", "collapse", "scroll", "paginate", "promote_to_dialog"]))
      .optional()
      .describe("Responsive adaptation behaviors"),
    hierarchy: z
      .array(
        z.object({
          region: z.string().describe("Named visual/layout region"),
          role: z.enum(["primary", "secondary", "auxiliary"]).describe("Region hierarchy role"),
        })
      )
      .optional()
      .describe("Named layout hierarchy regions"),
  })
  .optional();

export function registerUIRegistryTools(server: McpServer): void {
  server.tool(
    "register_ui_element",
    "Register a semantic UI element with its purpose, data contract, interaction model, optional abstract visual/layout semantics, and optional lifecycle status for backward-compatible retirement. Platform-independent: describes what the element IS, not how it looks in CSS/framework props. If the element already exists, implementations are merged and other fields are updated.",
    {
      id: z
        .string()
        .describe(
          'Unique identifier, e.g. "data_table", "filter_bar", "entity_profile"'
        ),
      name: z.string().describe("Human-readable name"),
      purpose: z
        .string()
        .describe("The deep intent — what this element exists to do"),
      category: categorySchema,
      inputs: z
        .array(
          z.object({
            name: z.string(),
            type: z.string().describe('"array<T>", "object", "string", etc.'),
            description: z.string(),
            required: z.boolean(),
          })
        )
        .describe("What data this element consumes"),
      outputs: z
        .array(
          z.object({
            name: z.string(),
            type: z.string(),
            description: z.string(),
            trigger: z
              .string()
              .describe('"on_click", "on_change", "on_submit", etc.'),
          })
        )
        .describe("What data this element emits"),
      interactions: z
        .array(
          z.object({
            action: z
              .string()
              .describe('"sort", "filter", "select", "edit_inline", etc.'),
            description: z.string(),
          })
        )
        .describe("What the user can do with this element"),
      children: z
        .array(z.string())
        .optional()
        .describe("SemanticElement IDs of child elements"),
      implementations: z
        .array(
          z.object({
            platform: z
              .string()
              .describe('"react", "maui", "swiftui", "html", "flutter"'),
            component: z
              .string()
              .describe('"DataGrid", "UITableView", "<table>", etc.'),
            source_file: z.string().optional(),
            notes: z.string().optional(),
          })
        )
        .optional()
        .describe("Known platform implementations"),
      used_by: z
        .array(z.string())
        .optional()
        .describe("Feature IDs that use this element"),
      tags: z.array(z.string()).optional().describe("Tags for searchability"),
      status: lifecycleStatusSchema,
      superseded_by: z
        .string()
        .optional()
        .describe("Canonical replacement ID when this entry is transitional or deprecated"),
      deprecation_reason: z
        .string()
        .optional()
        .describe("Reason this entry is transitional/deprecated"),
      state: z
        .record(z.string(), z.enum(["boolean", "string", "number"]))
        .optional()
        .describe(
          'Observable state flags, e.g. { "is_generating": "boolean", "has_image": "boolean" }'
        ),
      flows: z
        .array(z.string())
        .optional()
        .describe(
          'Ordered workflow flows, e.g. ["prompt → generate → display → edit → save"]'
        ),
      error_states: z
        .array(
          z.object({
            condition: z.string().describe("When this error occurs"),
            behavior: z.string().describe("How the element responds"),
            severity: z
              .enum(["info", "warning", "error", "fatal"])
              .optional()
              .describe("Severity level"),
          })
        )
        .optional()
        .describe("Known error/edge-case states"),
      rendering_capabilities: z
        .array(z.string())
        .optional()
        .describe(
          'Capability-based abstraction, e.g. ["touch", "mouse", "keyboard", "voice"]'
        ),
      visual_semantics: visualSemanticsSchema.describe(
        "Abstract visual semantics: role, emphasis, density, chrome, and state styling semantics"
      ),
      layout_semantics: layoutSemanticsSchema.describe(
        "Abstract layout semantics: pattern, alignment, sizing, responsive behavior, and hierarchy"
      ),
      is_async: z
        .boolean()
        .optional()
        .describe("Whether the element involves async operations"),
      default_action: z
        .string()
        .optional()
        .describe("Default/primary action when invoked without specifics"),
      visibility_conditions: z
        .array(z.string())
        .optional()
        .describe(
          'Conditions controlling visibility, e.g. ["has_api_key", "has_image"]'
        ),

      // Slice 1 — first-class graph citizenship (optional, additive).
      source_repo: z
        .string()
        .optional()
        .describe(
          "Owning repo id. REQUIRED for the element to be admitted into index.json (canonical graph). Manual registry entries without source_repo remain in the UI registry but are NOT graph citizens.",
        ),
      source_file: z
        .string()
        .optional()
        .describe("Primary source-of-truth file path, when one exists."),
      source_kind: z
        .enum(["scanner", "manual", "sdk", "user_guidance", "generated"])
        .optional()
        .describe(
          'How this element entered the registry. "scanner" entries are eligible for autonomous enrichment by enrich_parser_nodes (target: "ui").',
        ),
      evidence_refs: z
        .array(z.string())
        .optional()
        .describe("File/symbol references that ground this element in real code."),
      intent: z
        .string()
        .optional()
        .describe("Human-readable purpose: why this element exists / what problem it solves. Normally written by enrich_parser_nodes; accept explicit overrides."),
      description_raw: z
        .string()
        .optional()
        .describe("Preserved original purpose/description text from before enrichment overwrote it."),
      links: z
        .array(
          z.object({
            target: z.string(),
            type: z.enum(["feature", "workflow", "data_model", "capability", "datastore", "ui_element"]),
            relationship: z.string(),
            description: z.string(),
            strength: z.string(),
            meta: z.record(z.string(), z.unknown()).optional(),
          }),
        )
        .optional()
        .describe("Cross-entity links (feature anchors, etc.)."),
    },
    async (params) => {
      logger.debug(`register_ui_element called: "${params.id}"`);

      const result = await safeExecute<RegisterUIElementOutput>(
        async (): Promise<ToolResponse<RegisterUIElementOutput>> =>
          withFileLock("ui_registry.json", async () => {
            const registry = await loadRegistry();
            const existing = registry.elements.find((e) => e.id === params.id);
            let merged = false;

            if (existing) {
              existing.name = params.name;
              existing.purpose = params.purpose;
              existing.category = params.category as SemanticElementCategory;
              existing.data_contract = {
                inputs: params.inputs,
                outputs: params.outputs,
              };
              existing.interactions = params.interactions;
              if (params.children !== undefined) existing.children = params.children;
              existing.tags = params.tags ?? existing.tags;

              if (params.status !== undefined) existing.status = params.status;
              if (params.superseded_by !== undefined) existing.superseded_by = params.superseded_by;
              if (params.deprecation_reason !== undefined) existing.deprecation_reason = params.deprecation_reason;

              if (params.state !== undefined) existing.state = params.state;
              if (params.flows !== undefined) existing.flows = params.flows;
              if (params.error_states !== undefined)
                existing.error_states = params.error_states;
              if (params.rendering_capabilities !== undefined)
                existing.rendering_capabilities = params.rendering_capabilities;
              if (params.visual_semantics !== undefined)
                existing.visual_semantics = params.visual_semantics;
              if (params.layout_semantics !== undefined)
                existing.layout_semantics = params.layout_semantics;

              if (params.is_async !== undefined) existing.is_async = params.is_async;
              if (params.default_action !== undefined)
                existing.default_action = params.default_action;
              if (params.visibility_conditions !== undefined)
                existing.visibility_conditions = params.visibility_conditions;

              // Slice 1 — first-class graph citizenship.
              if (params.source_repo !== undefined) existing.source_repo = params.source_repo;
              if (params.source_file !== undefined) existing.source_file = params.source_file;
              if (params.source_kind !== undefined) existing.source_kind = params.source_kind;
              if (params.evidence_refs !== undefined) existing.evidence_refs = params.evidence_refs;
              if (params.intent !== undefined) existing.intent = params.intent;
              if (params.description_raw !== undefined) existing.description_raw = params.description_raw;
              if (params.links !== undefined) existing.links = params.links;

              const newImpls = params.implementations ?? [];
              for (const impl of newImpls) {
                const idx = existing.implementations.findIndex(
                  (i) => i.platform === impl.platform
                );
                if (idx >= 0) {
                  existing.implementations[idx] = impl;
                } else {
                  existing.implementations.push(impl);
                }
              }

              const usedBySet = new Set([
                ...existing.used_by,
                ...(params.used_by ?? []),
              ]);
              existing.used_by = [...usedBySet];

              merged = true;
            } else {
              const element: SemanticElement = {
                id: params.id,
                name: params.name,
                purpose: params.purpose,
                category: params.category as SemanticElementCategory,
                data_contract: {
                  inputs: params.inputs,
                  outputs: params.outputs,
                },
                interactions: params.interactions,
                children: params.children,
                implementations: params.implementations ?? [],
                used_by: params.used_by ?? [],
                tags: params.tags ?? [],
                ...(params.status !== undefined && { status: params.status }),
                ...(params.superseded_by !== undefined && {
                  superseded_by: params.superseded_by,
                }),
                ...(params.deprecation_reason !== undefined && {
                  deprecation_reason: params.deprecation_reason,
                }),
                ...(params.state !== undefined && { state: params.state }),
                ...(params.flows !== undefined && { flows: params.flows }),
                ...(params.error_states !== undefined && {
                  error_states: params.error_states,
                }),
                ...(params.rendering_capabilities !== undefined && {
                  rendering_capabilities: params.rendering_capabilities,
                }),
                ...(params.visual_semantics !== undefined && {
                  visual_semantics: params.visual_semantics,
                }),
                ...(params.layout_semantics !== undefined && {
                  layout_semantics: params.layout_semantics,
                }),
                ...(params.is_async !== undefined && { is_async: params.is_async }),
                ...(params.default_action !== undefined && {
                  default_action: params.default_action,
                }),
                ...(params.visibility_conditions !== undefined && {
                  visibility_conditions: params.visibility_conditions,
                }),
                // Slice 1 — first-class graph citizenship.
                ...(params.source_repo !== undefined && { source_repo: params.source_repo }),
                ...(params.source_file !== undefined && { source_file: params.source_file }),
                ...(params.source_kind !== undefined && { source_kind: params.source_kind }),
                ...(params.evidence_refs !== undefined && { evidence_refs: params.evidence_refs }),
                ...(params.intent !== undefined && { intent: params.intent }),
                ...(params.description_raw !== undefined && { description_raw: params.description_raw }),
                ...(params.links !== undefined && { links: params.links }),
              };
              registry.elements.push(element);
            }

            await saveRegistry(registry);

            return success({
              element_id: params.id,
              name: params.name,
              category: params.category,
              inputs_count: params.inputs.length,
              outputs_count: params.outputs.length,
              merged,
              message: merged
                ? `Updated existing semantic element "${params.id}". Implementations merged.`
                : `Registered new semantic element "${params.id}" (${params.category}).`,
            });
          })
      );

      return {
        content: [
          { type: "text" as const, text: JSON.stringify(result, null, 2) },
        ],
      };
    }
  );

  server.tool(
    "query_ui_elements",
    "Search the semantic UI registry by category, purpose, platform, or feature. Returns elements with their full data contracts. Use missing_platform to find elements that need porting to a target platform.",
    {
      category: categorySchema
        .optional()
        .describe("Filter by element category. Must be one of: " + VALID_CATEGORIES.join(", ") + "."),
      purpose_search: z
        .string()
        .optional()
        .describe("Search purpose text"),
      platform: z
        .string()
        .optional()
        .describe("Return elements implemented for this platform"),
      feature_id: z
        .string()
        .optional()
        .describe("Return elements used by this feature"),
      missing_platform: z
        .string()
        .optional()
        .describe(
          "Return elements that do NOT have an implementation for this platform — instant migration checklist"
        ),
      status: z
        .enum(["active", "transitional", "deprecated"])
        .optional()
        .describe("Filter by lifecycle status. Omitted means all statuses."),
      exclude_deprecated: z
        .boolean()
        .optional()
        .describe("When true, hide deprecated entries from results."),
    },
    async (params) => {
      logger.debug("query_ui_elements called");

      const result = await safeExecute<QueryUIElementsOutput>(
        async (): Promise<ToolResponse<QueryUIElementsOutput>> => {
          const registry = await loadRegistry();
          let filtered = [...registry.elements];

          if (params.category) {
            filtered = filtered.filter((e) => e.category === params.category);
          }

          if (params.purpose_search) {
            const q = params.purpose_search.toLowerCase();
            filtered = filtered.filter((e) =>
              e.purpose.toLowerCase().includes(q)
            );
          }

          if (params.platform) {
            const p = params.platform.toLowerCase();
            filtered = filtered.filter((e) =>
              e.implementations.some((i) => i.platform.toLowerCase() === p)
            );
          }

          if (params.feature_id) {
            const fid = params.feature_id.toLowerCase();
            filtered = filtered.filter((e) =>
              e.used_by.some((u) => u.toLowerCase() === fid)
            );
          }

          if (params.missing_platform) {
            const mp = params.missing_platform.toLowerCase();
            filtered = filtered.filter(
              (e) =>
                !e.implementations.some(
                  (i) => i.platform.toLowerCase() === mp
                )
            );
          }

          if (params.status) {
            filtered = filtered.filter((e) => effectiveStatus(e) === params.status);
          }

          if (params.exclude_deprecated === true) {
            filtered = filtered.filter((e) => effectiveStatus(e) !== "deprecated");
          }

          const categories: Record<string, number> = {};
          const platforms: Record<string, number> = {};
          for (const el of filtered) {
            categories[el.category] = (categories[el.category] ?? 0) + 1;
            for (const impl of el.implementations) {
              platforms[impl.platform] =
                (platforms[impl.platform] ?? 0) + 1;
            }
          }

          return success({
            elements: filtered,
            total: filtered.length,
            categories,
            platforms,
          });
        }
      );

      return {
        content: [
          { type: "text" as const, text: JSON.stringify(result, null, 2) },
        ],
      };
    }
  );

  server.tool(
    "generate_ui_migration_plan",
    "Generate a platform migration plan. Lists all semantic elements from the source platform, checks which already exist on the target platform, and produces a gap analysis with data contract summaries and complexity estimates. Deprecated entries are excluded by default.",
    {
      source_platform: z
        .string()
        .describe('Source platform, e.g. "react"'),
      target_platform: z
        .string()
        .describe('Target platform, e.g. "swiftui"'),
      scope: z
        .array(z.string())
        .optional()
        .describe("Optional: limit to these feature IDs"),
    },
    async (params) => {
      logger.debug(
        `generate_ui_migration_plan: ${params.source_platform} → ${params.target_platform}`
      );

      const result = await safeExecute<GenerateUIMigrationOutput>(
        async (): Promise<ToolResponse<GenerateUIMigrationOutput>> => {
          const registry = await loadRegistry();
          return generateUiMigrationPlanFromRegistry(
            {
              source_platform: params.source_platform,
              target_platform: params.target_platform,
              scope: params.scope,
            },
            registry,
          );
        }
      );

      return {
        content: [
          { type: "text" as const, text: JSON.stringify(result, null, 2) },
        ],
      };
    }
  );
}
