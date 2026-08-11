/**
 * Tests for `enrich_parser_nodes` — autonomous batch enrichment for
 * parser-discovered nodes.
 *
 * Coverage strategy:
 *   - Pure helpers (filter / merge / parse / bucket) are unit-tested
 *     directly against `ParserNodeRecord` fixtures.
 *   - The integration path is exercised end-to-end with a temp data dir
 *     (`setDataDirOverride`) and a mocked LLM provider injected via
 *     `vi.mock` on the cognitive/llm module. This validates batching,
 *     per-batch persistence, anchor filtering, and the LLM-unavailable
 *     short-circuit without touching any real provider.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { writeFile, readFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { setDataDirOverride } from "../../src/utils/paths.js";
import { invalidateCache, setDataDirResolver } from "../../src/utils/cache.js";
import { config } from "../../src/config/config.js";

// --- LLM mock ---------------------------------------------------------------
// Injected per-test via `setMockLlm`. Captures every call so assertions can
// inspect prompts, models, and batch boundaries.

interface MockLlmState {
  available: boolean;
  responses: Array<string | { text: string; model?: string; tokensUsed?: number }>;
  throwAfter?: number;
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
      if (mockState.throwAfter !== undefined && idx >= mockState.throwAfter) {
        throw new Error("simulated LLM failure");
      }
      const r = mockState.responses[idx];
      if (!r) throw new Error(`mock LLM: no response queued for call #${idx}`);
      const resp = typeof r === "string" ? { text: r } : r;
      return { text: resp.text, model: resp.model ?? "mock-model", tokensUsed: resp.tokensUsed ?? 0 };
    },
  };
  return {
    ...actual,
    isLlmAvailable: async () => mockState.available,
    getLlmProvider: () => provider,
    selectLlmRoute: async () => mockState.available
      ? {
          layer: "daemon",
          provider,
          model: "mock-model",
          options: { model: "mock-model", temperature: 0.2, maxTokens: 4096 },
          provenance: { task: "graph_enrichment", layer: "daemon", provider: "mock", model: "mock-model", source: "daemon", temperature: 0.2 },
        }
      : {
          layer: "deterministic_fallback",
          provider: null,
          model: null,
          options: {},
          provenance: { task: "graph_enrichment", layer: "deterministic_fallback", provider: null, model: null, source: "deterministic_fallback", fallback_reason: "daemon_model_unavailable" },
        },
    getDreamerLlmConfig: () => ({ model: "mock-model", temperature: 0.3, maxTokens: 4096 }),
  };
});

// Import the SUT AFTER vi.mock so the mock binds.
import {
  enrichParserNodesProgrammatic,
  parseLlmEnrichment,
  mergeEnrichment,
  isParserOrigin,
  isAlreadyEnriched,
  bucketKey,
  chunk,
  buildMultiHopContext,
  buildSemanticCachePlan,
  type ParserNodeRecord,
  type PerNodeEnrichment,
} from "../../src/tools/enrich-parser-nodes.js";

// --- Fixtures ---------------------------------------------------------------

function parserNode(over: Partial<ParserNodeRecord> = {}): ParserNodeRecord {
  return {
    id: over.id ?? "openrct2_c_struct_ride",
    name: over.name ?? "Ride",
    description: over.description ?? "struct `Ride` declared in src/ride.c (line 1).",
    source_repo: over.source_repo ?? "openrct2",
    source_files: over.source_files ?? ["src/ride.c"],
    domain: over.domain ?? "core",
    keywords: over.keywords ?? ["ride", "c", "struct"],
    tags: over.tags ?? [],
    status: over.status ?? "active",
    model_kind: over.model_kind ?? "c:struct",
    key_fields: over.key_fields ?? [{ name: "id", type: "int" }],
    relationships: over.relationships ?? [],
    links: over.links ?? [],
    provenance: over.provenance ?? {
      scanner: "native",
      language: "c",
      qualified_name: "Ride",
    },
    ...over,
  };
}

function feature(over: Partial<ParserNodeRecord> = {}): ParserNodeRecord {
  return {
    id: over.id ?? "openrct2_ride_management",
    name: over.name ?? "Ride Management",
    description: over.description ?? "Manage rides in the park.",
    source_repo: over.source_repo ?? "openrct2",
    source_files: over.source_files ?? ["src/ride.c"],
    domain: over.domain ?? "core",
    tags: over.tags ?? ["rides"],
    status: over.status ?? "active",
    ...over,
  };
}

function llmResponseFor(nodes: ParserNodeRecord[], opts: Partial<PerNodeEnrichment> = {}): string {
  return JSON.stringify({
    results: nodes.map((n) => ({
      id: n.id,
      description: opts.description ?? `${n.name} represents an evidenced project concept and exists to coordinate its domain responsibility. It operates through the supplied source structure and participates in the named neighboring graph flows rather than standing as a file inventory.`,
      intent: opts.intent ?? `Represent the ${n.name} design responsibility and its evidenced contribution to the surrounding system flow.`,
      purpose: opts.purpose ?? "domain-entity",
      tags: opts.tags ?? ["enriched"],
      feature_anchors: opts.feature_anchors ?? [],
      relations: opts.relations ?? [],
      ui_knowledge: opts.ui_knowledge ?? {
        data_contract: {
          inputs: [],
          outputs: [{ name: "rendered_view", type: "ui", description: "Renders the evidenced interface", trigger: "render" }],
        },
        interactions: [],
        visual_semantics: {
          visual_role: "interactive control", emphasis: "primary", density: "comfortable",
          chrome: "minimal", state_styling: [],
        },
        layout_semantics: { pattern: "flow", alignment: "leading", sizing_behavior: "content_sized", responsive_behavior: ["wrap"], hierarchy: [] },
        used_by: [],
        children: [],
      },
      confidence: opts.confidence ?? 0.85,
    })),
  });
}

// --- Temp data dir scaffold -------------------------------------------------

let tmpDir: string;

beforeEach(() => {
  mockState.available = true;
  mockState.responses = [];
  mockState.calls = [];
  mockState.throwAfter = undefined;
  tmpDir = mkdtempSync(join(tmpdir(), "dg-enrich-parser-"));
  setDataDirOverride(tmpDir);
  setDataDirResolver(() => tmpDir);
  invalidateCache();
});

afterEach(() => {
  delete config.repos.semantic_cache_test;
  invalidateCache();
  if (tmpDir && existsSync(tmpDir)) rmSync(tmpDir, { recursive: true, force: true });
});

async function writeData(filename: string, data: unknown): Promise<void> {
  await writeFile(join(tmpDir, filename), JSON.stringify(data, null, 2), "utf-8");
}

async function readData<T>(filename: string): Promise<T> {
  const raw = await readFile(join(tmpDir, filename), "utf-8");
  return JSON.parse(raw) as T;
}

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

describe("isParserOrigin / isAlreadyEnriched / bucketKey / chunk", () => {
  it("isParserOrigin only matches native scanner provenance", () => {
    expect(isParserOrigin(parserNode())).toBe(true);
    expect(
      isParserOrigin(parserNode({ provenance: { scanner: "manual" } as never })),
    ).toBe(false);
    expect(isParserOrigin(parserNode({ provenance: undefined }))).toBe(false);
  });

  it("isAlreadyEnriched only true when enrichment.enriched is true", () => {
    expect(isAlreadyEnriched(parserNode())).toBe(false);
    expect(
      isAlreadyEnriched(
        parserNode({
          enrichment: { enriched: true, enriched_at: "x", enricher: "y" },
        }),
      ),
    ).toBe(true);
  });

  it("bucketKey is repo::domain with fallbacks", () => {
    expect(bucketKey(parserNode({ source_repo: "r", domain: "d" }))).toBe("r::d");
    expect(bucketKey(parserNode({ source_repo: undefined, domain: undefined }))).toBe(
      "_unknown::_unknown",
    );
  });

  it("chunk slices into batches of N", () => {
    expect(chunk([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]]);
    expect(chunk([], 3)).toEqual([]);
  });

  it("builds relation context beyond one hop", () => {
    const first = parserNode({ id: "first", links: [{ target: "second", type: "workflow", relationship: "starts", description: "first starts second", strength: "strong" }] });
    const second = parserNode({ id: "second", links: [{ target: "third", type: "feature", relationship: "realizes", description: "second realizes third", strength: "strong" }] });
    const third = feature({ id: "third" });
    const context = buildMultiHopContext(first, [first, second, third], 3, 10);
    expect(context.map((node) => node.id)).toEqual(expect.arrayContaining(["second", "third"]));
  });
});

describe("buildSemanticCachePlan", () => {
  const richNeighbor = (over: Partial<ParserNodeRecord> = {}): ParserNodeRecord => parserNode({
    id: "semantic-neighbor",
    description: "This service owns the shared request contract and validates it before coordinating the domain workflow. It exists so callers and downstream persistence use one consistent interpretation of the operation.",
    intent: "Keep the shared operation contract consistent across its callers and downstream dependencies.",
    purpose: "domain-service",
    tags: ["contract", "workflow"],
    links: [{ target: "cache-root", type: "data_model", relationship: "supports", description: "Shares the operation contract", strength: "weak" }],
    enrichment: {
      enriched: true,
      enriched_at: "2026-08-10T12:00:00.000Z",
      enricher: "enrich_parser_nodes/1.1",
      confidence: 0.92,
    },
    ...over,
  });

  it("uses a confident enriched neighbor to cover shared source evidence", () => {
    const root = parserNode({ id: "cache-root", source_files: ["src/shared.ts"] });
    const plan = buildSemanticCachePlan(root, [richNeighbor({ source_files: ["src/shared.ts"] })], {
      enabled: true,
      minConfidence: 0.72,
      minCoverage: 0.75,
      sourceModifiedAt: new Map([["src/shared.ts", Date.parse("2026-08-10T11:00:00.000Z")]]),
    });

    expect(plan.sufficient).toBe(true);
    expect(plan.reused_neighbor_ids).toEqual(["semantic-neighbor"]);
    expect(plan.source_files_covered).toEqual(["src/shared.ts"]);
    expect(plan.source_files_to_read).toEqual([]);
    expect(plan.cache_confidence).toBeGreaterThanOrEqual(0.72);
  });

  it("rejects low-confidence neighbor semantics and reads the source", () => {
    const root = parserNode({ id: "cache-root", source_files: ["src/shared.ts"] });
    const neighbor = richNeighbor({
      source_files: ["src/shared.ts"],
      enrichment: {
        enriched: true,
        enriched_at: "2026-08-10T12:00:00.000Z",
        enricher: "enrich_parser_nodes/1.1",
        confidence: 0.2,
      },
    });
    const plan = buildSemanticCachePlan(root, [neighbor], {
      enabled: true,
      minConfidence: 0.72,
      minCoverage: 0.75,
      sourceModifiedAt: new Map([["src/shared.ts", Date.parse("2026-08-10T11:00:00.000Z")]]),
    });

    expect(plan.sufficient).toBe(false);
    expect(plan.low_confidence_neighbor_ids).toEqual(["semantic-neighbor"]);
    expect(plan.source_files_to_read).toEqual(["src/shared.ts"]);
  });

  it("does not let high stated confidence turn hollow knowledge into cache evidence", () => {
    const root = parserNode({ id: "cache-root", source_files: ["src/shared.ts"] });
    const neighbor = richNeighbor({
      source_files: ["src/shared.ts"],
      description: "85 source file(s) in src/",
      intent: undefined,
      purpose: undefined,
      tags: [],
      key_fields: [],
      enrichment: {
        enriched: true,
        enriched_at: "2026-08-10T12:00:00.000Z",
        enricher: "legacy-enricher",
        confidence: 0.99,
      },
    });
    const plan = buildSemanticCachePlan(root, [neighbor], {
      enabled: true,
      minConfidence: 0.72,
      minCoverage: 0.75,
      sourceModifiedAt: new Map([["src/shared.ts", Date.parse("2026-08-10T11:00:00.000Z")]]),
    });

    expect(plan.sufficient).toBe(false);
    expect(plan.low_confidence_neighbor_ids).toEqual(["semantic-neighbor"]);
    expect(plan.source_files_to_read).toEqual(["src/shared.ts"]);
  });

  it("treats source newer than enrichment as a cache conflict", () => {
    const root = parserNode({ id: "cache-root", source_files: ["src/shared.ts"] });
    const plan = buildSemanticCachePlan(root, [richNeighbor({ source_files: ["src/shared.ts"] })], {
      enabled: true,
      minConfidence: 0.72,
      minCoverage: 0.75,
      sourceModifiedAt: new Map([["src/shared.ts", Date.parse("2026-08-10T13:00:00.000Z")]]),
    });

    expect(plan.sufficient).toBe(false);
    expect(plan.conflicts).toEqual(["source_newer_than_cache:src/shared.ts:semantic-neighbor"]);
    expect(plan.source_files_covered).toEqual([]);
    expect(plan.source_files_to_read).toEqual(["src/shared.ts"]);
  });
});

describe("parseLlmEnrichment", () => {
  it("parses a well-formed JSON payload", () => {
    const json = JSON.stringify({
      results: [
        {
          id: "n1",
          description: "d",
          intent: "i",
          purpose: "p",
          tags: ["t"],
          feature_anchors: [{ target_id: "f1", relationship: "implements", rationale: "x", evidence_excerpt: "Ride Management" }],
          confidence: 0.9,
        },
      ],
    });
    const parsed = parseLlmEnrichment(json);
    expect(parsed).toHaveLength(1);
    expect(parsed[0].id).toBe("n1");
    expect(parsed[0].feature_anchors[0].target_id).toBe("f1");
    expect(parsed[0].confidence).toBe(0.9);
  });

  it("recovers from ```json fenced output", () => {
    const json = "```json\n" + JSON.stringify({ results: [{
      id: "n2", description: "", intent: "", purpose: "", tags: [], feature_anchors: [], confidence: 0.5,
    }] }) + "\n```";
    expect(parseLlmEnrichment(json)[0].id).toBe("n2");
  });

  it("clamps invalid confidence to 0.5", () => {
    const json = JSON.stringify({
      results: [
        { id: "n3", description: "d", intent: "i", purpose: "p", tags: [], feature_anchors: [], confidence: 999 },
      ],
    });
    expect(parseLlmEnrichment(json)[0].confidence).toBe(0.5);
  });

  it("filters anchors with empty target_id", () => {
    const json = JSON.stringify({
      results: [
        {
          id: "n4",
          description: "", intent: "", purpose: "", tags: [], confidence: 0.5,
          feature_anchors: [
            { target_id: "", relationship: "implements", rationale: "x", evidence_excerpt: "node evidence" },
            { target_id: "ok", relationship: "implements", rationale: "x", evidence_excerpt: "node evidence" },
          ],
        },
      ],
    });
    expect(parseLlmEnrichment(json)[0].feature_anchors).toEqual([
      { target_id: "ok", relationship: "implements", rationale: "x", evidence_excerpt: "node evidence" },
    ]);
  });

  it("throws on completely unparseable input", () => {
    expect(() => parseLlmEnrichment("not json at all")).toThrow();
  });
});

describe("mergeEnrichment", () => {
  it("preserves original description in description_raw", () => {
    const node = parserNode({ description: "ORIGINAL" });
    const e: PerNodeEnrichment = {
      id: node.id,
      description: "ENRICHED",
      intent: "I",
      purpose: "P",
      tags: ["t1"],
      feature_anchors: [],
      confidence: 0.7,
    };
    const { node: merged } = mergeEnrichment(node, e, new Set(), "model-x", "2025-01-01T00:00:00Z");
    expect(merged.description).toBe("ENRICHED");
    expect(merged.description_raw).toBe("ORIGINAL");
    expect(merged.intent).toBe("I");
    expect(merged.purpose).toBe("P");
    expect(merged.enrichment).toEqual({
      enriched: true,
      enriched_at: "2025-01-01T00:00:00Z",
      enricher: "enrich_parser_nodes/1.1",
      model: "model-x",
      confidence: 0.7,
    });
  });

  it("only writes feature anchors whose target_id is in the valid set", () => {
    const node = parserNode();
    const e: PerNodeEnrichment = {
      id: node.id,
      description: "x", intent: "", purpose: "", tags: [],
      confidence: 0.5,
      feature_anchors: [
        { target_id: "f-good", relationship: "implements", rationale: "x", evidence_excerpt: "node evidence" },
        { target_id: "f-bogus", relationship: "implements", rationale: "x", evidence_excerpt: "node evidence" },
      ],
    };
    const { node: merged, anchorsAdded } = mergeEnrichment(
      node, e, new Set(["f-good"]), undefined, "t",
    );
    expect(anchorsAdded).toBe(1);
    expect(merged.links?.map((l) => l.target)).toEqual(["f-good"]);
    expect(merged.links?.[0].strength).toBe("weak");
  });

  it("does not duplicate links to already-linked targets", () => {
    const node = parserNode({
      links: [{ target: "f1", type: "feature", relationship: "x", description: "x", strength: "strong" }],
    });
    const e: PerNodeEnrichment = {
      id: node.id, description: "", intent: "", purpose: "", tags: [], confidence: 0.5,
      feature_anchors: [{ target_id: "f1", relationship: "implements", rationale: "r", evidence_excerpt: "node evidence" }],
    };
    const { anchorsAdded } = mergeEnrichment(node, e, new Set(["f1"]), undefined, "t");
    expect(anchorsAdded).toBe(0);
  });

  it("does not overwrite an existing description_raw on re-enrichment", () => {
    const node = parserNode({ description: "second-pass-desc", description_raw: "first-original" });
    const e: PerNodeEnrichment = {
      id: node.id, description: "third-pass", intent: "", purpose: "", tags: [], confidence: 0.5, feature_anchors: [],
    };
    const { node: merged } = mergeEnrichment(node, e, new Set(), undefined, "t");
    expect(merged.description_raw).toBe("first-original");
  });
});

// ---------------------------------------------------------------------------
// Integration — with mocked LLM
// ---------------------------------------------------------------------------

describe("enrichParserNodesProgrammatic — integration", () => {
  it("reuses a fresh enriched neighborhood as semantic cache without rereading covered source", async () => {
    const repoRoot = join(tmpDir, "semantic-cache-repo");
    await mkdir(join(repoRoot, "src"), { recursive: true });
    await writeFile(join(repoRoot, "src", "shared.ts"), "export const sharedContract = 'semantic-cache';\n", "utf-8");
    config.repos.semantic_cache_test = repoRoot;

    const root = parserNode({
      id: "cache-root",
      name: "Cached Consumer",
      source_repo: "semantic_cache_test",
      source_files: ["src/shared.ts"],
    });
    const neighbor = parserNode({
      id: "cache-neighbor",
      name: "Shared Contract Owner",
      source_repo: "semantic_cache_test",
      source_files: ["src/shared.ts"],
      description: "Shared Contract Owner defines the validated request shape consumed by Cached Consumer. It owns interpretation of the shared operation and relates callers to the workflow that persists the resulting state.",
      intent: "Provide one trusted semantic contract for consumers of the shared domain operation.",
      purpose: "contract-owner",
      tags: ["contract", "shared"],
      enrichment: {
        enriched: true,
        enriched_at: "2099-01-01T00:00:00.000Z",
        enricher: "enrich_parser_nodes/1.1",
        confidence: 0.95,
      },
    });
    await writeData("data_model.json", [root, neighbor]);
    await writeData("features.json", []);
    mockState.responses = [llmResponseFor([root])];

    const res = await enrichParserNodesProgrammatic({ target: "data_model", batchSize: 1 });
    expect(res.success).toBe(true);
    if (!res.success) return;
    expect(res.data.semantic_cache).toMatchObject({
      nodes_served_from_cache: 1,
      source_reads_avoided: 1,
      source_file_reads: 0,
    });

    const messages = mockState.calls[0].messages as Array<{ role: string; content: string }>;
    const prompt = messages.find((message) => message.role === "user")?.content ?? "";
    expect(prompt).toContain('"semantic_cache_entry_refs"');
    expect(prompt).toContain("Semantic neighborhood catalog");
    expect(prompt).toContain("Provide one trusted semantic contract");
    expect(prompt).not.toContain("export const sharedContract");

    const persisted = await readData<ParserNodeRecord[]>("data_model.json");
    expect(persisted.find((node) => node.id === "cache-root")?.enrichment?.semantic_cache).toMatchObject({
      coverage: 0.75,
      reused_neighbor_ids: ["cache-neighbor"],
      source_files_read: [],
      context_hops: 3,
    });
  });

  it("deduplicates shared source excerpts across nodes in one batch", async () => {
    const repoRoot = join(tmpDir, "semantic-cache-repo");
    await mkdir(join(repoRoot, "src"), { recursive: true });
    const marker = "UNIQUE_SHARED_SOURCE_EVIDENCE";
    await writeFile(join(repoRoot, "src", "shared.ts"), `export const evidence = "${marker}";\n`, "utf-8");
    config.repos.semantic_cache_test = repoRoot;
    const nodes = [
      parserNode({ id: "shared-a", name: "Shared A", source_repo: "semantic_cache_test", source_files: ["src/shared.ts"] }),
      parserNode({ id: "shared-b", name: "Shared B", source_repo: "semantic_cache_test", source_files: ["src/shared.ts"] }),
    ];
    await writeData("data_model.json", nodes);
    await writeData("features.json", []);
    mockState.responses = [llmResponseFor(nodes)];

    const res = await enrichParserNodesProgrammatic({ target: "data_model", batchSize: 2 });
    expect(res.success).toBe(true);
    if (!res.success) return;
    expect(res.data.semantic_cache).toMatchObject({
      source_file_reads: 1,
      source_file_cache_hits: 1,
      prompt_source_reuses: 1,
    });
    const messages = mockState.calls[0].messages as Array<{ role: string; content: string }>;
    const prompt = messages.find((message) => message.role === "user")?.content ?? "";
    expect(prompt.split(marker)).toHaveLength(2);
  });

  it("makes an enriched node available to later batches in the same run", async () => {
    const repoRoot = join(tmpDir, "semantic-cache-repo");
    await mkdir(join(repoRoot, "src"), { recursive: true });
    await writeFile(join(repoRoot, "src", "shared.ts"), "export interface SharedFlow { id: string }\n", "utf-8");
    config.repos.semantic_cache_test = repoRoot;
    const nodes = [
      parserNode({ id: "first-pass", name: "First Pass", source_repo: "semantic_cache_test", source_files: ["src/shared.ts"] }),
      parserNode({ id: "second-pass", name: "Second Pass", source_repo: "semantic_cache_test", source_files: ["src/shared.ts"] }),
    ];
    await writeData("data_model.json", nodes);
    await writeData("features.json", []);
    mockState.responses = [llmResponseFor([nodes[0]]), llmResponseFor([nodes[1]])];

    const res = await enrichParserNodesProgrammatic({ target: "data_model", batchSize: 1 });
    expect(res.success).toBe(true);
    if (!res.success) return;
    expect(res.data.semantic_cache).toMatchObject({
      nodes_served_from_cache: 1,
      source_reads_avoided: 1,
      source_file_reads: 1,
      source_file_cache_hits: 0,
    });
    const secondMessages = mockState.calls[1].messages as Array<{ role: string; content: string }>;
    const secondPrompt = secondMessages.find((message) => message.role === "user")?.content ?? "";
    expect(secondPrompt).toContain('"policy": "reuse_semantic_cache"');
    expect(secondPrompt).toContain('"id": "first-pass"');
    expect(secondPrompt).not.toContain("export interface SharedFlow");
  });

  it("uses deterministic structural fallback when no provider is available", async () => {
    mockState.available = false;
    await writeData("data_model.json", [parserNode()]);
    await writeData("features.json", []);

    const res = await enrichParserNodesProgrammatic();
    expect(res.success).toBe(true);
    if (!res.success) return;
    expect(res.data.llm_calls).toBe(0);
    expect(res.data.total_enriched).toBe(1);
    expect(res.data.notes.some((note) => /deterministic_fallback/.test(note))).toBe(true);
    expect(res.data.adaptive_future_audit).toMatchObject({
      audit_version: "slice12-scaffold-v1",
      task_class: "graph_tool_change",
      selected_candidate_id: "enrich_parser_nodes:all:semantic_enrichment",
      route: "deterministic",
      fallback: "deterministic_fallback",
    });
    const after = await readData<ParserNodeRecord[]>("data_model.json");
    expect(after[0].enrichment?.model).toBe("deterministic_fallback");
    expect(after[0].tags).toContain("structural-fallback");
  });

  it("enriches every non-enriched graph node regardless of scanner origin", async () => {
    const nodes: ParserNodeRecord[] = [
      parserNode({ id: "parser-1" }),
      parserNode({ id: "parser-2-already", enrichment: { enriched: true, enriched_at: "t", enricher: "e" } }),
      parserNode({ id: "manual-1", provenance: { scanner: "manual" } as never }),
    ];
    await writeData("data_model.json", nodes);
    await writeData("features.json", []);
    mockState.responses = [llmResponseFor([nodes[0], nodes[2]])];

    const res = await enrichParserNodesProgrammatic({ target: "data_model" });
    expect(res.success).toBe(true);
    if (!res.success) return;
    expect(res.data.total_eligible).toBe(2);
    expect(res.data.total_enriched).toBe(2);
    expect(mockState.calls).toHaveLength(1);

    const after = await readData<ParserNodeRecord[]>("data_model.json");
    expect(after.find((n) => n.id === "parser-1")?.enrichment?.enriched).toBe(true);
    expect(after.find((n) => n.id === "parser-2-already")?.enrichment?.enricher).toBe("e");
    expect(after.find((n) => n.id === "manual-1")?.enrichment?.enriched).toBe(true);
  });

  it("re-enriches when force=true", async () => {
    const node = parserNode({
      id: "x",
      enrichment: { enriched: true, enriched_at: "old", enricher: "old" },
    });
    await writeData("data_model.json", [node]);
    await writeData("features.json", []);
    mockState.responses = [llmResponseFor([node])];

    const res = await enrichParserNodesProgrammatic({ target: "data_model", force: true });
    expect(res.success).toBe(true);
    if (!res.success) return;
    expect(res.data.total_enriched).toBe(1);
    const after = await readData<ParserNodeRecord[]>("data_model.json");
    expect(after[0].enrichment?.enricher).toBe("enrich_parser_nodes/1.1");
  });

  it("respects batch_size — multiple LLM calls for larger inputs", async () => {
    const nodes: ParserNodeRecord[] = Array.from({ length: 5 }, (_, i) =>
      parserNode({ id: `n${i}`, name: `N${i}` }),
    );
    await writeData("data_model.json", nodes);
    await writeData("features.json", []);
    // Two batches: size 2, 2, 1.
    mockState.responses = [
      llmResponseFor(nodes.slice(0, 2)),
      llmResponseFor(nodes.slice(2, 4)),
      llmResponseFor(nodes.slice(4, 5)),
    ];

    const res = await enrichParserNodesProgrammatic({ target: "data_model", batchSize: 2 });
    expect(res.success).toBe(true);
    if (!res.success) return;
    expect(res.data.batches_run).toBe(3);
    expect(res.data.llm_calls).toBe(3);
    expect(res.data.total_enriched).toBe(5);
  });

  it("respects max_nodes cap", async () => {
    const nodes: ParserNodeRecord[] = Array.from({ length: 10 }, (_, i) =>
      parserNode({ id: `n${i}` }),
    );
    await writeData("data_model.json", nodes);
    await writeData("features.json", []);
    mockState.responses = [llmResponseFor(nodes.slice(0, 3))];

    const res = await enrichParserNodesProgrammatic({
      target: "data_model",
      maxNodes: 3,
      batchSize: 5,
    });
    expect(res.success).toBe(true);
    if (!res.success) return;
    expect(res.data.total_enriched).toBe(3);
    expect(mockState.calls).toHaveLength(1);
  });

  it("dry_run does not persist changes but still calls the LLM", async () => {
    const node = parserNode();
    await writeData("data_model.json", [node]);
    await writeData("features.json", []);
    mockState.responses = [llmResponseFor([node])];

    const res = await enrichParserNodesProgrammatic({ target: "data_model", dryRun: true });
    expect(res.success).toBe(true);
    if (!res.success) return;
    expect(res.data.total_enriched).toBe(1);
    expect(mockState.calls).toHaveLength(1);
    const after = await readData<ParserNodeRecord[]>("data_model.json");
    expect(after[0].enrichment).toBeUndefined();
    expect(after[0].description).toBe(node.description); // unchanged
  });

  it("writes feature anchors as weak GraphLinks", async () => {
    const node = parserNode({ id: "n1" });
    const f = feature({ id: "f1" });
    await writeData("data_model.json", [node]);
    await writeData("features.json", [f]);
    mockState.responses = [
      llmResponseFor([node], {
        feature_anchors: [{ target_id: "f1", relationship: "implements", rationale: "covers", evidence_excerpt: "Ride Management" }],
      }),
    ];

    const res = await enrichParserNodesProgrammatic({ target: "data_model" });
    expect(res.success).toBe(true);
    if (!res.success) return;
    expect(res.data.feature_anchors_written).toBe(1);

    const after = await readData<ParserNodeRecord[]>("data_model.json");
    const link = after[0].links?.[0];
    expect(link?.target).toBe("f1");
    expect(link?.strength).toBe("weak");
    expect(link?.type).toBe("feature");
    expect(link?.relationship).toBe("implements");
  });

  const invalidMutationCases: Array<{ name: string; response: string; expected: RegExp }> = [
    {
      name: "unknown feature anchors",
      response: llmResponseFor([parserNode({ id: "n-invalid" })], {
        feature_anchors: [{ target_id: "missing-feature", relationship: "implements", rationale: "x", evidence_excerpt: "Ride" }],
      }),
      expected: /unknown feature anchor/,
    },
    {
      name: "invalid node ids",
      response: llmResponseFor([parserNode({ id: "other-node" })]),
      expected: /unknown node id|missing enrichment/,
    },
    {
      name: "invalid relationship vocabulary",
      response: llmResponseFor([parserNode({ id: "n-invalid" })], {
        feature_anchors: [{ target_id: "f1", relationship: "not_allowed", rationale: "x", evidence_excerpt: "Ride" }],
      } as Partial<PerNodeEnrichment>),
      expected: /invalid feature anchor relationship/,
    },
    {
      name: "excessive anchor counts",
      response: llmResponseFor([parserNode({ id: "n-invalid" })], {
        feature_anchors: Array.from({ length: 6 }, () => ({ target_id: "f1", relationship: "implements", rationale: "x", evidence_excerpt: "Ride" })),
      }),
      expected: /excessive feature anchors/,
    },
    {
      name: "missing evidence excerpts",
      response: llmResponseFor([parserNode({ id: "n-invalid" })], {
        feature_anchors: [{ target_id: "f1", relationship: "implements", rationale: "x", evidence_excerpt: "" }],
      }),
      expected: /missing feature anchor evidence excerpt/,
    },
  ];

  for (const scenario of invalidMutationCases) {
    it(`rejects ${scenario.name} before persistence and uses structural fallback`, async () => {
      const node = parserNode({ id: "n-invalid" });
      await writeData("data_model.json", [node]);
      await writeData("features.json", [feature({ id: "f1" })]);
      mockState.responses = [scenario.response];

      const res = await enrichParserNodesProgrammatic({ target: "data_model" });
      expect(res.success).toBe(true);
      if (!res.success) return;
      expect(res.data.errors.some((entry) => scenario.expected.test(entry))).toBe(true);

      const after = await readData<ParserNodeRecord[]>("data_model.json");
      expect(after[0].links ?? []).toHaveLength(0);
      expect(after[0].enrichment?.model).toBe("deterministic_fallback");
    });
  }

  it("salvages valid nodes when another result in the same batch fails validation", async () => {
    const nodes = [
      parserNode({ id: "valid-node", name: "Valid Node" }),
      parserNode({ id: "invalid-node", name: "Invalid Node" }),
    ];
    await writeData("data_model.json", nodes);
    await writeData("features.json", []);
    const payload = JSON.parse(llmResponseFor(nodes)) as { results: Array<Record<string, unknown>> };
    payload.results[1].description = "too short";
    payload.results[1].intent = "shallow";
    mockState.responses = [JSON.stringify(payload)];

    const res = await enrichParserNodesProgrammatic({ target: "data_model", batchSize: 2 });
    expect(res.success).toBe(true);
    if (!res.success) return;
    expect(res.data.semantic_coverage).toMatchObject({ llm_enriched: 1, fallback_nodes: 1 });

    const after = await readData<ParserNodeRecord[]>("data_model.json");
    expect(after.find((node) => node.id === "valid-node")?.enrichment?.model).toBe("mock-model");
    expect(after.find((node) => node.id === "invalid-node")?.enrichment?.model).toBe("deterministic_fallback");
  });

  it("malformed LLM response for a batch is recorded and run continues", async () => {
    const nodes = [parserNode({ id: "n1" }), parserNode({ id: "n2" })];
    await writeData("data_model.json", nodes);
    await writeData("features.json", []);
    mockState.responses = [
      "this is not JSON",
      llmResponseFor([nodes[1]]),
    ];

    const res = await enrichParserNodesProgrammatic({ target: "data_model", batchSize: 1 });
    expect(res.success).toBe(true);
    if (!res.success) return;
    expect(res.data.batches_run).toBe(2);
    expect(res.data.total_enriched).toBe(2);
    expect(res.data.errors.length).toBeGreaterThan(0);

    const after = await readData<ParserNodeRecord[]>("data_model.json");
    expect(after.find((n) => n.id === "n1")?.enrichment?.model).toBe("deterministic_fallback");
    expect(after.find((n) => n.id === "n2")?.enrichment?.enriched).toBe(true);
  });

  it("persists after each batch (crash-safety check)", async () => {
    const nodes = [parserNode({ id: "n1" }), parserNode({ id: "n2" })];
    await writeData("data_model.json", nodes);
    await writeData("features.json", []);
    // Second batch throws — first batch remains persisted and the second uses fallback.
    mockState.responses = [llmResponseFor([nodes[0]])];
    mockState.throwAfter = 1;

    const res = await enrichParserNodesProgrammatic({ target: "data_model", batchSize: 1 });
    expect(res.success).toBe(true);
    if (!res.success) return;
    expect(res.data.total_enriched).toBe(2);
    expect(res.data.errors.length).toBeGreaterThan(0);

    const after = await readData<ParserNodeRecord[]>("data_model.json");
    expect(after.find((n) => n.id === "n1")?.enrichment?.enriched).toBe(true);
    expect(after.find((n) => n.id === "n2")?.enrichment?.model).toBe("deterministic_fallback");
  });

  it("target=both processes features too", async () => {
    const dm = parserNode({ id: "dm1" });
    const f = parserNode({
      id: "f1",
      name: "Feature One",
      description: "Generic feature",
      provenance: { scanner: "native", language: "c", qualified_name: "FeatureOne" },
    });
    await writeData("data_model.json", [dm]);
    await writeData("features.json", [f]);
    mockState.responses = [llmResponseFor([dm]), llmResponseFor([f])];

    const res = await enrichParserNodesProgrammatic({ target: "both" });
    expect(res.success).toBe(true);
    if (!res.success) return;
    expect(res.data.files_processed).toEqual(["data_model", "features"]);
    expect(res.data.total_enriched).toBe(2);

    const dmOut = await readData<ParserNodeRecord[]>("data_model.json");
    const fOut = await readData<ParserNodeRecord[]>("features.json");
    expect(dmOut[0].enrichment?.enriched).toBe(true);
    expect(fOut[0].enrichment?.enriched).toBe(true);
  });

  it('target="both" emits a deprecation note', async () => {
    await writeData("data_model.json", [parserNode({ id: "dm1" })]);
    await writeData("features.json", []);
    mockState.responses = [llmResponseFor([parserNode({ id: "dm1" })])];
    const res = await enrichParserNodesProgrammatic({ target: "both" });
    expect(res.success).toBe(true);
    if (!res.success) return;
    expect(res.data.notes.some((n) => /deprecated/i.test(n))).toBe(true);
  });

  // -------------------------------------------------------------------------
  // UI target (slice 1: first-class UI graph citizenship)
  // -------------------------------------------------------------------------

  function uiRegistryFile(elements: unknown[]): unknown {
    return {
      metadata: { total_elements: elements.length, last_updated: "2024-01-01" },
      elements,
    };
  }

  function scannerUiElement(over: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      id: "ui_button_pay",
      name: "PayButton",
      purpose: "button",
      category: "action",
      source_kind: "scanner",
      source_repo: "openrct2",
      source_file: "src/ui/PayButton.tsx",
      tags: [],
      ...over,
    };
  }

  it('target="ui" enriches scanner-origin UI elements with source_repo', async () => {
    await writeData("data_model.json", []);
    await writeData("features.json", []);
    await writeData("ui_registry.json", uiRegistryFile([scannerUiElement()]));
    mockState.responses = [
      llmResponseFor([parserNode({ id: "ui_button_pay", name: "PayButton" })]),
    ];

    const res = await enrichParserNodesProgrammatic({ target: "ui" });
    expect(res.success).toBe(true);
    if (!res.success) return;
    expect(res.data.files_processed).toEqual(["ui"]);
    expect(res.data.total_enriched).toBe(1);
    expect(res.data.ui_relation_gaps).toEqual(["ui_button_pay"]);

    const out = await readData<{ elements: Array<Record<string, unknown>> }>(
      "ui_registry.json",
    );
    const el = out.elements[0];
    expect(el.enrichment).toMatchObject({ enriched: true, enricher: expect.any(String) });
    // UI's own purpose field MUST be preserved (role tag), not overwritten by the LLM's purpose.
    expect(el.purpose).toBe("button");
    // intent should be set from LLM output.
    expect(el.intent).toContain("PayButton");
    const options = mockState.calls[0].options as {
      jsonSchema?: { name?: string; schema?: { properties?: { results?: { items?: { required?: string[]; properties?: Record<string, unknown> } } } } };
    };
    expect(options.jsonSchema?.name).toBe("dreamgraph_ui_enrichment_batch");
    expect(options.jsonSchema?.schema?.properties?.results?.items?.required).toContain("ui_knowledge");
    expect(options.jsonSchema?.schema?.properties?.results?.items?.properties).toHaveProperty("ui_knowledge");
  });

  it("keeps rich UI enrichment and unions scanner facts when the model adds no relation", async () => {
    await writeData("data_model.json", []);
    await writeData("features.json", []);
    await writeData("ui_registry.json", uiRegistryFile([
      scannerUiElement({
        data_contract: {
          inputs: [{ name: "amount", type: "number", description: "Source-declared payment amount", required: true }],
          outputs: [{ name: "button_surface", type: "ui", description: "Scanner-observed button surface", trigger: "render" }],
        },
        interactions: [{ action: "onClick", description: "Scanner-observed click handler" }],
        children: ["ui_payment_icon"],
        links: [{ target: "ui_payment_icon", type: "ui_element", relationship: "composes", strength: "strong" }],
      }),
      scannerUiElement({
        id: "ui_payment_icon",
        name: "PaymentIcon",
        source_file: "src/ui/PaymentIcon.tsx",
        enrichment: {
          enriched: true,
          enriched_at: "2026-08-10T20:18:05.456Z",
          enricher: "existing",
          model: "mock-model",
          confidence: 0.9,
        },
      }),
    ]));
    mockState.responses = [
      llmResponseFor([parserNode({ id: "ui_button_pay", name: "PayButton" })], {
        ui_knowledge: {
          data_contract: {
            inputs: [],
            outputs: [{ name: "rendered_view", type: "ui", description: "Rich payment action surface", trigger: "render" }],
          },
          interactions: [],
          visual_semantics: {
            visual_role: "payment action", emphasis: "primary", density: "comfortable",
            chrome: "minimal", state_styling: [],
          },
          layout_semantics: {
            pattern: "flow", alignment: "leading", sizing_behavior: "content_sized",
            responsive_behavior: ["wrap"], hierarchy: [],
          },
          used_by: [],
          children: [],
        },
      }),
    ];

    const res = await enrichParserNodesProgrammatic({ target: "ui" });
    expect(res.success).toBe(true);
    if (!res.success) return;
    expect(res.data.semantic_coverage).toMatchObject({ llm_enriched: 1, fallback_nodes: 0 });
    expect(res.data.errors).toEqual([]);

    const out = await readData<{ elements: Array<Record<string, any>> }>("ui_registry.json");
    const button = out.elements.find((element) => element.id === "ui_button_pay")!;
    expect(button.enrichment).toMatchObject({ enriched: true, model: "mock-model" });
    expect(button.children).toContain("ui_payment_icon");
    expect(button.links).toEqual(expect.arrayContaining([
      expect.objectContaining({ target: "ui_payment_icon", relationship: "composes" }),
    ]));
    expect(button.data_contract.inputs).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: "amount" }),
    ]));
    expect(button.data_contract.outputs).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: "button_surface" }),
      expect.objectContaining({ name: "rendered_view" }),
    ]));
    expect(button.interactions).toEqual(expect.arrayContaining([
      expect.objectContaining({ action: "onClick" }),
    ]));
  });

  it('target="ui" skips UI elements without source_repo (manual entries)', async () => {
    await writeData("data_model.json", []);
    await writeData("features.json", []);
    await writeData(
      "ui_registry.json",
      uiRegistryFile([
        { id: "manual_btn", name: "Manual", purpose: "button" }, // no source_kind/source_repo
        scannerUiElement({ id: "scoped_btn", name: "Scoped" }),
      ]),
    );
    mockState.responses = [
      llmResponseFor([parserNode({ id: "scoped_btn", name: "Scoped" })]),
    ];

    const res = await enrichParserNodesProgrammatic({ target: "ui" });
    expect(res.success).toBe(true);
    if (!res.success) return;
    expect(res.data.total_enriched).toBe(1);

    const out = await readData<{ elements: Array<Record<string, unknown>> }>(
      "ui_registry.json",
    );
    expect(out.elements.find((e) => e.id === "manual_btn")?.enrichment).toBeUndefined();
    expect(out.elements.find((e) => e.id === "scoped_btn")?.enrichment).toBeDefined();
  });

  it('target="ui" skips already-enriched elements unless force=true', async () => {
    await writeData("data_model.json", []);
    await writeData("features.json", []);
    await writeData(
      "ui_registry.json",
      uiRegistryFile([
        scannerUiElement({
          id: "done_btn",
          enrichment: { enriched: true, enriched_at: "2024-01-01", enricher: "x" },
        }),
      ]),
    );

    const res = await enrichParserNodesProgrammatic({ target: "ui" });
    expect(res.success).toBe(true);
    if (!res.success) return;
    expect(res.data.total_enriched).toBe(0);
    expect(mockState.calls.length).toBe(0);
  });

  it('target="all" processes every populated canonical graph store', async () => {
    await writeData("data_model.json", [parserNode({ id: "dm1" })]);
    await writeData("features.json", [
      parserNode({
        id: "f1",
        name: "Feature",
        provenance: { scanner: "native", language: "c", qualified_name: "F" },
      }),
    ]);
    await writeData("capabilities.json", [parserNode({ id: "c1", name: "Capability" })]);
    await writeData("ui_registry.json", uiRegistryFile([scannerUiElement({ id: "ui1", name: "UI1" })]));
    mockState.responses = [
      llmResponseFor([parserNode({ id: "dm1" })]),
      llmResponseFor([parserNode({ id: "f1", name: "Feature" })]),
      llmResponseFor([parserNode({ id: "c1", name: "Capability" })]),
      llmResponseFor([parserNode({ id: "ui1", name: "UI1" })]),
    ];

    const res = await enrichParserNodesProgrammatic({ target: "all" });
    expect(res.success).toBe(true);
    if (!res.success) return;
    expect(res.data.files_processed.sort()).toEqual(["capabilities", "data_model", "features", "ui"]);
    expect(res.data.total_enriched).toBe(4);
  });
});
