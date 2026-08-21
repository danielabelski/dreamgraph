/**
 * Evidence-based cognitive health assessment for the active DreamGraph instance.
 * This is intentionally read-only: recommendations name governed MCP actions but
 * never execute maintenance without the user's approval.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readFile, stat } from "node:fs/promises";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import { config } from "../config/config.js";
import { dataPath } from "../utils/paths.js";
import { logger } from "../utils/logger.js";
import { withGraphRead } from "../utils/graph-reconciliation-barrier.js";
import { safeExecute, success } from "../utils/errors.js";
import type { ToolResponse, UIRegistryFile } from "../types/index.js";
import type { CandidateEdgesFile, TensionFile, ValidatedEdgesFile } from "../cognitive/types.js";
import {
  datastoreConnectionFingerprint,
  loadGraphMaintenanceState,
  type GraphMaintenanceState,
} from "../cognitive/graph-maintenance-state.js";
import { loadScanState } from "./scan-state.js";
import { summarizeCoverage } from "./coverage-ledger.js";

const execFileAsync = promisify(execFile);
const HOLLOW_DESCRIPTION = /\b\d+\s+source file\(s\)|generated assembly|detected by (?:the )?scanner|auto-created from datastore introspection|declared in .+\(line \d+\)/i;
const DEFAULT_SCAN_STALE_HOURS = 24;
const DEFAULT_ENRICHMENT_STALE_HOURS = 7 * 24;
const DEFAULT_MAJOR_CHANGE_FILES = 20;

type CanonicalKind = "feature" | "workflow" | "data_model" | "capability" | "datastore" | "ui_element" | "auxiliary";

interface CanonicalNode extends Record<string, unknown> {
  id: string;
  name: string;
  description?: string;
  kind: CanonicalKind;
  links?: Array<{ target?: string; relationship?: string }>;
  enrichment?: { enriched?: boolean; enriched_at?: string };
}

export interface GraphHealthMetric {
  value: number;
  total: number;
  ratio: number;
  applicable: boolean;
}

export interface GraphHealthObservation {
  signal: string;
  severity: "info" | "warning" | "critical";
  observed: string;
  reasoning_impact: string;
}

export interface GraphMaintenanceRecommendation {
  priority: number;
  action: string;
  tool: string;
  arguments: Record<string, unknown>;
  reason: string;
  expected_improvement: string;
  requires_user_approval: true;
}

export interface GraphHealthReport {
  schema: "dreamgraph.graph_health.v1";
  generated_at: string;
  status: "excellent" | "healthy" | "needs_attention" | "poor" | "empty";
  score: number;
  quality_principle: string;
  thresholds: {
    scan_stale_hours: number;
    enrichment_stale_hours: number;
    major_repository_change_files: number;
  };
  inventory: Record<CanonicalKind, number> & { total: number };
  metrics: {
    semantic_density: number;
    enriched_nodes: GraphHealthMetric;
    enrichment_debt: {
      scan_revision: string | null;
      eligible: number;
      pending: number;
      failed_retryable: number;
      failed_terminal: number;
      skipped: number;
    };
    parser_only_nodes: number;
    hollow_descriptions: number;
    machine_name_leakage: number;
    contract_coverage: GraphHealthMetric;
    workflow_coverage: GraphHealthMetric;
    datastore_coverage: GraphHealthMetric;
    ui_coverage: GraphHealthMetric;
    linked_nodes: GraphHealthMetric;
    orphan_features: number;
    disconnected_feature_clusters: number;
    unresolved_tensions: number;
    dream_promotion_rate: number;
    dream_candidates: number;
    scan_age_hours: number | null;
    enrichment_age_hours: number | null;
    modified_repository_files: number;
    commits_since_scan: number;
    datastore_configuration_changed: boolean;
  };
  observations: GraphHealthObservation[];
  recommendations: GraphMaintenanceRecommendation[];
  primary_recommendation: GraphMaintenanceRecommendation | null;
  maintenance_state: GraphMaintenanceState;
}

function envPositive(name: string, fallback: number): number {
  const parsed = Number(process.env[name]);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

async function readJson<T>(filename: string, fallback: T): Promise<T> {
  try {
    return JSON.parse(await readFile(dataPath(filename), "utf-8")) as T;
  } catch {
    return fallback;
  }
}

function realEntries(value: unknown): Array<Record<string, unknown>> {
  if (!Array.isArray(value)) return [];
  return value.filter((entry): entry is Record<string, unknown> =>
    Boolean(entry) && typeof entry === "object" && !("_schema" in entry) && !("_note" in entry));
}

function asCanonical(entries: Array<Record<string, unknown>>, kind: CanonicalKind): CanonicalNode[] {
  return entries
    .filter((entry) => typeof entry.id === "string" && entry.id.length > 0)
    .map((entry) => ({
      ...entry,
      id: String(entry.id),
      name: typeof entry.name === "string" ? entry.name : String(entry.id),
      description: typeof entry.description === "string" ? entry.description : undefined,
      kind,
    } as CanonicalNode));
}

function metric(value: number, total: number, applicable = true): GraphHealthMetric {
  return { value, total, ratio: total > 0 ? value / total : applicable ? 0 : 1, applicable };
}

function hasText(value: unknown, min = 1): boolean {
  return typeof value === "string" && value.trim().length >= min;
}

function arrayHas(value: unknown): boolean {
  return Array.isArray(value) && value.length > 0;
}

function isRichDescription(node: CanonicalNode): boolean {
  return hasText(node.description, 80) && !HOLLOW_DESCRIPTION.test(node.description ?? "");
}

function hasContract(node: CanonicalNode): boolean {
  if (node.kind === "ui_element") {
    const contract = node.data_contract as { inputs?: unknown[]; outputs?: unknown[] } | undefined;
    return Boolean(contract && (arrayHas(contract.inputs) || arrayHas(contract.outputs)));
  }
  if (node.kind === "workflow") return arrayHas(node.steps);
  if (node.kind === "data_model") return arrayHas(node.key_fields) || arrayHas(node.relationships);
  if (node.kind === "datastore") return arrayHas(node.tables);
  return hasText(node.intent, 24) || arrayHas(node.links);
}

function semanticScore(node: CanonicalNode): number {
  let score = 0;
  if (isRichDescription(node)) score += 0.3;
  if (hasText(node.intent, 24)) score += 0.2;
  if (hasText(node.purpose, 3) || hasText(node.domain, 3) || hasText(node.category, 3)) score += 0.1;
  if (arrayHas(node.links) || arrayHas(node.used_by) || arrayHas(node.flows) || arrayHas(node.relationships)) score += 0.2;
  if (hasContract(node)) score += 0.1;
  if (arrayHas(node.tags) || arrayHas(node.keywords)) score += 0.1;
  return Math.min(1, score);
}

function looksMachineNamed(node: CanonicalNode): boolean {
  const name = node.name.trim();
  if (!name) return true;
  // A humanized label such as "MCP Server" legitimately normalizes to the
  // id "mcp-server"; only expose the leak when the display label itself is
  // still a slug, path, filename, or explicit generator placeholder.
  return /^[a-z0-9]+(?:[_-][a-z0-9]+){1,}$/.test(name)
    || /[/\\]|\.[a-z0-9]{1,5}$/i.test(name)
    || /^(generated|unknown|unnamed|scanner)(?:[_ -]|$)/i.test(name);
}

function isParserOnly(node: CanonicalNode): boolean {
  const provenance = node.provenance as { scanner?: unknown } | undefined;
  const scanner = typeof provenance?.scanner === "string" ? provenance.scanner : node.source_kind;
  return ["native", "scanner", "datastore"].includes(String(scanner ?? "")) && node.enrichment?.enriched !== true;
}

function isoAgeHours(value: string | null | undefined): number | null {
  if (!value) return null;
  const time = Date.parse(value);
  return Number.isFinite(time) ? Math.max(0, (Date.now() - time) / 3_600_000) : null;
}

async function newestMtimeIso(filenames: string[]): Promise<string | null> {
  const times = await Promise.all(filenames.map(async (filename) => {
    try { return (await stat(dataPath(filename))).mtimeMs; } catch { return 0; }
  }));
  const latest = Math.max(0, ...times);
  return latest > 0 ? new Date(latest).toISOString() : null;
}

async function repositoryDrift(state: GraphMaintenanceState): Promise<{ modified: number; commits: number; heads: Record<string, string> }> {
  let modified = 0;
  let commits = 0;
  const heads: Record<string, string> = {};
  for (const [repo, root] of Object.entries(config.repos)) {
    try {
      const [{ stdout: statusOut }, { stdout: headOut }] = await Promise.all([
        execFileAsync("git", ["-C", root, "status", "--porcelain", "--untracked-files=normal"], { timeout: 5_000, windowsHide: true }),
        execFileAsync("git", ["-C", root, "rev-parse", "HEAD"], { timeout: 5_000, windowsHide: true }),
      ]);
      modified += statusOut.split(/\r?\n/).filter(Boolean).length;
      const head = headOut.trim();
      if (/^[0-9a-f]{7,40}$/i.test(head)) heads[repo] = head;
      const prior = state.last_scan_git_heads[repo];
      if (prior && /^[0-9a-f]{7,40}$/i.test(prior) && head && prior !== head) {
        const { stdout } = await execFileAsync("git", ["-C", root, "rev-list", "--count", `${prior}..${head}`], { timeout: 5_000, windowsHide: true });
        commits += Number.parseInt(stdout.trim(), 10) || 0;
      }
    } catch {
      // A configured repo need not be a Git worktree; health remains usable.
    }
  }
  return { modified, commits, heads };
}

function connectivity(nodes: CanonicalNode[]): { linked: number; orphanFeatures: number; featureClusters: number } {
  const known = new Set(nodes.map((node) => node.id));
  const adjacency = new Map<string, Set<string>>();
  const connect = (a: string, b: string): void => {
    if (!known.has(a) || !known.has(b) || a === b) return;
    const aa = adjacency.get(a) ?? new Set<string>(); aa.add(b); adjacency.set(a, aa);
    const bb = adjacency.get(b) ?? new Set<string>(); bb.add(a); adjacency.set(b, bb);
  };
  for (const node of nodes) {
    for (const link of Array.isArray(node.links) ? node.links : []) if (link?.target) connect(node.id, link.target);
    for (const field of [node.used_by, node.children, node.flows]) {
      if (Array.isArray(field)) for (const target of field) if (typeof target === "string") connect(node.id, target);
    }
  }
  const features = nodes.filter((node) => node.kind === "feature");
  const orphanFeatures = features.filter((node) => (adjacency.get(node.id)?.size ?? 0) === 0).length;
  const visited = new Set<string>();
  let featureClusters = 0;
  for (const feature of features) {
    if (visited.has(feature.id)) continue;
    featureClusters++;
    const queue = [feature.id];
    visited.add(feature.id);
    while (queue.length > 0) {
      const current = queue.shift()!;
      for (const next of adjacency.get(current) ?? []) {
        if (!visited.has(next)) { visited.add(next); queue.push(next); }
      }
    }
  }
  return { linked: nodes.filter((node) => (adjacency.get(node.id)?.size ?? 0) > 0).length, orphanFeatures, featureClusters };
}

function recommendation(
  priority: number,
  action: string,
  tool: string,
  args: Record<string, unknown>,
  reason: string,
  expected: string,
): GraphMaintenanceRecommendation {
  return { priority, action, tool, arguments: args, reason, expected_improvement: expected, requires_user_approval: true };
}

export async function assessGraphHealth(): Promise<GraphHealthReport> {
  return withGraphRead(assessGraphHealthUnlocked);
}

async function assessGraphHealthUnlocked(): Promise<GraphHealthReport> {
  const [
    featuresRaw, workflowsRaw, dataModelRaw, capabilitiesRaw, datastoresRaw,
    auxiliaryRaw, uiRaw, candidates, validated, tensions, state,
  ] = await Promise.all([
    readJson<unknown[]>("features.json", []),
    readJson<unknown[]>("workflows.json", []),
    readJson<unknown[]>("data_model.json", []),
    readJson<unknown[]>("capabilities.json", []),
    readJson<unknown[]>("datastores.json", []),
    readJson<{ entries?: unknown[] }>("auxiliary_entities.json", {}),
    readJson<UIRegistryFile>("ui_registry.json", { metadata: { description: "", schema_version: "", total_elements: 0, total_categories: 0, last_updated: null }, elements: [] }),
    readJson<CandidateEdgesFile>("candidate_edges.json", { metadata: { description: "", schema_version: "", last_normalization: null, total_cycles: 0, created_at: "" }, results: [] }),
    readJson<ValidatedEdgesFile>("validated_edges.json", { metadata: { description: "", schema_version: "", last_validation: null, total_validated: 0, created_at: "" }, edges: [] }),
    readJson<TensionFile>("tension_log.json", { metadata: { description: "", schema_version: "", total_signals: 0, total_resolved: 0, last_updated: null }, signals: [], resolved_tensions: [] }),
    loadGraphMaintenanceState(),
  ]);

  const uiEntries = realEntries(uiRaw.elements).filter((entry) => hasText(entry.source_repo));
  const groups: Record<CanonicalKind, CanonicalNode[]> = {
    feature: asCanonical(realEntries(featuresRaw), "feature"),
    workflow: asCanonical(realEntries(workflowsRaw), "workflow"),
    data_model: asCanonical(realEntries(dataModelRaw), "data_model"),
    capability: asCanonical(realEntries(capabilitiesRaw), "capability"),
    datastore: asCanonical(realEntries(datastoresRaw), "datastore"),
    ui_element: asCanonical(uiEntries, "ui_element"),
    auxiliary: asCanonical(realEntries(auxiliaryRaw.entries), "auxiliary"),
  };
  const nodes = Object.values(groups).flat();
  const total = nodes.length;
  const scanStaleHours = envPositive("DREAMGRAPH_GRAPH_STALE_HOURS", DEFAULT_SCAN_STALE_HOURS);
  const enrichmentStaleHours = envPositive("DREAMGRAPH_ENRICHMENT_STALE_HOURS", DEFAULT_ENRICHMENT_STALE_HOURS);
  const majorChangeFiles = envPositive("DREAMGRAPH_MAJOR_REPOSITORY_CHANGE_FILES", DEFAULT_MAJOR_CHANGE_FILES);
  const fallbackTimestamp = await newestMtimeIso(["features.json", "workflows.json", "data_model.json", "ui_registry.json", "auxiliary_entities.json"]);
  const lastEnrichment = state.last_enrichment_at ?? nodes
    .map((node) => node.enrichment?.enriched_at)
    .filter((value): value is string => Boolean(value))
    .sort()
    .at(-1) ?? null;
  const scanAge = isoAgeHours(state.last_scan_at ?? fallbackTimestamp);
  const enrichmentAge = isoAgeHours(lastEnrichment);
  const drift = await repositoryDrift(state);
  const currentDbFingerprint = datastoreConnectionFingerprint(config.database.connectionString || process.env.DATABASE_URL);
  const databaseChanged = currentDbFingerprint !== null && currentDbFingerprint !== state.datastore_connection_fingerprint;

  const scanBaseline = await loadScanState();
  const coverage = scanBaseline.status === "compatible" ? scanBaseline.state?.coverage_ledger : undefined;
  const coverageSummary = coverage ? summarizeCoverage(coverage) : null;
  const eligibleCoverageNodes = coverage ? Object.values(coverage.nodes).filter((node) => node.eligible) : [];
  const enrichedCount = coverageSummary?.enriched ?? nodes.filter((node) => node.enrichment?.enriched === true).length;
  const enrichmentDenominator = coverageSummary?.eligible ?? total;
  const parserOnly = nodes.filter(isParserOnly).length;
  const hollow = nodes.filter((node) => !isRichDescription(node)).length;
  const machineNames = nodes.filter(looksMachineNamed).length;
  const semanticDensity = total > 0 ? nodes.reduce((sum, node) => sum + semanticScore(node), 0) / total : 0;
  const uiNodes = groups.ui_element;
  const contractCount = uiNodes.filter(hasContract).length;
  const richUiCount = uiNodes.filter((node) =>
    isRichDescription(node) && hasText(node.intent, 24) && hasContract(node) &&
    Array.isArray(node.interactions) && Boolean(node.visual_semantics) && Boolean(node.layout_semantics)).length;
  const workflowCount = groups.workflow.filter((node) => arrayHas(node.steps) && isRichDescription(node)).length;
  const dbConfigured = currentDbFingerprint !== null;
  const scannedStores = groups.datastore.filter((node) => arrayHas(node.tables) && hasText(node.last_scanned_at)).length;
  const storedModels = groups.data_model.filter((node) =>
    (Array.isArray(node.links) && node.links.some((link) => link.relationship === "stored_in")) || hasText(node.storage)).length;
  const datastoreCovered = scannedStores + storedModels;
  const datastoreTotal = groups.datastore.length + groups.data_model.filter((node) => hasText(node.table_name) || hasText(node.storage)).length;
  const connected = connectivity(nodes);
  const unresolvedTensions = tensions.signals.filter((signal) => !signal.resolved).length;
  const promotionBase = candidates.results.length;
  const promotedCandidates = candidates.results.filter((result) => result.status === "validated").length || validated.edges.length;
  const promotionRate = promotionBase > 0 ? Math.min(1, promotedCandidates / promotionBase) : 0;
  const linkedMetric = metric(connected.linked, total, total > 0);
  const enrichedMetric = metric(enrichedCount, enrichmentDenominator, enrichmentDenominator > 0);
  const contractMetric = metric(contractCount, uiNodes.length, uiNodes.length > 0);
  const workflowMetric = metric(workflowCount, groups.workflow.length, groups.workflow.length > 0);
  const datastoreMetric = metric(datastoreCovered, datastoreTotal, dbConfigured);
  const uiMetric = metric(richUiCount, uiNodes.length, uiNodes.length > 0);

  const observations: GraphHealthObservation[] = [];
  const observe = (signal: string, severity: GraphHealthObservation["severity"], observed: string, impact: string): void => {
    observations.push({ signal, severity, observed, reasoning_impact: impact });
  };
  if (total === 0) observe("empty_graph", "critical", "No canonical graph nodes are present.", "Architectural planning and retrieval have no project model to ground decisions.");
  if (parserOnly > 0) observe("parser_only_nodes", parserOnly / Math.max(total, 1) > 0.2 ? "critical" : "warning", `${parserOnly} parser-origin nodes lack successful LLM enrichment.`, "Mechanical nodes bias retrieval toward syntax and filenames instead of intent and responsibility.");
  if (enrichedCount < enrichmentDenominator && enrichmentDenominator > 0) {
    const debt = enrichmentDenominator - enrichedCount;
    observe(
      "unenriched_eligible_nodes",
      enrichedCount / enrichmentDenominator < 0.7 ? "critical" : "warning",
      `${debt}/${enrichmentDenominator} enrichment-eligible nodes remain unresolved for ${coverage?.revision ?? "the current legacy baseline"}.`,
      "Pending or failed eligible knowledge lowers semantic confidence; ineligible canonical nodes are excluded from this debt.",
    );
  }
  if (hollow > 0) observe("hollow_descriptions", hollow / Math.max(total, 1) > 0.25 ? "critical" : "warning", `${hollow} nodes lack a substantive intent/how/why description.`, "Shallow descriptions weaken semantic matching, causal analysis, and implementation planning.");
  if (machineNames > 0) observe("machine_name_leakage", "warning", `${machineNames} nodes expose identifier-shaped names.`, "Machine labels make graph evidence harder to interpret and can collapse distinct architectural concepts.");
  if (semanticDensity < 0.65 && total > 0) observe("low_semantic_density", semanticDensity < 0.4 ? "critical" : "warning", `Semantic density is ${(semanticDensity * 100).toFixed(1)}%.`, "Sparse intent, contracts, and relations reduce retrieval precision and cross-node reasoning depth.");
  if (contractMetric.applicable && contractMetric.ratio < 0.8) observe("missing_contracts", "warning", `${contractMetric.value}/${contractMetric.total} source-bound UI nodes expose a data contract.`, "Missing contracts obscure data flow, validation boundaries, and compatibility impacts.");
  if (workflowMetric.applicable && workflowMetric.ratio < 0.8) observe("missing_workflow_knowledge", "warning", `${workflowMetric.value}/${workflowMetric.total} workflows have rich descriptions and ordered behavioral steps.`, "Incomplete workflows hide triggers, state transitions, coordination boundaries, and verification paths.");
  if (uiMetric.applicable && uiMetric.ratio < 0.8) observe("missing_ui_metadata", "warning", `${uiMetric.value}/${uiMetric.total} UI nodes have complete semantic, interaction, visual, and layout knowledge.`, "Architect cannot reliably reason about UI ownership, appearance, or composition.");
  if (dbConfigured && datastoreMetric.ratio < 0.8) observe("missing_datastore_relationships", "warning", `${datastoreMetric.value}/${datastoreMetric.total} datastore-relevant records are grounded.`, "Persistence ownership and code-to-table impact analysis may be incomplete.");
  if (connected.orphanFeatures > 0 || connected.featureClusters > 1) observe("disconnected_feature_clusters", "warning", `${connected.orphanFeatures} orphan features across ${connected.featureClusters} feature-bearing clusters.`, "Disconnected clusters hide cross-feature dependencies and weaken causal path discovery.");
  if (unresolvedTensions > 0) observe("unresolved_tensions", unresolvedTensions > 10 ? "critical" : "warning", `${unresolvedTensions} tension signals remain unresolved.`, "Unresolved contradictions lower confidence in recommendations and may represent active architectural risk.");
  if (promotionBase >= 10 && promotionRate < 0.05) observe("low_dream_promotion", "warning", `${promotedCandidates}/${promotionBase} normalized dream candidates were promoted.`, "Low promotion can mean the graph lacks evidence, dreams are poorly targeted, or normalization is stale.");
  if (scanAge === null || scanAge > scanStaleHours) observe("stale_scan", "warning", scanAge == null ? "No durable scan timestamp exists." : `Last scan is ${scanAge.toFixed(1)} hours old.`, "Architect may reason from code topology that no longer matches the repository.");
  if (enrichmentAge === null || enrichmentAge > enrichmentStaleHours) observe("stale_enrichment", "warning", enrichmentAge == null ? "No successful enrichment timestamp exists." : `Last enrichment is ${enrichmentAge.toFixed(1)} hours old.`, "Intent and relationships may lag behind the current implementation.");
  if (drift.modified >= majorChangeFiles || drift.commits > 0) observe("repository_drift", "warning", `${drift.modified} modified files and ${drift.commits} commits since the recorded scan.`, "Repository change volume makes existing graph evidence potentially incomplete.");
  if (databaseChanged) observe("datastore_configuration_changed", "warning", "A configured DATABASE_URL differs from the last scanned datastore fingerprint.", "Table ownership and persistence links have not yet been grounded for this datastore configuration.");

  const recommendations: GraphMaintenanceRecommendation[] = [];
  const graphEmpty = total === 0;
  const repositoryStale = scanAge == null || scanAge > scanStaleHours || drift.modified >= majorChangeFiles || drift.commits > 0;
  const semanticPoor = parserOnly > 0 || hollow > 0 || enrichedCount < enrichmentDenominator || semanticDensity < 0.65 || richUiCount < uiNodes.length;
  // Smallest-capable operation ordering is deliberate: enrich before scan;
  // scan before bootstrap. Drift is the exception because enrichment cannot
  // discover source entities that are absent from the graph.
  if (!graphEmpty && semanticPoor && !repositoryStale) {
    recommendations.push(recommendation(10, "Force semantic enrichment", "enrich_parser_nodes", { target: "all", force: true, context_hops: 3, model_source: "auto" }, "The source map is current but semantic coverage is incomplete.", "Refresh intent, contracts, UI knowledge, and multi-hop relations without an expensive source scan."));
  }
  if (!graphEmpty && repositoryStale) {
    const baseline = await loadScanState();
    if (baseline.status === "compatible" && baseline.state) {
      recommendations.push(recommendation(
        20, "Incrementally reconcile project", "scan_project",
        { mode: "incremental", depth: baseline.state.depth, targets: baseline.state.targets_covered, dry_run: false, enrich: false },
        "Repository drift exists and the committed scan baseline is compatible.",
        "Reconcile only changed repository evidence through the same MCP path with zero default LLM calls.",
      ));
    } else {
      recommendations.push(recommendation(
        20, "Fully reconcile project", "scan_project", { mode: "full", depth: "deep" },
        `Repository drift exists but the incremental baseline is ${baseline.status}.`,
        "Create a governed authoritative baseline; full scan remains explicit recovery.",
      ));
    }
  }
  if (graphEmpty) {
    recommendations.push(recommendation(20, "Scan project", "scan_project", { depth: "deep" }, "The active instance has no canonical project graph.", "Build the initial evidence map before considering a broader bootstrap."));
  }
  if (dbConfigured && (databaseChanged || datastoreMetric.ratio < 0.8)) {
    recommendations.push(recommendation(30, "Scan configured datastore", "scan_database", { create_missing: true }, databaseChanged ? "DATABASE_URL is new or changed." : "Datastore/table relationships are incomplete.", "Ground tables and explicit stored_in relationships before semantic re-enrichment."));
  }
  const latentCandidates = candidates.results.filter((result) => result.status === "latent").length;
  if (latentCandidates > 0) {
    recommendations.push(recommendation(40, "Normalize dreams", "normalize_dreams", {}, `${latentCandidates} dream candidates remain latent or unevaluated.`, "Re-evaluate speculative relations against current graph evidence."));
  }
  if (unresolvedTensions > 0) {
    recommendations.push(recommendation(50, "Resolve semantic tensions", "get_remediation_plan", { min_urgency: 0.3 }, `${unresolvedTensions} unresolved tensions may affect architectural confidence.`, "Produce evidence-grounded remediation before resolving individual tension records."));
  }
  if (!graphEmpty && !repositoryStale && !semanticPoor && observations.length === 0) {
    recommendations.push(recommendation(90, "Export living documentation", "export_living_docs", { sections: ["all"], include_cognitive: true }, "The graph is healthy enough to publish as current architectural knowledge.", "Make the enriched model reviewable by humans without changing cognitive state."));
  }
  recommendations.sort((a, b) => a.priority - b.priority);

  const connectivityRatio = linkedMetric.ratio;
  let score = total === 0 ? 0 :
    semanticDensity * 0.3 + enrichedMetric.ratio * 0.2 + connectivityRatio * 0.12 +
    workflowMetric.ratio * 0.08 + contractMetric.ratio * 0.08 + uiMetric.ratio * 0.08 + datastoreMetric.ratio * 0.08 +
    Math.max(0, 1 - Math.min(1, unresolvedTensions / 20)) * 0.06;
  if (repositoryStale) score -= 0.08;
  if (promotionBase >= 10 && promotionRate < 0.05) score -= 0.05;
  score = Math.max(0, Math.min(1, score));
  const status: GraphHealthReport["status"] = total === 0 ? "empty" : score >= 0.85 ? "excellent" : score >= 0.7 ? "healthy" : score >= 0.45 ? "needs_attention" : "poor";

  return {
    schema: "dreamgraph.graph_health.v1",
    generated_at: new Date().toISOString(),
    status,
    score: Number(score.toFixed(4)),
    quality_principle: "Architectural quality outranks graph size: intent, contracts, causal relationships, ownership, and rich descriptions are the health target.",
    thresholds: { scan_stale_hours: scanStaleHours, enrichment_stale_hours: enrichmentStaleHours, major_repository_change_files: majorChangeFiles },
    inventory: {
      feature: groups.feature.length, workflow: groups.workflow.length, data_model: groups.data_model.length,
      capability: groups.capability.length, datastore: groups.datastore.length, ui_element: groups.ui_element.length,
      auxiliary: groups.auxiliary.length, total,
    },
    metrics: {
      semantic_density: Number(semanticDensity.toFixed(4)),
      enriched_nodes: enrichedMetric,
      enrichment_debt: {
        scan_revision: coverage?.revision ?? null,
        eligible: enrichmentDenominator,
        pending: eligibleCoverageNodes.filter((node) => node.semantic_state === "pending").length,
        failed_retryable: eligibleCoverageNodes.filter((node) => node.semantic_state === "failed_retryable").length,
        failed_terminal: eligibleCoverageNodes.filter((node) => node.semantic_state === "failed_terminal").length,
        skipped: eligibleCoverageNodes.filter((node) => node.semantic_state === "skipped").length,
      },
      parser_only_nodes: parserOnly,
      hollow_descriptions: hollow, machine_name_leakage: machineNames, contract_coverage: contractMetric,
      workflow_coverage: workflowMetric, datastore_coverage: datastoreMetric, ui_coverage: uiMetric,
      linked_nodes: linkedMetric, orphan_features: connected.orphanFeatures,
      disconnected_feature_clusters: Math.max(0, connected.featureClusters - 1), unresolved_tensions: unresolvedTensions,
      dream_promotion_rate: Number(promotionRate.toFixed(4)), dream_candidates: promotionBase,
      scan_age_hours: scanAge == null ? null : Number(scanAge.toFixed(2)),
      enrichment_age_hours: enrichmentAge == null ? null : Number(enrichmentAge.toFixed(2)),
      modified_repository_files: drift.modified, commits_since_scan: drift.commits,
      datastore_configuration_changed: databaseChanged,
    },
    observations,
    recommendations,
    primary_recommendation: recommendations[0] ?? null,
    maintenance_state: state,
  };
}

export function registerGraphHealthTools(server: McpServer): void {
  server.tool(
    "graph_health_report",
    "Read-only architectural quality assessment for the active DreamGraph instance. Reports semantic density, enrichment, parser-only and hollow nodes, naming quality, contracts, workflows, datastore/UI coverage, connectivity, tensions, dream promotion, repository drift, and staleness. Returns evidence-based smallest-first maintenance recommendations; it never executes them.",
    {
      include_recommendations: z.boolean().default(true).describe("Include ranked user-approval maintenance actions (default true)."),
    },
    async ({ include_recommendations }) => {
      logger.info("graph_health_report called");
      const result = await safeExecute<GraphHealthReport>(async (): Promise<ToolResponse<GraphHealthReport>> => {
        const report = await assessGraphHealth();
        if (!include_recommendations) {
          report.recommendations = [];
          report.primary_recommendation = null;
        }
        return success(report);
      });
      return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] };
    },
  );
}
