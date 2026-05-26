/**
 * DreamGraph v5.2 — Graph RAG Bridge (Knowledge Backbone)
 *
 * Exposes the DreamGraph knowledge graph as a retrieval-augmented generation
 * (RAG) layer for any LLM interaction. The graph becomes a universal context
 * source — queries resolve to entities, expand via BFS, rank by relevance,
 * and serialize within a token budget.
 *
 * This module is **read-only** — it never modifies any data files.
 *
 * Key concepts:
 *   - TF-IDF entity similarity (lightweight, no external embedding service)
 *   - BFS subgraph extraction from resolved entities
 *   - Relevance ranking (confidence × recency × query overlap)
 *   - Token-budgeted serialization with priority trimming
 *   - Cognitive Preamble: compact system summary for automatic LLM injection
 *
 * Retrieval modes:
 *   entity_focused    — "Tell me about the payment system"
 *   tension_focused   — "What problems exist?"
 *   narrative_focused — "What has changed recently?"
 *   comprehensive     — Balanced overview for pre-prompt injection
 */

import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { loadJsonArray, loadJsonData } from "../utils/cache.js";
import { dataPath } from "../utils/paths.js";
import { logger } from "../utils/logger.js";
import type { Feature, Workflow, DataModelEntity } from "../types/index.js";
import type {
  ValidatedEdge,
  ValidatedEdgesFile,
  TensionSignal,
  TensionFile,
  SystemStoryFile,
  StoryChapter,
  EntitySimilarity,
  TfIdfDocument,
  GraphRAGMode,
  GraphRAGQuery,
  GraphRAGContext,
  CognitivePreamble,
  CompiledTaskPreamble,
  TaskPreambleCompileRequest,
  TaskPreambleEvidenceItem,
} from "./types.js";
import { selectLlmRoute } from "./llm.js";

// ---------------------------------------------------------------------------
// Token estimation (chars / 4 heuristic — conservative)
// ---------------------------------------------------------------------------

function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

function roundFutureFitScore(value: number): number {
  return Math.round(Math.max(0, Math.min(1, value)) * 100) / 100;
}

function uniqueEvidenceAnchors(anchors: Array<string | undefined | null>): string[] {
  return [...new Set(anchors.filter((anchor): anchor is string => !!anchor && evidenceAnchorIsValid(anchor)))];
}

// ---------------------------------------------------------------------------
// TF-IDF Engine (in-memory, lightweight)
// ---------------------------------------------------------------------------

/** Tokenize text into lowercased terms */
function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9_\-\s]/g, " ")
    .split(/\s+/)
    .filter((t) => t.length > 1);
}

/** Compute term frequency for a single document */
function computeTf(terms: string[]): Map<string, number> {
  const tf = new Map<string, number>();
  for (const term of terms) {
    tf.set(term, (tf.get(term) ?? 0) + 1);
  }
  // Normalize by document length
  for (const [term, count] of tf) {
    tf.set(term, count / terms.length);
  }
  return tf;
}

/** Build a TF-IDF index from a set of entities */
function buildIndex(
  entities: Array<{ id: string; name: string; description: string; keywords?: string[]; domain?: string }>
): TfIdfDocument[] {
  return entities.map((e) => {
    const text = [e.name, e.description, ...(e.keywords ?? []), e.domain ?? ""].join(" ");
    const terms = tokenize(text);
    return {
      entity_id: e.id,
      text,
      tf: computeTf(terms),
    };
  });
}

/** Compute IDF for a term across all documents */
function computeIdf(term: string, docs: TfIdfDocument[]): number {
  const docsWithTerm = docs.filter((d) => d.tf.has(term)).length;
  if (docsWithTerm === 0) return 0;
  return Math.log((docs.length + 1) / (docsWithTerm + 1)) + 1;
}

/** Score documents against a query using TF-IDF cosine similarity */
export function queryTfIdf(query: string, docs: TfIdfDocument[]): EntitySimilarity[] {
  const queryTerms = tokenize(query);
  if (queryTerms.length === 0 || docs.length === 0) return [];

  // Compute query TF
  const queryTf = computeTf(queryTerms);

  // Compute TF-IDF vectors and cosine similarity
  const results: EntitySimilarity[] = [];

  for (const doc of docs) {
    let dotProduct = 0;
    let queryMag = 0;
    let docMag = 0;
    const matchedTerms: string[] = [];

    for (const [term, qtf] of queryTf) {
      const idf = computeIdf(term, docs);
      const qWeight = qtf * idf;
      const dWeight = (doc.tf.get(term) ?? 0) * idf;

      dotProduct += qWeight * dWeight;
      queryMag += qWeight * qWeight;
      docMag += dWeight * dWeight;

      if (doc.tf.has(term)) {
        matchedTerms.push(term);
      }
    }

    // Also accumulate doc magnitude for all doc terms (for proper cosine)
    for (const [term, dtf] of doc.tf) {
      if (!queryTf.has(term)) {
        const idf = computeIdf(term, docs);
        docMag += (dtf * idf) ** 2;
      }
    }

    const magnitude = Math.sqrt(queryMag) * Math.sqrt(docMag);
    const score = magnitude > 0 ? dotProduct / magnitude : 0;

    if (score > 0) {
      results.push({
        entity_id: doc.entity_id,
        score: Math.round(score * 1000) / 1000,
        matched_terms: matchedTerms,
      });
    }
  }

  return results.sort((a, b) => b.score - a.score);
}

// ---------------------------------------------------------------------------
// Data Loading Helpers
// ---------------------------------------------------------------------------

interface KnowledgeGraph {
  features: Feature[];
  workflows: Workflow[];
  dataModels: DataModelEntity[];
  validatedEdges: ValidatedEdge[];
  tensions: TensionSignal[];
  storyChapters: StoryChapter[];
}

async function loadKnowledgeGraph(): Promise<KnowledgeGraph> {
  const [features, workflows, dataModels] = await Promise.all([
    loadJsonArray<Feature>("features.json"),
    loadJsonArray<Workflow>("workflows.json"),
    loadJsonArray<DataModelEntity>("data_model.json"),
  ]);

  // Load validated edges
  let validatedEdges: ValidatedEdge[] = [];
  try {
    if (existsSync(dataPath("validated_edges.json"))) {
      const file = await loadJsonData<ValidatedEdgesFile>("validated_edges.json");
      validatedEdges = file.edges ?? [];
    }
  } catch { /* empty */ }

  // Load tensions
  let tensions: TensionSignal[] = [];
  try {
    if (existsSync(dataPath("tension_log.json"))) {
      const file = await loadJsonData<TensionFile>("tension_log.json");
      tensions = (file.signals ?? []).filter((t) => !t.resolved);
    }
  } catch { /* empty */ }

  // Load story chapters
  let storyChapters: StoryChapter[] = [];
  try {
    if (existsSync(dataPath("system_story.json"))) {
      const file = await loadJsonData<SystemStoryFile>("system_story.json");
      storyChapters = file.chapters ?? [];
    }
  } catch { /* empty */ }

  return { features, workflows, dataModels, validatedEdges, tensions, storyChapters };
}

/** Build a combined entity list from all seed data */
function allEntities(kg: KnowledgeGraph): Array<{ id: string; name: string; description: string; keywords?: string[]; domain?: string }> {
  const entities: Array<{ id: string; name: string; description: string; keywords?: string[]; domain?: string }> = [];
  for (const f of kg.features) {
    entities.push({ id: f.id, name: f.name, description: f.description, keywords: f.keywords, domain: f.domain });
  }
  for (const w of kg.workflows) {
    entities.push({ id: w.id, name: w.name, description: w.description, keywords: w.keywords, domain: w.domain });
  }
  for (const d of kg.dataModels) {
    entities.push({ id: d.id, name: d.name, description: d.description, keywords: d.keywords, domain: d.domain });
  }
  return entities;
}

// ---------------------------------------------------------------------------
// Entity Resolution
// ---------------------------------------------------------------------------

function resolveEntities(
  query: string,
  entities: Array<{ id: string; name: string; description: string; keywords?: string[]; domain?: string }>,
  tfidfDocs: TfIdfDocument[]
): EntitySimilarity[] {
  const results: EntitySimilarity[] = [];

  // 1) Exact ID match
  const exactMatch = entities.find((e) => e.id === query);
  if (exactMatch) {
    results.push({ entity_id: exactMatch.id, score: 1.0, matched_terms: ["exact_id"] });
  }

  // 2) Case-insensitive name match
  const queryLower = query.toLowerCase();
  for (const e of entities) {
    if (e.name.toLowerCase() === queryLower && !results.some((r) => r.entity_id === e.id)) {
      results.push({ entity_id: e.id, score: 0.95, matched_terms: ["exact_name"] });
    }
  }

  // 3) TF-IDF similarity
  const tfidfResults = queryTfIdf(query, tfidfDocs);
  for (const r of tfidfResults) {
    if (!results.some((existing) => existing.entity_id === r.entity_id)) {
      results.push(r);
    }
  }

  return results.sort((a, b) => b.score - a.score);
}

// ---------------------------------------------------------------------------
// BFS Subgraph Extraction
// ---------------------------------------------------------------------------

interface SubgraphResult {
  entityIds: Set<string>;
  edges: ValidatedEdge[];
}

function extractSubgraph(
  seedEntityIds: string[],
  validatedEdges: ValidatedEdge[],
  depth: number
): SubgraphResult {
  const visited = new Set<string>(seedEntityIds);
  const includedEdges: ValidatedEdge[] = [];
  let frontier = new Set<string>(seedEntityIds);

  for (let hop = 0; hop < depth; hop++) {
    const nextFrontier = new Set<string>();

    for (const edge of validatedEdges) {
      if (frontier.has(edge.from) && !visited.has(edge.to)) {
        nextFrontier.add(edge.to);
        includedEdges.push(edge);
      } else if (frontier.has(edge.to) && !visited.has(edge.from)) {
        nextFrontier.add(edge.from);
        includedEdges.push(edge);
      } else if (frontier.has(edge.from) && frontier.has(edge.to)) {
        // Both endpoints in frontier — include the edge
        if (!includedEdges.some((e) => e.id === edge.id)) {
          includedEdges.push(edge);
        }
      }
    }

    for (const id of nextFrontier) visited.add(id);
    frontier = nextFrontier;

    if (nextFrontier.size === 0) break;
  }

  return { entityIds: visited, edges: includedEdges };
}

// ---------------------------------------------------------------------------
// Relevance Ranking
// ---------------------------------------------------------------------------

function rankEdges(
  edges: ValidatedEdge[],
  queryTerms: string[],
  totalCycles: number
): ValidatedEdge[] {
  return [...edges].sort((a, b) => {
    // Confidence weighting
    const confDiff = b.confidence - a.confidence;
    // Recency boost
    const aRecency = 1 / (1 + (totalCycles - a.dream_cycle));
    const bRecency = 1 / (1 + (totalCycles - b.dream_cycle));
    const recencyDiff = bRecency - aRecency;
    // Query term overlap in relation/description
    const aOverlap = queryTerms.filter((t) =>
      a.relation.toLowerCase().includes(t) || a.description.toLowerCase().includes(t)
    ).length;
    const bOverlap = queryTerms.filter((t) =>
      b.relation.toLowerCase().includes(t) || b.description.toLowerCase().includes(t)
    ).length;
    const overlapDiff = bOverlap - aOverlap;

    return confDiff * 0.4 + recencyDiff * 0.3 + overlapDiff * 0.3;
  });
}

// ---------------------------------------------------------------------------
// Token-Budgeted Serialization
// ---------------------------------------------------------------------------

interface SerializationInput {
  entities: Array<{ id: string; name: string; description: string }>;
  edges: ValidatedEdge[];
  tensions: TensionSignal[];
  chapters: StoryChapter[];
  mode: GraphRAGMode;
  tokenBudget: number;
}

function serialize(input: SerializationInput): {
  text: string;
  entitiesIncluded: string[];
  edgesIncluded: number;
  tensionsIncluded: number;
  chaptersIncluded: number;
  tokenCount: number;
} {
  const { entities, edges, tensions, chapters, mode, tokenBudget } = input;
  const sections: Array<{ label: string; text: string; priority: number }> = [];

  // Priority order varies by mode
  const priorityMap: Record<GraphRAGMode, { entities: number; edges: number; tensions: number; narrative: number }> = {
    entity_focused: { entities: 1, edges: 2, tensions: 3, narrative: 4 },
    tension_focused: { tensions: 1, entities: 2, edges: 3, narrative: 4 },
    narrative_focused: { narrative: 1, entities: 3, edges: 4, tensions: 2 },
    comprehensive: { entities: 1, edges: 2, tensions: 3, narrative: 4 },
  };
  const priorities = priorityMap[mode];

  // Entities section
  if (entities.length > 0) {
    const entityLines = entities.map((e) => `- **${e.name}** (${e.id}): ${e.description}`);
    sections.push({
      label: "Entities",
      text: `## Entities (${entities.length})\n${entityLines.join("\n")}`,
      priority: priorities.entities,
    });
  }

  // Edges section
  if (edges.length > 0) {
    const edgeLines = edges.map(
      (e) => `- ${e.from} → ${e.to}: ${e.relation} (confidence: ${e.confidence})`
    );
    sections.push({
      label: "Relationships",
      text: `## Relationships (${edges.length})\n${edgeLines.join("\n")}`,
      priority: priorities.edges,
    });
  }

  // Tensions section
  if (tensions.length > 0) {
    const tensionLines = tensions.map(
      (t) => `- [${t.domain}] ${t.description} (urgency: ${t.urgency}, occurrences: ${t.occurrences})`
    );
    sections.push({
      label: "Active Tensions",
      text: `## Active Tensions (${tensions.length})\n${tensionLines.join("\n")}`,
      priority: priorities.tensions,
    });
  }

  // Narrative section
  if (chapters.length > 0) {
    const chapterLines = chapters
      .slice(-5)
      .map((c) => `### ${c.title}\n${c.narrative_text}`);
    sections.push({
      label: "Recent Narrative",
      text: `## Recent Narrative (${Math.min(chapters.length, 5)} chapters)\n${chapterLines.join("\n\n")}`,
      priority: priorities.narrative,
    });
  }

  // Sort by priority (lower = higher priority)
  sections.sort((a, b) => a.priority - b.priority);

  // Assemble within token budget
  let assembled = "# DreamGraph Knowledge Context\n\n";
  let tokenCount = estimateTokens(assembled);
  const includedEntities: string[] = [];
  let includedEdges = 0;
  let includedTensions = 0;
  let includedChapters = 0;

  for (const section of sections) {
    const sectionTokens = estimateTokens(section.text);
    if (tokenCount + sectionTokens <= tokenBudget) {
      assembled += section.text + "\n\n";
      tokenCount += sectionTokens;

      // Track what was included
      if (section.label === "Entities") {
        for (const e of entities) includedEntities.push(e.id);
      } else if (section.label === "Relationships") {
        includedEdges = edges.length;
      } else if (section.label === "Active Tensions") {
        includedTensions = tensions.length;
      } else if (section.label === "Recent Narrative") {
        includedChapters = Math.min(chapters.length, 5);
      }
    } else {
      // Try to fit a truncated version
      const lines = section.text.split("\n");
      let partial = "";
      for (const line of lines) {
        const lineTokens = estimateTokens(line + "\n");
        if (tokenCount + lineTokens <= tokenBudget) {
          partial += line + "\n";
          tokenCount += lineTokens;

          // Track partial inclusions
          if (section.label === "Relationships") includedEdges++;
          else if (section.label === "Active Tensions") includedTensions++;
        } else {
          break;
        }
      }
      if (partial) {
        assembled += partial + "\n";
        if (section.label === "Entities") {
          // Count entity lines included
          const entityLineCount = partial.split("\n").filter((l) => l.startsWith("- **")).length;
          for (let i = 0; i < Math.min(entityLineCount, entities.length); i++) {
            includedEntities.push(entities[i].id);
          }
        }
      }
      // Add note about truncation
      assembled += `[Context note: ${section.label} truncated due to token budget]\n\n`;
      tokenCount += estimateTokens(`[Context note: ${section.label} truncated due to token budget]\n\n`);
    }
  }

  return {
    text: assembled.trimEnd(),
    entitiesIncluded: includedEntities,
    edgesIncluded: includedEdges,
    tensionsIncluded: includedTensions,
    chaptersIncluded: includedChapters,
    tokenCount,
  };
}

// ---------------------------------------------------------------------------
// Public API: graph_rag_retrieve
// ---------------------------------------------------------------------------

export async function graphRagRetrieve(input: GraphRAGQuery): Promise<GraphRAGContext> {
  const start = Date.now();
  const {
    query,
    mode = "comprehensive",
    token_budget = 2000,
    depth = 2,
    include_tensions = true,
    include_narrative = true,
  } = input;

  const route = await selectLlmRoute({
    task: "generic",
    daemon_component: "normalizer",
    daemon_temperature: 0.2,
    max_tokens: Math.min(400, token_budget),
  });

  logger.info(`Graph RAG retrieve: mode=${mode}, budget=${token_budget}, depth=${depth}, query="${query.slice(0, 80)}"`);

  // Load knowledge graph
  const kg = await loadKnowledgeGraph();
  const entities = allEntities(kg);
  const tfidfDocs = buildIndex(entities);

  // 1) Entity resolution
  const resolved = resolveEntities(query, entities, tfidfDocs);
  const topEntities = resolved.slice(0, 10); // Cap at 10 seed entities

  // 2) Mode-specific retrieval
  let seedEntityIds: string[];
  let relevantTensions: TensionSignal[] = [];
  let relevantChapters: StoryChapter[] = [];

  switch (mode) {
    case "entity_focused": {
      seedEntityIds = topEntities.map((e) => e.entity_id);
      if (include_tensions) {
        relevantTensions = kg.tensions.filter((t) =>
          t.entities.some((eid) => seedEntityIds.includes(eid))
        );
      }
      if (include_narrative) {
        relevantChapters = kg.storyChapters.slice(-3);
      }
      break;
    }
    case "tension_focused": {
      // Start from tensions, then find their entities
      const topTensions = [...kg.tensions]
        .sort((a, b) => b.urgency - a.urgency)
        .slice(0, 10);
      relevantTensions = topTensions;
      seedEntityIds = [...new Set(topTensions.flatMap((t) => t.entities))];
      if (include_narrative) {
        relevantChapters = kg.storyChapters.slice(-3);
      }
      break;
    }
    case "narrative_focused": {
      relevantChapters = kg.storyChapters.slice(-10);
      // Extract entity references from recent chapters
      const chapterEntities = new Set<string>();
      for (const ch of relevantChapters) {
        for (const entity of entities) {
          if (ch.narrative_text.includes(entity.id) || ch.narrative_text.includes(entity.name)) {
            chapterEntities.add(entity.id);
          }
        }
      }
      seedEntityIds = [...chapterEntities].slice(0, 10);
      if (include_tensions) {
        relevantTensions = kg.tensions
          .filter((t) => t.entities.some((eid) => seedEntityIds.includes(eid)))
          .slice(0, 5);
      }
      break;
    }
    case "comprehensive":
    default: {
      seedEntityIds = topEntities.slice(0, 5).map((e) => e.entity_id);
      if (include_tensions) {
        relevantTensions = [...kg.tensions]
          .sort((a, b) => b.urgency - a.urgency)
          .slice(0, 5);
        // Add tension entities to seed
        for (const t of relevantTensions) {
          for (const eid of t.entities) {
            if (!seedEntityIds.includes(eid)) seedEntityIds.push(eid);
          }
        }
      }
      if (include_narrative) {
        relevantChapters = kg.storyChapters.slice(-3);
      }
      break;
    }
  }

  // 3) BFS subgraph extraction
  const subgraph = extractSubgraph(seedEntityIds, kg.validatedEdges, depth);

  // 4) Resolve entity details for included IDs
  const includedEntityDetails = entities.filter((e) => subgraph.entityIds.has(e.id));

  // 5) Rank edges
  const queryTerms = tokenize(query);
  const totalCycles = kg.storyChapters.length > 0
    ? Math.max(...kg.storyChapters.map((c) => c.cycle_range[1]))
    : 0;
  const rankedEdges = rankEdges(subgraph.edges, queryTerms, totalCycles);

  // 6) Token-budgeted serialization
  const serialized = serialize({
    entities: includedEntityDetails,
    edges: rankedEdges,
    tensions: relevantTensions,
    chapters: relevantChapters,
    mode,
    tokenBudget: token_budget,
  });

  const futureEvidence: TaskPreambleEvidenceItem[] = [
    ...topEntities.slice(0, 5).map((entity) => ({
      anchor: entity.entity_id,
      kind: "graph_entity" as const,
      summary: `Resolved query entity ${entity.entity_id} with relevance ${entity.score.toFixed(2)}.`,
      confidence: roundFutureFitScore(entity.score),
      priority: roundFutureFitScore(entity.score),
    })),
    ...relevantTensions.slice(0, 3).map((tension) => ({
      anchor: tension.id,
      kind: "tension" as const,
      summary: tension.description,
      confidence: roundFutureFitScore(tension.urgency),
      priority: roundFutureFitScore(tension.urgency),
    })),
  ];

  const validationFailures = futureEvidence.flatMap((item) => {
    const failures: string[] = [];
    if (!evidenceAnchorIsValid(item.anchor)) failures.push(`invalid_anchor:${item.anchor}`);
    if (!item.summary.trim()) failures.push(`empty_summary:${item.anchor}`);
    if (item.confidence < 0 || item.confidence > 1) failures.push(`invalid_confidence:${item.anchor}`);
    return failures;
  });

  const rankedFutureEvidence = validationFailures.length > 0
    ? []
    : futureEvidence
      .map((item) => ({ item, relevance: taskRelevance(query, item) }))
      .filter(({ item, relevance }) => item.confidence >= 0.5 && relevance >= 0.12)
      .sort((a, b) => (b.item.priority + b.relevance) - (a.item.priority + a.relevance));

  const advisoryBudget = Math.min(180, Math.max(96, Math.floor(token_budget * 0.2)));
  const selectedFutureEvidence: TaskPreambleEvidenceItem[] = [];
  for (const { item } of rankedFutureEvidence) {
    const candidate = formatTaskPreambleEvidence([...selectedFutureEvidence, item]);
    if (estimateTokens(candidate) <= advisoryBudget) selectedFutureEvidence.push(item);
  }

  const weakTopEntity = topEntities[0] && topEntities[0].score < 0.2 ? topEntities[0] : null;
  const futureObjections = [
    weakTopEntity
      ? {
        id: `weak-resolution-${weakTopEntity.entity_id}`,
        description: "Entity resolution confidence is weak, so adaptive future ranking should not narrate speculative follow-up as fact.",
        evidence_anchor_ids: [weakTopEntity.entity_id],
        severity: "high" as const,
      }
      : null,
    serialized.tokenCount >= token_budget && selectedFutureEvidence[0]
      ? {
        id: "context-budget-trim",
        description: "Context serialization reached the token budget, so lower-priority adaptive future evidence was omitted.",
        evidence_anchor_ids: [selectedFutureEvidence[0].anchor],
        severity: "medium" as const,
      }
      : null,
  ].filter((objection): objection is NonNullable<typeof objection> => objection !== null);

  const nextSteps = selectedFutureEvidence.slice(0, 3).map((item) => ({
    id: `follow-${item.anchor}`,
    label: item.kind === "tension" ? "Investigate active tension" : "Inspect resolved entity",
    rationale: item.summary,
    evidence_anchor_ids: [item.anchor],
    future_fit_score: roundFutureFitScore((item.priority + taskRelevance(query, item)) / 2),
  }));

  const omittedContextReasons: string[] = [];
  if (validationFailures.length > 0) {
    omittedContextReasons.push("future-fit evidence failed anchor or schema validation");
  } else if (futureEvidence.length === 0) {
    omittedContextReasons.push("no bounded graph evidence survived entity and tension assembly");
  } else if (rankedFutureEvidence.length === 0) {
    omittedContextReasons.push("future-fit evidence was too weak or irrelevant to rank");
  } else if (selectedFutureEvidence.length === 0) {
    omittedContextReasons.push("future-fit evidence exceeded the advisory token budget");
  }

  const adaptiveFuture = {
    surface: "graph_rag_retrieve" as const,
    advisory_generation: "deterministic" as const,
    selected_model_layer: route.layer,
    selected_model_provider: route.provenance.provider,
    selected_model: route.provenance.model,
    fallback_reason: route.provenance.fallback_reason,
    summary: nextSteps.length > 0
      ? `Ranked ${nextSteps.length} evidence-backed next step(s) for ${mode} retrieval.`
      : `No evidence-backed adaptive future next step qualified for ${mode} retrieval.`,
    evidence_anchors: uniqueEvidenceAnchors([
      ...nextSteps.flatMap((step) => step.evidence_anchor_ids),
      ...futureObjections.flatMap((objection) => objection.evidence_anchor_ids),
    ]),
    next_steps: nextSteps,
    future_objections: futureObjections,
    omitted_context_reasons: omittedContextReasons,
    validation_failures: [...new Set(validationFailures)],
  };

  const duration = Date.now() - start;
  logger.info(`Graph RAG complete: ${serialized.entitiesIncluded.length} entities, ${serialized.edgesIncluded} edges, ${serialized.tokenCount} tokens, ${duration}ms`);

  return {
    context_text: serialized.text,
    entities_included: serialized.entitiesIncluded,
    edges_included: serialized.edgesIncluded,
    tensions_included: serialized.tensionsIncluded,
    narrative_chapters_included: serialized.chaptersIncluded,
    token_count: serialized.tokenCount,
    retrieval_mode: mode,
    relevance_scores: topEntities.map((e) => ({ entity_id: e.entity_id, score: e.score })),
    adaptive_future: adaptiveFuture,
  };
}

// ---------------------------------------------------------------------------
// Public API: Task Preamble Compiler
// ---------------------------------------------------------------------------

function evidenceAnchorIsValid(anchor: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9_.:/#-]{1,160}$/.test(anchor);
}

function taskRelevance(task: string, evidence: TaskPreambleEvidenceItem): number {
  const taskTerms = new Set(tokenize(task));
  if (taskTerms.size === 0) return 0;

  const evidenceTerms = tokenize(`${evidence.anchor} ${evidence.summary}`);
  const matches = evidenceTerms.filter((term) => taskTerms.has(term)).length;
  return Math.min(1, matches / Math.max(4, taskTerms.size));
}

function formatTaskPreambleEvidence(evidence: TaskPreambleEvidenceItem[]): string {
  return [
    "DreamGraph task preamble:",
    ...evidence.map((item) => `- [${item.kind}] ${item.anchor}: ${item.summary}`),
  ].join("\n");
}

async function assembleTaskPreambleEvidence(task: string): Promise<TaskPreambleEvidenceItem[]> {
  const kg = await loadKnowledgeGraph();
  const taskTerms = new Set(tokenize(task));

  const entityEvidence: TaskPreambleEvidenceItem[] = allEntities(kg)
    .map((entity) => ({
      anchor: entity.id,
      kind: entity.id.startsWith("workflow_") ? "workflow" : "graph_entity",
      summary: entity.description,
      confidence: 0.8,
      priority: taskRelevance(task, {
        anchor: entity.id,
        kind: "graph_entity",
        summary: entity.description,
        confidence: 0.8,
        priority: 0,
      }),
    } satisfies TaskPreambleEvidenceItem))
    .filter((item) => item.priority > 0 || tokenize(item.anchor).some((term) => taskTerms.has(term)))
    .sort((a, b) => b.priority - a.priority)
    .slice(0, 5);

  const tensionEvidence: TaskPreambleEvidenceItem[] = kg.tensions
    .filter((tension) => tension.entities.some((entityId) => entityEvidence.some((item) => item.anchor === entityId)))
    .sort((a, b) => b.urgency - a.urgency)
    .slice(0, 3)
    .map((tension) => ({
      anchor: tension.id,
      kind: "tension",
      summary: tension.description,
      confidence: tension.urgency,
      priority: tension.urgency,
    }));

  return [...entityEvidence, ...tensionEvidence];
}

/**
 * Compile bounded graph-grounded task context before provider/adapter execution.
 * The compiler never requires an LLM; no-provider and uneconomical cases return no added preamble.
 */
export async function compileTaskPreamble(request: TaskPreambleCompileRequest): Promise<CompiledTaskPreamble> {
  const route = await selectLlmRoute({
    task: "task_preamble_compilation",
    daemon_component: "normalizer",
    daemon_temperature: 0.2,
    max_tokens: request.max_tokens ?? 300,
  });

  const maxTokens = request.max_tokens ?? 300;
  const minRelevance = request.min_relevance ?? 0.12;
  const minExpectedSavings = request.min_expected_savings_tokens ?? 64;
  const evidence = request.evidence ?? await assembleTaskPreambleEvidence(request.task);
  const validationFailures = evidence.flatMap((item) => {
    const failures: string[] = [];
    if (!evidenceAnchorIsValid(item.anchor)) failures.push(`invalid_anchor:${item.anchor}`);
    if (!item.summary.trim()) failures.push(`empty_summary:${item.anchor}`);
    if (item.confidence < 0 || item.confidence > 1) failures.push(`invalid_confidence:${item.anchor}`);
    return failures;
  });

  if (validationFailures.length > 0) {
    return {
      preamble_text: "",
      evidence_anchors: [],
      token_count: 0,
      budget_decision: "omit_validation_failed",
      omitted_context_reasons: ["evidence failed schema or anchor validation"],
      validation_failures: validationFailures,
      selected_model_layer: route.layer,
      selected_model_provider: route.provenance.provider,
      selected_model: route.provenance.model,
      fallback_reason: route.provenance.fallback_reason,
    };
  }

  const ranked = evidence
    .map((item) => ({ item, relevance: taskRelevance(request.task, item) }))
    .filter(({ item, relevance }) => item.confidence >= 0.5 && relevance >= minRelevance)
    .sort((a, b) => (b.item.priority + b.relevance) - (a.item.priority + a.relevance));

  if (ranked.length === 0) {
    return {
      preamble_text: "",
      evidence_anchors: [],
      token_count: 0,
      budget_decision: evidence.length === 0 ? "omit_no_evidence" : "omit_not_economical",
      omitted_context_reasons: evidence.length === 0 ? ["no bounded evidence assembled"] : ["assembled evidence was not relevant enough to justify prompt cost"],
      validation_failures: [],
      selected_model_layer: route.layer,
      selected_model_provider: route.provenance.provider,
      selected_model: route.provenance.model,
      fallback_reason: route.provenance.fallback_reason,
    };
  }

  const selected: TaskPreambleEvidenceItem[] = [];
  for (const { item } of ranked) {
    const candidate = formatTaskPreambleEvidence([...selected, item]);
    if (estimateTokens(candidate) <= maxTokens) selected.push(item);
  }

  if (selected.length === 0) {
    return {
      preamble_text: "",
      evidence_anchors: [],
      token_count: 0,
      budget_decision: "omit_over_budget",
      omitted_context_reasons: ["bounded evidence exceeded prompt budget"],
      validation_failures: [],
      selected_model_layer: route.layer,
      selected_model_provider: route.provenance.provider,
      selected_model: route.provenance.model,
      fallback_reason: route.provenance.fallback_reason,
    };
  }

  const preambleText = formatTaskPreambleEvidence(selected);
  const tokenCount = estimateTokens(preambleText);
  if (minExpectedSavings > 0 && tokenCount > minExpectedSavings) {
    return {
      preamble_text: "",
      evidence_anchors: [],
      token_count: 0,
      budget_decision: "omit_not_economical",
      omitted_context_reasons: ["compiled context cost exceeded expected avoided scanning or cognition cost"],
      validation_failures: [],
      selected_model_layer: route.layer,
      selected_model_provider: route.provenance.provider,
      selected_model: route.provenance.model,
      fallback_reason: route.provenance.fallback_reason,
    };
  }

  return {
    preamble_text: preambleText,
    evidence_anchors: selected.map((item) => item.anchor),
    token_count: tokenCount,
    budget_decision: "include",
    omitted_context_reasons: [],
    validation_failures: [],
    selected_model_layer: route.layer,
    selected_model_provider: route.provenance.provider,
    selected_model: route.provenance.model,
    fallback_reason: route.provenance.fallback_reason,
  };
}

// ---------------------------------------------------------------------------
// Public API: get_cognitive_preamble
// ---------------------------------------------------------------------------

export async function getCognitivePreamble(maxTokens: number = 500): Promise<CognitivePreamble> {
  logger.info(`Generating cognitive preamble: max_tokens=${maxTokens}`);

  const route = await selectLlmRoute({
    task: "generic",
    daemon_component: "normalizer",
    daemon_temperature: 0.2,
    max_tokens: Math.min(320, maxTokens),
  });

  const kg = await loadKnowledgeGraph();

  // System summary from overview
  let systemSummary = "DreamGraph knowledge graph context.";
  try {
    const overviewPath = dataPath("system_overview.json");
    if (existsSync(overviewPath)) {
      const raw = await readFile(overviewPath, "utf-8");
      const overview = JSON.parse(raw);
      const name = overview?.name ?? overview?.id ?? "System";
      const desc = overview?.description ?? "";
      systemSummary = `${name}: ${desc}. Knowledge graph contains ${kg.features.length} features, ${kg.workflows.length} workflows, ${kg.dataModels.length} data models, and ${kg.validatedEdges.length} validated connections.`;
    }
  } catch {
    /* use default */
  }

  // Top architecture — highest confidence validated edges
  const topEdges = [...kg.validatedEdges]
    .sort((a, b) => b.confidence - a.confidence)
    .slice(0, 5);
  const keyArchitecture = topEdges.map(
    (e) => `${e.from} → ${e.to}: ${e.relation} (confidence: ${e.confidence})`
  );

  // Open questions — top tensions by urgency
  const topTensions = [...kg.tensions]
    .sort((a, b) => b.urgency - a.urgency)
    .slice(0, 3);
  const openQuestions = topTensions.map(
    (t) => `[${t.domain}] ${t.description} (urgency: ${t.urgency})`
  );

  // Recent insights — latest story chapters
  const recentChapters = kg.storyChapters.slice(-3);
  const recentInsights = recentChapters.map(
    (c) => `${c.title}: ${c.key_discoveries.slice(0, 2).join("; ")}`
  );

  // Assemble and trim to budget
  const parts = [systemSummary, ...keyArchitecture, ...openQuestions, ...recentInsights];
  const originalPartCount = parts.length;
  let assembled = parts.join("\n");
  let tokenCount = estimateTokens(assembled);

  // Trim from the end if over budget
  while (tokenCount > maxTokens && parts.length > 1) {
    parts.pop();
    assembled = parts.join("\n");
    tokenCount = estimateTokens(assembled);
  }

  const trimmedForBudget = parts.length < originalPartCount;
  const futureEvidence: TaskPreambleEvidenceItem[] = [
    ...topTensions.map((tension) => ({
      anchor: tension.id,
      kind: "tension" as const,
      summary: tension.description,
      confidence: roundFutureFitScore(tension.urgency),
      priority: roundFutureFitScore(tension.urgency),
    })),
    ...topEdges.slice(0, 3).map((edge) => ({
      anchor: edge.from,
      kind: "graph_entity" as const,
      summary: `Validated architecture relation ${edge.relation} to ${edge.to}.`,
      confidence: roundFutureFitScore(edge.confidence),
      priority: roundFutureFitScore(edge.confidence),
    })),
  ];

  const validationFailures = futureEvidence.flatMap((item) => {
    const failures: string[] = [];
    if (!evidenceAnchorIsValid(item.anchor)) failures.push(`invalid_anchor:${item.anchor}`);
    if (!item.summary.trim()) failures.push(`empty_summary:${item.anchor}`);
    return failures;
  });

  const rankedFutureEvidence = validationFailures.length > 0
    ? []
    : [...futureEvidence]
      .filter((item) => item.confidence >= 0.5)
      .sort((a, b) => b.priority - a.priority);

  const advisoryBudget = Math.min(140, Math.max(72, Math.floor(maxTokens * 0.18)));
  const selectedFutureEvidence: TaskPreambleEvidenceItem[] = [];
  for (const item of rankedFutureEvidence) {
    const candidate = formatTaskPreambleEvidence([...selectedFutureEvidence, item]);
    if (estimateTokens(candidate) <= advisoryBudget) selectedFutureEvidence.push(item);
  }

  const nextSteps = selectedFutureEvidence.slice(0, 3).map((item) => ({
    id: `preamble-${item.anchor}`,
    label: item.kind === "tension" ? "Investigate open question" : "Inspect key architecture edge",
    rationale: item.summary,
    evidence_anchor_ids: [item.anchor],
    future_fit_score: item.priority,
  }));

  const futureObjections = [
    trimmedForBudget && selectedFutureEvidence[0]
      ? {
        id: "preamble-budget-trim",
        description: "The cognitive preamble hit its token budget, so lower-priority adaptive future context was omitted.",
        evidence_anchor_ids: [selectedFutureEvidence[0].anchor],
        severity: "medium" as const,
      }
      : null,
    topTensions[0] && topTensions[0].urgency >= 0.85
      ? {
        id: `urgent-open-question-${topTensions[0].id}`,
        description: "An urgent unresolved tension is shaping the preamble and should be treated as an objection against overconfident narration.",
        evidence_anchor_ids: [topTensions[0].id],
        severity: "high" as const,
      }
      : null,
  ].filter((objection): objection is NonNullable<typeof objection> => objection !== null);

  const omittedContextReasons: string[] = [];
  if (validationFailures.length > 0) {
    omittedContextReasons.push("future-fit evidence failed anchor or summary validation");
  } else if (rankedFutureEvidence.length === 0) {
    omittedContextReasons.push("no bounded preamble evidence qualified for adaptive future ranking");
  } else if (selectedFutureEvidence.length === 0) {
    omittedContextReasons.push("adaptive future preamble evidence exceeded the advisory token budget");
  }

  return {
    system_summary: systemSummary,
    key_architecture: keyArchitecture,
    open_questions: openQuestions,
    recent_insights: recentInsights,
    token_count: estimateTokens(
      [systemSummary, ...keyArchitecture, ...openQuestions, ...recentInsights].join("\n")
    ),
    adaptive_future: {
      surface: "get_cognitive_preamble" as const,
      advisory_generation: "deterministic" as const,
      selected_model_layer: route.layer,
      selected_model_provider: route.provenance.provider,
      selected_model: route.provenance.model,
      fallback_reason: route.provenance.fallback_reason,
      summary: nextSteps.length > 0
        ? `Ranked ${nextSteps.length} evidence-backed next step(s) from open questions and validated architecture.`
        : "No evidence-backed adaptive future next step qualified for the cognitive preamble.",
      evidence_anchors: uniqueEvidenceAnchors([
        ...nextSteps.flatMap((step) => step.evidence_anchor_ids),
        ...futureObjections.flatMap((objection) => objection.evidence_anchor_ids),
      ]),
      next_steps: nextSteps,
      future_objections: futureObjections,
      omitted_context_reasons: omittedContextReasons,
      validation_failures: [...new Set(validationFailures)],
    },
  };
}
