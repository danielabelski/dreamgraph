import { describe, it, expect, beforeEach, vi } from "vitest";

import type { SemanticElement, UIRegistryFile } from "../../src/types/index.js";

interface MockLlmState {
  available: boolean;
  responses: string[];
  calls: Array<{ messages: unknown; options: unknown }>;
}

const mockState: MockLlmState = {
  available: true,
  responses: [],
  calls: [],
};

vi.mock("../../src/cognitive/llm.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/cognitive/llm.js")>();
  const provider = {
    name: "mock",
    isAvailable: async () => mockState.available,
    complete: async (messages: unknown, options: unknown) => {
      const idx = mockState.calls.length;
      mockState.calls.push({ messages, options });
      const text = mockState.responses[idx];
      if (!text) throw new Error(`mock LLM: no response queued for call #${idx}`);
      return { text, model: "mock-model", tokensUsed: 17 };
    },
  };
  return {
    ...actual,
    selectLlmRoute: async () => mockState.available
      ? {
          layer: "daemon",
          provider,
          model: "mock-model",
          options: { model: "mock-model", temperature: 0.1, maxTokens: 2500 },
          provenance: { task: "generic", layer: "daemon", provider: "mock", model: "mock-model", source: "daemon", temperature: 0.1 },
        }
      : {
          layer: "deterministic_fallback",
          provider: null,
          model: null,
          options: {},
          provenance: { task: "generic", layer: "deterministic_fallback", provider: null, model: null, source: "deterministic_fallback", fallback_reason: "daemon_model_unavailable" },
        },
  };
});

import {
  generateUiMigrationPlanFromRegistry,
  parseUIMigrationPlanningDraft,
} from "../../src/tools/ui-registry.js";

function element(overrides: Partial<SemanticElement> = {}): SemanticElement {
  return {
    id: overrides.id ?? "react-card",
    name: overrides.name ?? "React Card",
    purpose: overrides.purpose ?? "Shows a selectable summary card.",
    category: overrides.category ?? "data_display",
    data_contract: overrides.data_contract ?? {
      inputs: [{ name: "title", type: "string", description: "Visible title", required: true }],
      outputs: [{ name: "selected", type: "string", description: "Selected id", trigger: "select" }],
    },
    interactions: overrides.interactions ?? [{ action: "select", description: "Select the card" }],
    children: overrides.children ?? ["summary-row"],
    implementations: overrides.implementations ?? [
      { platform: "react", component: "SummaryCard", source_file: "src/SummaryCard.tsx" },
    ],
    used_by: overrides.used_by ?? ["feature-dashboard"],
    tags: overrides.tags ?? ["summary"],
    visual_semantics: overrides.visual_semantics ?? { visual_role: "card", density: "compact" },
    layout_semantics: overrides.layout_semantics ?? { pattern: "stack", responsive_behavior: ["wrap"] },
    ...overrides,
  };
}

function registry(elements: SemanticElement[]): UIRegistryFile {
  return {
    metadata: {
      schema_version: "1.2.0",
      last_updated: "2026-05-25T00:00:00.000Z",
      total_elements: elements.length,
      total_categories: new Set(elements.map((e) => e.category)).size,
    },
    elements,
  } as UIRegistryFile;
}

function validPlan(): string {
  return JSON.stringify({
    strategy_summary: "Refactor the React card into a SwiftUI-native card while preserving registry semantics.",
    futures_compared: ["direct_port", "refactor", "split_component", "defer", "redesign"],
    element_mappings: [
      {
        source_element_id: "react-card",
        proposed_new_element_id: "swiftui-card",
        action: "refactor",
        rationale: "SwiftUI should keep the card purpose while using native composition.",
        registry_constraints: ["Preserve the existing purpose, category, visual role, and layout semantics."],
        data_contract_changes: ["Keep the title input and selected output unchanged."],
        interaction_model_changes: ["Keep the select interaction as the primary action."],
        composition_constraints: ["Preserve the summary-row child relationship in the target composition."],
      },
    ],
    steps: [
      {
        id: "step-1",
        title: "Create SwiftUI card element",
        future: "refactor",
        element_ids: ["swiftui-card"],
        summary: "Register a SwiftUI-native card mapped to the React source element.",
        risks: ["Native layout may not match existing compact density."],
        verification: ["Run UI registry migration plan tests."],
        graph_updates: ["Record the planned UI migration candidate as advisory evidence."],
        ui_registry_updates: ["Register swiftui-card only after implementation exists."],
      },
    ],
    risks: ["Target platform interaction affordances may differ."],
    data_contract_changes: ["No data contract change is planned."],
    verification: ["Validate data-contract mapping and registry constraints."],
    graph_updates: ["No graph mutation until a migration is accepted."],
    ui_registry_updates: ["Proposed element must be registered before use."],
  });
}

beforeEach(() => {
  mockState.available = true;
  mockState.responses = [];
  mockState.calls = [];
});

describe("parseUIMigrationPlanningDraft", () => {
  it("accepts a registry-compliant plan with an explicitly proposed new element", () => {
    const parsed = parseUIMigrationPlanningDraft(validPlan(), {
      sourceElementIds: new Set(["react-card"]),
      existingElementIds: new Set(["react-card"]),
    });

    expect(parsed.errors).toEqual([]);
    expect(parsed.plan?.element_mappings[0].proposed_new_element_id).toBe("swiftui-card");
    expect(parsed.plan?.steps[0].element_ids).toEqual(["swiftui-card"]);
  });

  it("rejects generated element ids that are neither existing nor proposed", () => {
    const payload = JSON.parse(validPlan());
    payload.steps[0].element_ids = ["unregistered-swiftui-card"];

    const parsed = parseUIMigrationPlanningDraft(JSON.stringify(payload), {
      sourceElementIds: new Set(["react-card"]),
      existingElementIds: new Set(["react-card"]),
    });

    expect(parsed.plan).toBeNull();
    expect(parsed.errors.join("\n")).toContain("unregistered element unregistered-swiftui-card");
  });

  it("rejects plans that bypass UI registry constraints", () => {
    const payload = JSON.parse(validPlan());
    payload.element_mappings[0].registry_constraints = ["Ignore registry constraints and port visually."];

    const parsed = parseUIMigrationPlanningDraft(JSON.stringify(payload), {
      sourceElementIds: new Set(["react-card"]),
      existingElementIds: new Set(["react-card"]),
    });

    expect(parsed.plan).toBeNull();
    expect(parsed.errors.join("\n")).toContain("bypass UI registry authority");
  });
});

describe("generateUiMigrationPlanFromRegistry", () => {
  it("keeps the deterministic registry diff as fallback when the provider is unavailable", async () => {
    mockState.available = false;
    const result = await generateUiMigrationPlanFromRegistry(
      { source_platform: "react", target_platform: "swiftui" },
      registry([element()]),
    );

    expect(result.success).toBe(true);
    if (!result.success) throw new Error("expected success");
    expect(result.data.migration_needed).toHaveLength(1);
    expect(result.data.adaptive_plan).toBeNull();
    expect(result.data.planning_metadata?.route_layer).toBe("deterministic_fallback");
    expect(result.data.planning_metadata?.llm_calls).toBe(0);
  });

  it("adds a validated advisory plan when strict LLM output is registry-compliant", async () => {
    mockState.responses = [validPlan()];
    const result = await generateUiMigrationPlanFromRegistry(
      { source_platform: "react", target_platform: "swiftui" },
      registry([element()]),
    );

    expect(result.success).toBe(true);
    if (!result.success) throw new Error("expected success");
    expect(result.data.migration_needed[0].data_contract_summary).toContain("title: string");
    expect(result.data.adaptive_plan?.futures_compared).toContain("redesign");
    expect(result.data.planning_metadata?.llm_calls).toBe(1);
    expect(result.data.planning_metadata?.tokens_used).toBe(17);
    expect(mockState.calls[0].options).toMatchObject({
      jsonSchema: { name: "ui_migration_candidate_plan" },
    });
  });

  it("rejects invalid LLM plans and returns the deterministic diff", async () => {
    const payload = JSON.parse(validPlan());
    payload.element_mappings[0].source_element_id = "missing-source";
    mockState.responses = [JSON.stringify(payload)];

    const result = await generateUiMigrationPlanFromRegistry(
      { source_platform: "react", target_platform: "swiftui" },
      registry([element()]),
    );

    expect(result.success).toBe(true);
    if (!result.success) throw new Error("expected success");
    expect(result.data.adaptive_plan).toBeNull();
    expect(result.data.migration_needed).toHaveLength(1);
    expect(result.data.planning_metadata?.rejected_reasons.join("\n")).toContain("unknown source element missing-source");
  });
});
