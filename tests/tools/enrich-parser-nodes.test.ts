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
import { writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { setDataDirOverride } from "../../src/utils/paths.js";
import { invalidateCache, setDataDirResolver } from "../../src/utils/cache.js";

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
  return {
    ...actual,
    isLlmAvailable: async () => mockState.available,
    getLlmProvider: () => ({
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
    }),
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
      description: opts.description ?? `Enriched: ${n.name}`,
      intent: opts.intent ?? `Represents the ${n.name} concept.`,
      purpose: opts.purpose ?? "domain-entity",
      tags: opts.tags ?? ["enriched"],
      feature_anchors: opts.feature_anchors ?? [],
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
          feature_anchors: [{ target_id: "f1", relationship: "r", rationale: "x" }],
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
            { target_id: "", relationship: "r", rationale: "x" },
            { target_id: "ok", relationship: "r", rationale: "x" },
          ],
        },
      ],
    });
    expect(parseLlmEnrichment(json)[0].feature_anchors).toEqual([
      { target_id: "ok", relationship: "r", rationale: "x" },
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
      enricher: "enrich_parser_nodes/1.0",
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
        { target_id: "f-good", relationship: "r", rationale: "x" },
        { target_id: "f-bogus", relationship: "r", rationale: "x" },
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
      feature_anchors: [{ target_id: "f1", relationship: "r", rationale: "r" }],
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
  it("returns LLM_UNAVAILABLE without writing when no provider is available", async () => {
    mockState.available = false;
    await writeData("data_model.json", [parserNode()]);
    await writeData("features.json", []);

    const res = await enrichParserNodesProgrammatic();
    expect(res.success).toBe(false);
    if (!res.success) {
      expect(res.error.code).toBe("LLM_UNAVAILABLE");
    }
    // Data file untouched.
    const after = await readData<ParserNodeRecord[]>("data_model.json");
    expect(after[0].enrichment).toBeUndefined();
  });

  it("filters non-parser-origin and already-enriched entries", async () => {
    const nodes: ParserNodeRecord[] = [
      parserNode({ id: "parser-1" }),
      parserNode({ id: "parser-2-already", enrichment: { enriched: true, enriched_at: "t", enricher: "e" } }),
      parserNode({ id: "manual-1", provenance: { scanner: "manual" } as never }),
    ];
    await writeData("data_model.json", nodes);
    await writeData("features.json", []);
    mockState.responses = [llmResponseFor([nodes[0]])];

    const res = await enrichParserNodesProgrammatic({ target: "data_model" });
    expect(res.success).toBe(true);
    if (!res.success) return;
    expect(res.data.total_eligible).toBe(1);
    expect(res.data.total_enriched).toBe(1);
    expect(mockState.calls).toHaveLength(1);

    const after = await readData<ParserNodeRecord[]>("data_model.json");
    expect(after.find((n) => n.id === "parser-1")?.enrichment?.enriched).toBe(true);
    expect(after.find((n) => n.id === "parser-2-already")?.enrichment?.enricher).toBe("e");
    expect(after.find((n) => n.id === "manual-1")?.enrichment).toBeUndefined();
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
    expect(after[0].enrichment?.enricher).toBe("enrich_parser_nodes/1.0");
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
        feature_anchors: [{ target_id: "f1", relationship: "implements", rationale: "covers" }],
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
    expect(res.data.total_enriched).toBe(1);
    expect(res.data.errors.length).toBeGreaterThan(0);

    const after = await readData<ParserNodeRecord[]>("data_model.json");
    expect(after.find((n) => n.id === "n1")?.enrichment).toBeUndefined();
    expect(after.find((n) => n.id === "n2")?.enrichment?.enriched).toBe(true);
  });

  it("persists after each batch (crash-safety check)", async () => {
    const nodes = [parserNode({ id: "n1" }), parserNode({ id: "n2" })];
    await writeData("data_model.json", nodes);
    await writeData("features.json", []);
    // Second batch throws — first batch must remain persisted.
    mockState.responses = [llmResponseFor([nodes[0]])];
    mockState.throwAfter = 1;

    const res = await enrichParserNodesProgrammatic({ target: "data_model", batchSize: 1 });
    expect(res.success).toBe(true);
    if (!res.success) return;
    expect(res.data.total_enriched).toBe(1);
    expect(res.data.errors.length).toBeGreaterThan(0);

    const after = await readData<ParserNodeRecord[]>("data_model.json");
    expect(after.find((n) => n.id === "n1")?.enrichment?.enriched).toBe(true);
    expect(after.find((n) => n.id === "n2")?.enrichment).toBeUndefined();
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
});
