import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { compileTaskPreamble, getCognitivePreamble } from "../src/cognitive/graph-rag.js";
import { initLlmProvider } from "../src/cognitive/llm.js";
import type { TaskPreambleEvidenceItem } from "../src/cognitive/types.js";
import { invalidateCache, setDataDirResolver } from "../src/utils/cache.js";
import { getDataDir, setDataDirOverride } from "../src/utils/paths.js";

const remediationEvidence: TaskPreambleEvidenceItem = {
  anchor: "feature_adaptive_future_engine",
  kind: "graph_entity",
  summary: "Adaptive Future Engine remediation planning must preserve deterministic fallback behavior.",
  confidence: 0.9,
  priority: 0.9,
};

const noProviderConfig = {
  provider: "none" as const,
  model: "",
  baseUrl: "",
  apiKey: "",
  temperature: 0.7,
  maxTokens: 2048,
  timeoutMs: 120_000,
};

let tempDir = "";
let previousDataDir = getDataDir();

async function writeJsonFile(name: string, data: unknown): Promise<void> {
  await writeFile(join(tempDir, name), JSON.stringify(data, null, 2), "utf-8");
}

type GraphSeed = {
  features?: unknown[];
  workflows?: unknown[];
  dataModel?: unknown[];
  validatedEdges?: unknown[];
  tensions?: unknown[];
  storyChapters?: unknown[];
  overview?: Record<string, unknown> | null;
};

async function seedKnowledgeGraph(seed: GraphSeed = {}): Promise<void> {
  await mkdir(tempDir, { recursive: true });
  await writeJsonFile("features.json", seed.features ?? []);
  await writeJsonFile("workflows.json", seed.workflows ?? []);
  await writeJsonFile("data_model.json", seed.dataModel ?? []);
  await writeJsonFile("validated_edges.json", {
    edges: seed.validatedEdges ?? [],
    metadata: { total_validated: (seed.validatedEdges ?? []).length },
  });
  await writeJsonFile("tension_log.json", { signals: seed.tensions ?? [] });
  await writeJsonFile("system_story.json", { chapters: seed.storyChapters ?? [] });
  if (seed.overview) {
    await writeJsonFile("system_overview.json", seed.overview);
  }
  invalidateCache();
}

beforeEach(async () => {
  previousDataDir = getDataDir();
  tempDir = await mkdtemp(join(tmpdir(), "dg-task-preamble-"));
  setDataDirOverride(tempDir);
  setDataDirResolver(() => tempDir);
  invalidateCache();
  await seedKnowledgeGraph();
  initLlmProvider(noProviderConfig);
});

afterEach(async () => {
  initLlmProvider(noProviderConfig);
  setDataDirOverride(previousDataDir);
  setDataDirResolver(() => previousDataDir);
  invalidateCache();
  if (tempDir) {
    await rm(tempDir, { recursive: true, force: true });
    tempDir = "";
  }
});

describe("compileTaskPreamble", () => {
  it("does not fail or add prompt context when no provider and no evidence are available", async () => {
    initLlmProvider(noProviderConfig);

    const result = await compileTaskPreamble({
      task: "repair unrelated formatting",
      evidence: [],
    });

    expect(result).toMatchObject({
      preamble_text: "",
      evidence_anchors: [],
      token_count: 0,
      budget_decision: "omit_no_evidence",
      selected_model_layer: "deterministic_fallback",
      selected_model_provider: null,
      selected_model: null,
      fallback_reason: "no_connected_model",
    });
    expect(result.omitted_context_reasons).toContain("no bounded evidence assembled");
  });

  it("includes bounded relevant evidence when the prompt cost is economical", async () => {
    const result = await compileTaskPreamble({
      task: "implement remediation fallback for adaptive future engine",
      evidence: [remediationEvidence],
      max_tokens: 120,
      min_expected_savings_tokens: 80,
    });

    expect(result.budget_decision).toBe("include");
    expect(result.evidence_anchors).toEqual(["feature_adaptive_future_engine"]);
    expect(result.preamble_text).toContain("DreamGraph task preamble:");
    expect(result.preamble_text).toContain("deterministic fallback behavior");
    expect(result.selected_model_layer).toBe("deterministic_fallback");
  });

  it("omits valid evidence when it is relevant but not economical", async () => {
    const result = await compileTaskPreamble({
      task: "implement remediation fallback for adaptive future engine",
      evidence: [remediationEvidence],
      max_tokens: 120,
      min_expected_savings_tokens: 1,
    });

    expect(result.budget_decision).toBe("omit_not_economical");
    expect(result.preamble_text).toBe("");
    expect(result.omitted_context_reasons).toContain(
      "compiled context cost exceeded expected avoided scanning or cognition cost",
    );
  });

  it("rejects invented or malformed evidence anchors before adding context", async () => {
    const result = await compileTaskPreamble({
      task: "implement remediation fallback",
      evidence: [
        {
          ...remediationEvidence,
          anchor: "not a valid anchor with spaces",
        },
      ],
    });

    expect(result.budget_decision).toBe("omit_validation_failed");
    expect(result.preamble_text).toBe("");
    expect(result.validation_failures).toEqual(["invalid_anchor:not a valid anchor with spaces"]);
  });

  it("omits evidence that cannot fit the configured prompt budget", async () => {
    const result = await compileTaskPreamble({
      task: "implement remediation fallback for adaptive future engine",
      evidence: [remediationEvidence],
      max_tokens: 4,
      min_expected_savings_tokens: 80,
    });

    expect(result.budget_decision).toBe("omit_over_budget");
    expect(result.preamble_text).toBe("");
    expect(result.omitted_context_reasons).toContain("bounded evidence exceeded prompt budget");
  });
});

describe("getCognitivePreamble adaptive_future", () => {
  it("omits advisory next steps when no bounded preamble evidence qualifies", async () => {
    const result = await getCognitivePreamble(120);

    expect(result.adaptive_future).toMatchObject({
      surface: "get_cognitive_preamble",
      next_steps: [],
      future_objections: [],
      validation_failures: [],
    });
    expect(result.adaptive_future?.omitted_context_reasons).toContain(
      "no bounded preamble evidence qualified for adaptive future ranking",
    );
  });

  it("rejects invalid anchors before ranking adaptive future preamble evidence", async () => {
    await seedKnowledgeGraph({
      tensions: [
        {
          id: "invalid anchor",
          domain: "core",
          description: "Anchor contains spaces and must be rejected.",
          urgency: 0.92,
          resolved: false,
          entities: [],
        },
      ],
    });

    const result = await getCognitivePreamble(160);

    expect(result.adaptive_future?.next_steps).toEqual([]);
    expect(result.adaptive_future?.validation_failures).toEqual([
      "invalid_anchor:invalid anchor",
    ]);
    expect(result.adaptive_future?.omitted_context_reasons).toContain(
      "future-fit evidence failed anchor or summary validation",
    );
  });

  it("records budget-trim provenance when lower-priority preamble context is omitted", async () => {
    await seedKnowledgeGraph({
      tensions: [
        {
          id: "tension_budget_trim",
          domain: "core",
          description: "A bounded open question with enough urgency to rank.",
          urgency: 0.7,
          resolved: false,
          entities: ["feature_adaptive_future_engine"],
        },
      ],
      storyChapters: [
        {
          id: "chapter_1",
          title: "Architecture drift",
          key_discoveries: [
            "A long-form discovery sentence that helps push the preamble over the token budget.",
            "Another detailed observation about adaptive future evidence selection.",
          ],
        },
        {
          id: "chapter_2",
          title: "Operational follow-through",
          key_discoveries: [
            "Additional bounded context that should be trimmed from the visible preamble output.",
          ],
        },
      ],
      overview: {
        id: "dreamgraph",
        name: "DreamGraph",
        description: "A deliberately verbose overview used to force preamble trimming under a tiny test budget while keeping the adaptive future sidecar populated.",
      },
    });

    const result = await getCognitivePreamble(20);

    expect(result.adaptive_future?.next_steps).toEqual([
      expect.objectContaining({
        id: "preamble-tension_budget_trim",
        evidence_anchor_ids: ["tension_budget_trim"],
      }),
    ]);
    expect(result.adaptive_future?.future_objections).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "preamble-budget-trim",
          severity: "medium",
          evidence_anchor_ids: ["tension_budget_trim"],
        }),
      ]),
    );
  });
});
