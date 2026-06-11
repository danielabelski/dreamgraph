import { appendFile, readdir, readFile, stat } from "node:fs/promises";
import { basename, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { getActiveScope } from "../instance/lifecycle.js";
import { loadJsonArray } from "../utils/cache.js";

export interface ArchitectHeading {
  level: number;
  title: string;
  path: string;
  startIndex: number;
}

export interface ArchitectSemanticAnchor {
  kind:
    | "adr"
    | "feature"
    | "workflow"
    | "capability"
    | "data_model"
    | "resource"
    | "api_route"
    | "tool"
    | "file_path";
  id: string;
  label: string;
  href: string | null;
  source: "frontmatter" | "markdown" | "catalog" | "log";
}

export interface ArchitectPlanSlice {
  id: string;
  title: string;
  category: "phase" | "slice";
  heading_path: string;
  status: string | null;
  adr_bindings: string[];
  graph_bindings: ArchitectSemanticAnchor[];
}

export interface ArchitectPlanCheckpoint {
  id: string;
  timestamp: string;
  slice_id: string;
  status: string;
  label: string;
  resume_note: string | null;
  body: string;
}

export type ArchitectPlanLifecycle =
  | "draft"
  | "planning"
  | "reviewed"
  | "implementation_ready"
  | "implementing"
  | "verifying"
  | "blocked"
  | "completed"
  | "archived"
  | "superseded";

export type ArchitectExecutionState = "idle" | "running" | "partial" | "failed" | "timed_out" | "cancelled" | "complete";

export interface ArchitectPlanSliceRef {
  id: string;
  title: string;
  status: string | null;
}

export interface ArchitectTaskMemoryBinding {
  authority: "dreamgraph";
  source: "implementation_log_projection";
  binding_status: "projected";
  plan_state_owner: "daemon";
  current_slice_id: string | null;
  current_checkpoint_id: string | null;
  current_status: string | null;
  last_event_at: string | null;
  resume_hint: string | null;
  plan_lifecycle: ArchitectPlanLifecycle;
  execution_state: ArchitectExecutionState;
  active_slice_id: string | null;
  last_completed_slice_id: string | null;
  next_slice_id: string | null;
}

export interface ArchitectOperationalPlanState {
  source: "implementation_log_projection";
  phase: string | null;
  active_phase: string | null;
  current_slice_id: string | null;
  current_slice_title: string | null;
  current_status: string | null;
  plan_lifecycle: ArchitectPlanLifecycle;
  execution_state: ArchitectExecutionState;
  partial: boolean;
  active_slice: ArchitectPlanSliceRef | null;
  last_completed_slice: ArchitectPlanSliceRef | null;
  next_slice: ArchitectPlanSliceRef | null;
  last_checkpoint_at: string | null;
  checkpoint_count: number;
  verified_checkpoint_count: number;
  completed_checkpoint_count: number;
  resume_hint: string | null;
  task_memory_binding: ArchitectTaskMemoryBinding;
}

export interface ArchitectEvidenceLink {
  kind: "file" | "heading" | "route" | "resource" | "tool";
  label: string;
  target: string;
  hint: string | null;
}

export type LivingPlanConfidence = "low" | "medium" | "high";
export type LivingPlanReviewState = "draft" | "reviewed" | "implementation_ready";

export interface LivingPlanBranch {
  id: string;
  title: string;
  status: "conceptual_candidate";
  validates_with: string | null;
  falsified_by: string | null;
  adr_bindings: string[];
}

export interface LivingPlanState {
  source: "markdown_log_projection";
  pulse: string;
  confidence: LivingPlanConfidence;
  current_slice: ArchitectPlanSliceRef | null;
  current_hypothesis: string | null;
  open_questions: string[];
  evidence_anchors: ArchitectSemanticAnchor[];
  nervous_points: string[];
  branches: LivingPlanBranch[];
  plan_asks: string[];
  adr_bindings: string[];
  last_changed_because: string | null;
  review_state: LivingPlanReviewState;
  next_review_prompt: string | null;
}

export type ArchitectPlanActionKind = "plan_action" | "review_gate";

export type ArchitectPlanActionAuditStatus = "recorded" | "completed" | "implemented" | "verified" | "partial" | "failed" | "timed_out" | "cancelled";

export interface ArchitectPlanActionAuditInput {
  kind: ArchitectPlanActionKind;
  action: string;
  audit_reason: string;
  actor?: string | null;
  slice_id?: string | null;
  status?: ArchitectPlanActionAuditStatus | null;
  gate_id?: string | null;
  decision?: string | null;
  evidence?: string | null;
  content?: string | null;
  resume_note?: string | null;
}

export interface ArchitectPlanActionAuditResult {
  plan_id: string;
  plan_path: string;
  log_path: string;
  status: "recorded";
  changed: true;
  audit_id: string;
  action_kind: ArchitectPlanActionKind;
  action: string;
  audit_reason: string;
  markdown_refs: string[];
  graph_refs: string[];
  warnings: string[];
  next_actions: string[];
}

export interface ArchitectPlanRegistry {
  source: "markdown_projection";
  summary: {
    heading_count: number;
    adr_binding_count: number;
    graph_binding_count: number;
    slice_count: number;
    checkpoint_count: number;
  };
  adr_bindings: string[];
  graph_bindings: ArchitectSemanticAnchor[];
  slices: ArchitectPlanSlice[];
  checkpoints: ArchitectPlanCheckpoint[];
  operational_state: ArchitectOperationalPlanState;
  evidence_links: ArchitectEvidenceLink[];
}

export interface ArchitectPlanSummary {
  id: string;
  title: string;
  path: string;
  log_path: string | null;
  status: string | null;
  active_phase: string | null;
  updated_at: string;
  adr_bindings: string[];
  graph_binding_count: number;
  slice_count: number;
  checkpoint_count: number;
  operational_state: ArchitectOperationalPlanState;
}

export interface ArchitectPlanDetail extends ArchitectPlanSummary {
  markdown: string;
  headings: Array<{ level: number; title: string; path: string }>;
  resume_state: {
    last_log_heading: string | null;
    last_resume_note: string | null;
    log_excerpt: string | null;
  };
  living_state: LivingPlanState;
  registry: ArchitectPlanRegistry;
}

interface GraphCatalogEntry {
  kind: "feature" | "workflow" | "capability" | "data_model";
  id: string;
  name: string;
}

interface ParsedFrontmatter {
  attributes: Record<string, string | string[]>;
}

const FALLBACK_PROJECT_ROOT = resolve(
  fileURLToPath(import.meta.url),
  "..",
  "..",
  "..",
);

export function getArchitectProjectRoot(): string {
  return getActiveScope()?.projectRoot ?? FALLBACK_PROJECT_ROOT;
}

export function getArchitectPlansRoot(): string {
  return resolve(getArchitectProjectRoot(), "plans");
}

const KNOWN_TOOL_NAMES = new Set([
  "append_to_file",
  "create_file",
  "edit_entity",
  "edit_file",
  "enrich_seed_data",
  "graph_rag_retrieve",
  "list_markdown_chapters",
  "patch_file",
  "planning:append_plan",
  "planning:archive_plan",
  "planning:get_plan_state",
  "planning:get_resume_packet",
  "planning:list_slices",
  "planning:next_slice",
  "planning:resume_plan",
  "planning:review_gate",
  "planning:sanitize_plan",
  "planning:start_plan",
  "planning:sync_plan_graph",
  "planning:update_slice_status",
  "query_architecture_decisions",
  "query_resource",
  "read_markdown_chapter",
  "read_source_code",
  "record_architecture_decision",
  "register_ui_element",
  "run_command",
  "schedule_dream",
  "search_data_model",
  "update_schedule",
]);

let graphCatalogPromise: Promise<GraphCatalogEntry[]> | null = null;

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function parseFirstMatch(markdown: string, pattern: RegExp): string | null {
  const match = markdown.match(pattern);
  return match?.[1]?.trim() ?? null;
}

function normalizeHeadingTitle(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function parseFrontmatter(markdown: string): ParsedFrontmatter {
  if (!markdown.startsWith("---\n") && !markdown.startsWith("---\r\n")) {
    return { attributes: {} };
  }

  const normalized = markdown.replace(/\r\n/g, "\n");
  const end = normalized.indexOf("\n---\n", 4);
  if (end < 0) {
    return { attributes: {} };
  }

  const block = normalized.slice(4, end);
  const attributes: Record<string, string | string[]> = {};
  for (const line of block.split("\n")) {
    const separator = line.indexOf(":");
    if (separator < 0) continue;
    const key = line.slice(0, separator).trim();
    const rawValue = line.slice(separator + 1).trim();
    if (!key || !rawValue) continue;
    if (rawValue.startsWith("[") && rawValue.endsWith("]")) {
      const items = rawValue
        .slice(1, -1)
        .split(",")
        .map((item) => item.trim().replace(/^['\"]|['\"]$/g, ""))
        .filter(Boolean);
      attributes[key] = items;
      continue;
    }
    attributes[key] = rawValue.replace(/^['\"]|['\"]$/g, "");
  }

  return { attributes };
}

function parseHeadings(markdown: string): ArchitectHeading[] {
  const headings: ArchitectHeading[] = [];
  const stack: string[] = [];
  for (const match of markdown.matchAll(/^(#{1,6})\s+(.+)$/gm)) {
    const level = match[1].length;
    const title = normalizeHeadingTitle(match[2]);
    stack[level - 1] = title;
    stack.length = level;
    headings.push({
      level,
      title,
      path: stack.join(" / "),
      startIndex: match.index ?? 0,
    });
  }
  return headings;
}

function sectionBody(markdown: string, headings: ArchitectHeading[], index: number): string {
  const current = headings[index];
  const bodyStart = markdown.indexOf("\n", current.startIndex);
  if (bodyStart < 0) return "";

  let end = markdown.length;
  for (let cursor = index + 1; cursor < headings.length; cursor += 1) {
    if (headings[cursor].level <= current.level) {
      end = headings[cursor].startIndex;
      break;
    }
  }

  return markdown.slice(bodyStart + 1, end).trim();
}

function extractLastLogHeading(logMarkdown: string): string | null {
  const matches = Array.from(logMarkdown.matchAll(/^###\s+(.+)$/gm));
  return matches.length > 0 ? matches[matches.length - 1][1].trim() : null;
}

function extractLastResumeNote(logMarkdown: string): string | null {
  const matches = Array.from(logMarkdown.matchAll(/^- Resume note:\s*(.+)$/gm));
  return matches.length > 0 ? matches[matches.length - 1][1].trim() : null;
}

function extractLogExcerpt(logMarkdown: string): string | null {
  const lines = logMarkdown.trim().split(/\r?\n/).filter(Boolean);
  if (lines.length === 0) return null;
  return lines.slice(-8).join("\n");
}

async function loadOptionalFile(filePath: string): Promise<string | null> {
  try {
    return await readFile(filePath, "utf-8");
  } catch {
    return null;
  }
}

function uniqueStrings(values: Iterable<string>): string[] {
  return [...new Set([...values].filter(Boolean))].sort((left, right) => left.localeCompare(right));
}

function extractMarkdownListItems(body: string): string[] {
  return body
    .split(/\r?\n/)
    .map((line) => line.match(/^\s*(?:[-*]|\d+[.)])\s+(.+)$/)?.[1]?.trim() ?? null)
    .filter((item): item is string => Boolean(item));
}

const RESOLVED_REVIEW_ITEM_STATUSES = new Set(["addressed", "resolved", "solved", "closed", "complete", "completed", "done", "fixed", "mitigated"]);

function normalizeReviewItemStatusMarker(value: string): string {
  return value.trim().toLowerCase().replace(/^\((.+)\)$/, "$1").replace(/[.:;]+$/, "");
}

function isResolvedReviewItem(item: string): boolean {
  const normalized = item.trim();
  if (/^\[[xX]\]\s+/.test(normalized)) return true;
  const leadingStatus = normalized.match(/^\(?([A-Za-z]+)\)?\s*(?::|-)\s+/)?.[1];
  if (leadingStatus != null && RESOLVED_REVIEW_ITEM_STATUSES.has(normalizeReviewItemStatusMarker(leadingStatus))) return true;
  const trailingStatus = normalized.match(/(?:\s+|^)\(?([A-Za-z]+)\)?[.:;]*\s*$/)?.[1];
  return trailingStatus != null && RESOLVED_REVIEW_ITEM_STATUSES.has(normalizeReviewItemStatusMarker(trailingStatus));
}

function findSectionItems(markdown: string, headings: ArchitectHeading[], titlePattern: RegExp): string[] {
  const headingIndex = headings.findIndex((heading) => titlePattern.test(heading.title));
  if (headingIndex < 0) return [];
  return extractMarkdownListItems(sectionBody(markdown, headings, headingIndex));
}

function findActiveReviewSectionItems(markdown: string, headings: ArchitectHeading[], titlePattern: RegExp): string[] {
  return findSectionItems(markdown, headings, titlePattern).filter((item) => !isResolvedReviewItem(item));
}

function parseLabeledBranchValue(body: string, label: string): string | null {
  const pattern = new RegExp("^\\s*(?:[-*]\\s*)?" + escapeRegExp(label) + ":\\s*(.+)", "im");
  return body.match(pattern)?.[1]?.trim() ?? null;
}

function deriveLivingPlanConfidence(operationalState: ArchitectOperationalPlanState, openQuestions: string[]): LivingPlanConfidence {
  if (operationalState.verified_checkpoint_count > 0 && openQuestions.length === 0) return "high";
  if (operationalState.completed_checkpoint_count > 0 || operationalState.checkpoint_count > 1) return "medium";
  return "low";
}

function deriveLivingPlanReviewState(lifecycle: ArchitectPlanLifecycle): LivingPlanReviewState {
  if (["implementation_ready", "implementing", "verifying", "completed"].includes(lifecycle)) return "implementation_ready";
  if (lifecycle === "reviewed") return "reviewed";
  return "draft";
}

export function buildLivingPlanState(input: {
  markdown: string;
  headings: ArchitectHeading[];
  checkpoints: ArchitectPlanCheckpoint[];
  graphBindings: ArchitectSemanticAnchor[];
  adrBindings: string[];
  operationalState: ArchitectOperationalPlanState;
}): LivingPlanState {
  const openQuestions = findSectionItems(input.markdown, input.headings, /^(?:\d+\.\s*)?Open Questions$/i);
  const nervousPoints = uniqueStrings([
    ...findActiveReviewSectionItems(input.markdown, input.headings, /^(?:\d+\.\s*)?(?:Nervous Points|Risks?|Risk Register)$/i),
    ...findActiveReviewSectionItems(input.markdown, input.headings, /^(?:\d+\.\s*)?Design Guardrails$/i),
  ]);
  const planAsks = findSectionItems(input.markdown, input.headings, /^(?:\d+\.\s*)?Plan Asks$/i);
  const candidateHeadings = input.headings.filter((heading) =>
    /^Slice\s+[A-Za-z0-9]+[.:]?\s*/i.test(heading.title) && /Candidate Slices/i.test(heading.path),
  );
  const activeSliceId = input.operationalState.active_slice?.id ?? null;
  const completedSliceId = input.operationalState.last_completed_slice?.id ?? null;
  const completedBranchIds = new Set(
    input.checkpoints
      .filter(isCompletedCheckpoint)
      .map((checkpoint) => slugifySliceSegment(checkpoint.slice_id)),
  );
  const branches = candidateHeadings
    .map((heading) => {
      const index = input.headings.indexOf(heading);
      const classified = classifySlice(heading.title);
      const body = index < 0 ? "" : sectionBody(input.markdown, input.headings, index);
      return classified ? {
        id: classified.sortId,
        title: heading.title,
        status: "conceptual_candidate" as const,
        validates_with: parseLabeledBranchValue(body, "Validates with"),
        falsified_by: parseLabeledBranchValue(body, "Falsified by"),
        adr_bindings: extractAdrBindings(body, { attributes: {} }),
      } : null;
    })
    .filter((branch): branch is LivingPlanBranch => branch != null && branch.id !== activeSliceId && branch.id !== completedSliceId)
    .filter((branch) => !completedBranchIds.has(slugifySliceSegment(branch.id)));
  const currentHypothesis = parseFirstMatch(input.markdown, /^Current review stance:\s*(.+)$/m);
  const latestCheckpoint = input.checkpoints.at(-1) ?? null;
  const currentSlice = input.operationalState.active_slice ?? input.operationalState.next_slice ?? input.operationalState.last_completed_slice;
  const pulse = `${input.operationalState.plan_lifecycle}/${input.operationalState.execution_state}; slice=${currentSlice?.title ?? "none"}; questions=${openQuestions.length}; branches=${branches.length}`;

  return {
    source: "markdown_log_projection",
    pulse,
    confidence: deriveLivingPlanConfidence(input.operationalState, openQuestions),
    current_slice: currentSlice,
    current_hypothesis: currentHypothesis,
    open_questions: openQuestions,
    evidence_anchors: [
      ...input.graphBindings.filter((binding) => binding.kind === "adr"),
      ...input.graphBindings.filter((binding) => binding.kind !== "adr"),
    ].slice(0, 24),
    nervous_points: nervousPoints,
    branches,
    plan_asks: planAsks,
    adr_bindings: input.adrBindings,
    last_changed_because: latestCheckpoint?.label ?? null,
    review_state: deriveLivingPlanReviewState(input.operationalState.plan_lifecycle),
    next_review_prompt: planAsks[0] ?? openQuestions[0] ?? null,
  };
}

function pushBinding(store: Map<string, ArchitectSemanticAnchor>, binding: ArchitectSemanticAnchor): void {
  store.set(`${binding.kind}:${binding.id.toLowerCase()}`, binding);
}

function extractAdrBindings(markdown: string, frontmatter: ParsedFrontmatter): string[] {
  const found = new Set<string>();
  const frontmatterBindings = frontmatter.attributes.adr_bindings;
  if (typeof frontmatterBindings === "string") {
    for (const match of frontmatterBindings.matchAll(/ADR-\d{3}/g)) {
      found.add(match[0]);
    }
  }
  if (Array.isArray(frontmatterBindings)) {
    for (const binding of frontmatterBindings) {
      if (/^ADR-\d{3}$/i.test(binding)) {
        found.add(binding.toUpperCase());
      }
    }
  }
  for (const match of markdown.matchAll(/ADR-\d{3}/g)) {
    found.add(match[0]);
  }
  return [...found].sort((left, right) => left.localeCompare(right));
}

function extractResourceBindings(markdown: string): ArchitectSemanticAnchor[] {
  const store = new Map<string, ArchitectSemanticAnchor>();
  for (const match of markdown.matchAll(/\b(?:system|dream|ops):\/\/[A-Za-z0-9./_-]+\b/g)) {
    pushBinding(store, {
      kind: "resource",
      id: match[0],
      label: match[0],
      href: match[0],
      source: "markdown",
    });
  }
  return [...store.values()];
}

function extractRouteBindings(markdown: string): ArchitectSemanticAnchor[] {
  const store = new Map<string, ArchitectSemanticAnchor>();
  for (const match of markdown.matchAll(/(^|[\s`(])((?:\/architect|\/api\/architect|\/explorer)[A-Za-z0-9_./{}-]*)/gm)) {
    const route = match[2];
    pushBinding(store, {
      kind: "api_route",
      id: route,
      label: route,
      href: route,
      source: "markdown",
    });
  }
  return [...store.values()];
}

function extractToolBindings(markdown: string): ArchitectSemanticAnchor[] {
  const store = new Map<string, ArchitectSemanticAnchor>();
  for (const match of markdown.matchAll(/`([A-Za-z][A-Za-z0-9_-]*(?::[A-Za-z][A-Za-z0-9_-]*)+)`/g)) {
    const toolName = match[1];
    pushBinding(store, {
      kind: "tool",
      id: toolName,
      label: toolName,
      href: null,
      source: "markdown",
    });
  }
  for (const match of markdown.matchAll(/`([A-Za-z][A-Za-z0-9_-]+)`/g)) {
    const toolName = match[1];
    if (!KNOWN_TOOL_NAMES.has(toolName)) continue;
    pushBinding(store, {
      kind: "tool",
      id: toolName,
      label: toolName,
      href: null,
      source: "markdown",
    });
  }
  return [...store.values()];
}

function extractFileBindings(markdown: string): ArchitectSemanticAnchor[] {
  const store = new Map<string, ArchitectSemanticAnchor>();
  for (const match of markdown.matchAll(/`((?:plans|src|extensions|explorer|docs|tests)\/[^`\r\n]+?\.(?:md|ts|tsx|js|mjs|cjs|json))`/g)) {
    const filePath = match[1];
    pushBinding(store, {
      kind: "file_path",
      id: filePath,
      label: filePath,
      href: filePath,
      source: "markdown",
    });
  }
  return [...store.values()];
}

async function loadGraphCatalog(): Promise<GraphCatalogEntry[]> {
  if (!graphCatalogPromise) {
    graphCatalogPromise = Promise.all([
      loadJsonArray<{ id?: string; name?: string }>("features.json"),
      loadJsonArray<{ id?: string; name?: string }>("workflows.json"),
      loadJsonArray<{ id?: string; name?: string }>("capabilities.json"),
      loadJsonArray<{ id?: string; name?: string }>("data_model.json"),
    ]).then(([features, workflows, capabilities, dataModels]) => {
      const catalog: GraphCatalogEntry[] = [];
      for (const entry of features) {
        if (entry.id && entry.name) catalog.push({ kind: "feature", id: entry.id, name: entry.name });
      }
      for (const entry of workflows) {
        if (entry.id && entry.name) catalog.push({ kind: "workflow", id: entry.id, name: entry.name });
      }
      for (const entry of capabilities) {
        if (entry.id && entry.name) catalog.push({ kind: "capability", id: entry.id, name: entry.name });
      }
      for (const entry of dataModels) {
        if (entry.id && entry.name) catalog.push({ kind: "data_model", id: entry.id, name: entry.name });
      }
      return catalog;
    });
  }
  return graphCatalogPromise;
}

function containsToken(markdown: string, token: string): boolean {
  const pattern = new RegExp(`(^|[^A-Za-z0-9_-])${escapeRegExp(token)}($|[^A-Za-z0-9_-])`, "i");
  return pattern.test(markdown);
}

function extractCatalogBindings(markdown: string, catalog: GraphCatalogEntry[]): ArchitectSemanticAnchor[] {
  const store = new Map<string, ArchitectSemanticAnchor>();
  const lower = markdown.toLowerCase();
  for (const entry of catalog) {
    const idMatch = containsToken(markdown, entry.id);
    const nameMatch = entry.name.length >= 14 && lower.includes(entry.name.toLowerCase());
    if (!idMatch && !nameMatch) continue;
    pushBinding(store, {
      kind: entry.kind,
      id: entry.id,
      label: entry.name,
      href: entry.id,
      source: "catalog",
    });
  }
  return [...store.values()];
}

function collectGraphBindings(markdown: string, adrBindings: string[], catalog: GraphCatalogEntry[]): ArchitectSemanticAnchor[] {
  const store = new Map<string, ArchitectSemanticAnchor>();
  for (const adr of adrBindings) {
    pushBinding(store, {
      kind: "adr",
      id: adr,
      label: adr,
      href: adr,
      source: "markdown",
    });
  }
  for (const binding of extractCatalogBindings(markdown, catalog)) {
    pushBinding(store, binding);
  }
  for (const binding of extractResourceBindings(markdown)) {
    pushBinding(store, binding);
  }
  for (const binding of extractRouteBindings(markdown)) {
    pushBinding(store, binding);
  }
  for (const binding of extractToolBindings(markdown)) {
    pushBinding(store, binding);
  }
  for (const binding of extractFileBindings(markdown)) {
    pushBinding(store, binding);
  }
  return [...store.values()].sort((left, right) => {
    const leftKey = `${left.kind}:${left.label}`.toLowerCase();
    const rightKey = `${right.kind}:${right.label}`.toLowerCase();
    return leftKey.localeCompare(rightKey);
  });
}

function slugifySliceSegment(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
}

function classifySlice(title: string): { category: "phase" | "slice"; sortId: string } | null {
  const phaseMatch = title.match(/^Phase\s+(\d+)\s+[—-]\s+(.+)$/i);
  if (phaseMatch) {
    return { category: "phase", sortId: `phase-${phaseMatch[1]}` };
  }
  const numericSliceMatch = title.match(/^Slice\s+(\d+)[.:]?\s*(.*)$/i);
  if (numericSliceMatch) {
    const ordinal = numericSliceMatch[1].toLowerCase();
    const titleSlug = slugifySliceSegment(numericSliceMatch[2] ?? "");
    return { category: "slice", sortId: titleSlug ? `slice-${ordinal}-${titleSlug}` : `slice-${ordinal}` };
  }
  const letterSliceMatch = title.match(/^Slice\s+([A-Z])(?:[.:]|\s+[—-])\s*(.*)$/i);
  if (letterSliceMatch) {
    const ordinal = letterSliceMatch[1].toLowerCase();
    const titleSlug = slugifySliceSegment(letterSliceMatch[2] ?? "");
    return { category: "slice", sortId: titleSlug ? `slice-${ordinal}-${titleSlug}` : `slice-${ordinal}` };
  }
  return null;
}

function phaseNumber(title: string): number | null {
  const match = title.match(/^Phase\s+(\d+)\b/i);
  return match ? Number.parseInt(match[1], 10) : null;
}

function derivePhaseStatus(title: string, activePhase: string | null): string | null {
  if (!activePhase) return null;
  if (title === activePhase) return "active";
  const current = phaseNumber(activePhase);
  const candidate = phaseNumber(title);
  if (current == null || candidate == null) return null;
  if (candidate < current) return "completed";
  if (candidate > current) return "pending";
  return null;
}

function extractInlineStatus(section: string): string | null {
  const backtick = section.match(/^-\s*status:\s*`([^`]+)`$/im);
  if (backtick?.[1]) return backtick[1].trim();
  const plain = section.match(/^-\s*status:\s*([^\n]+)$/im);
  return plain?.[1]?.trim() ?? null;
}

function extractSlices(
  markdown: string,
  headings: ArchitectHeading[],
  activePhase: string | null,
  catalog: GraphCatalogEntry[],
): ArchitectPlanSlice[] {
  const slices: ArchitectPlanSlice[] = [];
  for (let index = 0; index < headings.length; index += 1) {
    const heading = headings[index];
    const classification = classifySlice(heading.title);
    if (!classification) continue;
    const section = sectionBody(markdown, headings, index);
    const adrBindings = extractAdrBindings(section, { attributes: {} });
    const graphBindings = collectGraphBindings(section, adrBindings, catalog);
    slices.push({
      id: classification.sortId,
      title: heading.title,
      category: classification.category,
      heading_path: heading.path,
      status:
        classification.category === "phase"
          ? derivePhaseStatus(heading.title, activePhase)
          : extractInlineStatus(section),
      adr_bindings: adrBindings,
      graph_bindings: graphBindings,
    });
  }
  return slices;
}

function extractCheckpoints(logMarkdown: string | null): ArchitectPlanCheckpoint[] {
  if (!logMarkdown) return [];
  const checkpoints: ArchitectPlanCheckpoint[] = [];
  const pattern = /^###\s+(.+?)\s+[—-]\s+slice:\s+(.+?)\s+[—-]\s+status:\s+(.+)$/gm;
  const matches = Array.from(logMarkdown.matchAll(pattern));
  for (let index = 0; index < matches.length; index += 1) {
    const match = matches[index];
    const timestamp = match[1].trim();
    const sliceId = match[2].trim();
    const status = match[3].trim();
    const nextIndex = matches[index + 1]?.index ?? logMarkdown.length;
    const block = logMarkdown.slice(match.index ?? 0, nextIndex);
    checkpoints.push({
      id: `${sliceId}@${timestamp}`,
      timestamp,
      slice_id: sliceId,
      status,
      label: `${sliceId} — ${status}`,
      resume_note: parseFirstMatch(block, /^- Resume note:\s*(.+)$/m),
      body: block,
    });
  }
  return checkpoints.sort((left, right) => left.timestamp.localeCompare(right.timestamp));
}

function normalizeCheckpointStatus(status: string | null | undefined): string {
  return (status ?? "").trim().toLowerCase().replace(/[\s-]+/g, "_");
}

function isImplementationCheckpoint(checkpoint: ArchitectPlanCheckpoint): boolean {
  const status = normalizeCheckpointStatus(checkpoint.status);
  return status !== "" && status !== "created" && status !== "action_recorded";
}

function isCompletedCheckpoint(checkpoint: ArchitectPlanCheckpoint): boolean {
  const status = normalizeCheckpointStatus(checkpoint.status);
  return status === "completed" || status === "implemented" || status === "verified";
}

function sliceRef(slice: ArchitectPlanSlice | null | undefined, fallback?: ArchitectPlanCheckpoint | null): ArchitectPlanSliceRef | null {
  if (slice) return { id: slice.id, title: slice.title, status: slice.status };
  if (!fallback) return null;
  return { id: fallback.slice_id, title: fallback.slice_id, status: fallback.status };
}

function sliceSlugWithoutOrdinal(slice: ArchitectPlanSlice): string {
  return slugifySliceSegment(slice.id).replace(/^slice-[a-z0-9]+-?/, "");
}

function sliceMatchesSlug(slice: ArchitectPlanSlice, normalized: string): boolean {
  const idSlug = slugifySliceSegment(slice.id);
  const titleSlug = slugifySliceSegment(slice.title);
  const idWithoutOrdinal = sliceSlugWithoutOrdinal(slice);
  const titleWithoutOrdinal = titleSlug.replace(/^slice-[a-z0-9]+-?/, "");
  return (
    idSlug === normalized ||
    titleSlug === normalized ||
    (idWithoutOrdinal.length > 0 && idWithoutOrdinal === normalized) ||
    (titleWithoutOrdinal.length > 0 && titleWithoutOrdinal === normalized)
  );
}

function findSliceById(slices: ArchitectPlanSlice[], sliceId: string | null | undefined): ArchitectPlanSlice | null {
  if (!sliceId) return null;
  const normalized = slugifySliceSegment(sliceId);
  const ordinal = normalized.match(/^(?:slice-)?([a-z0-9]+)$/i)?.[1] ?? null;
  return (
    slices.find((slice) => slice.id === sliceId || sliceMatchesSlug(slice, normalized)) ??
    (ordinal == null ? null : slices.find((slice) => slice.id === `slice-${ordinal}` || slice.id.startsWith(`slice-${ordinal}-`))) ??
    null
  );
}

function sliceOrdinal(slice: ArchitectPlanSlice): number | null {
  const match = slice.id.match(/^slice-([0-9]+)(?:-|$)/i) ?? slice.title.match(/^Slice\s+([0-9]+)\b/i);
  if (!match) return null;
  const ordinal = Number.parseInt(match[1], 10);
  return Number.isFinite(ordinal) ? ordinal : null;
}

function checkpointCompletedSliceIds(slices: ArchitectPlanSlice[], checkpoint: ArchitectPlanCheckpoint): string[] {
  const implementationSlices = slices.filter((slice) => slice.category === "slice");
  const completed = new Map<string, ArchitectPlanSlice>();
  const direct = findSliceById(implementationSlices, checkpoint.slice_id);
  if (direct) completed.set(direct.id, direct);

  const normalized = slugifySliceSegment(checkpoint.slice_id);
  const rangeMatch = normalized.match(/^slices?-([0-9]+)-(?:through|to)-([0-9]+)$/i);
  if (rangeMatch) {
    const start = Number.parseInt(rangeMatch[1], 10);
    const end = Number.parseInt(rangeMatch[2], 10);
    if (Number.isFinite(start) && Number.isFinite(end)) {
      const low = Math.min(start, end);
      const high = Math.max(start, end);
      for (const slice of implementationSlices) {
        const ordinal = sliceOrdinal(slice);
        if (ordinal != null && ordinal >= low && ordinal <= high) completed.set(slice.id, slice);
      }
    }
  }

  const completionLines = checkpoint.body
    .split(/\r?\n/g)
    .filter((line) => /^-\s*(?:Action|Result):/i.test(line))
    .filter((line) => /\b(?:implemented|completed|verified|finished)\b/i.test(line));
  for (const line of completionLines) {
    for (const match of line.matchAll(/\bSlice\s+([0-9]+)\b/gi)) {
      const ordinal = match[1];
      const slice = implementationSlices.find((candidate) => candidate.id === `slice-${ordinal}` || candidate.id.startsWith(`slice-${ordinal}-`));
      if (slice) completed.set(slice.id, slice);
    }
  }

  return [...completed.keys()];
}

function findNextSliceFromResume(slices: ArchitectPlanSlice[], resumeHint: string | null, afterSliceId: string | null): ArchitectPlanSlice | null {
  const implementationSlices = slices.filter((slice) => slice.category === "slice");
  if (resumeHint) {
    const sliceMatch = resumeHint.match(/\bSlice\s+([A-Za-z0-9]+)\b/i);
    if (sliceMatch) {
      const prefix = `slice-${sliceMatch[1].toLowerCase()}`;
      const byOrdinal = implementationSlices.find((slice) => slice.id === prefix || slice.id.startsWith(`${prefix}-`));
      if (byOrdinal) return byOrdinal;
    }
    const normalizedHint = slugifySliceSegment(resumeHint);
    const byTitle = implementationSlices.find((slice) => normalizedHint.includes(slugifySliceSegment(slice.title).slice(0, 40)));
    if (byTitle) return byTitle;
  }

  if (afterSliceId) {
    const currentIndex = implementationSlices.findIndex((slice) => slice.id === afterSliceId);
    if (currentIndex >= 0) return implementationSlices[currentIndex + 1] ?? null;
  }
  return implementationSlices[0] ?? null;
}

function deriveExecutionState(latestCheckpoint: ArchitectPlanCheckpoint | null): ArchitectExecutionState {
  const status = normalizeCheckpointStatus(latestCheckpoint?.status);
  if (status === "timed_out" || status === "timeout") return "timed_out";
  if (status === "partial") return "partial";
  if (status === "failed" || status === "error") return "failed";
  if (status === "cancelled" || status === "canceled") return "cancelled";
  if (status === "running" || status === "implementing" || status === "verifying") return "running";
  return "idle";
}

function deriveProjectedPlanStatus(rawStatus: string | null, lifecycle: ArchitectPlanLifecycle): string | null {
  if (lifecycle !== "planning") return lifecycle;
  return rawStatus;
}

function derivePlanLifecycle(
  planStatus: string | null,
  slices: ArchitectPlanSlice[],
  implementationCheckpoints: ArchitectPlanCheckpoint[],
  completedSliceIds: Set<string>,
  nextSlice: ArchitectPlanSlice | null,
): ArchitectPlanLifecycle {
  const normalizedStatus = normalizeCheckpointStatus(planStatus);
  if (normalizedStatus === "archived") return "archived";
  if (normalizedStatus === "superseded") return "superseded";
  if (normalizedStatus === "completed" || normalizedStatus === "complete" || normalizedStatus === "done") return "completed";
  if (implementationCheckpoints.length > 0) {
    const implementationSlices = slices.filter((slice) => slice.category === "slice");
    if (implementationSlices.length > 0 && implementationSlices.every((slice) => completedSliceIds.has(slice.id))) {
      return "completed";
    }
    return nextSlice ? "implementing" : "implementing";
  }
  if (normalizedStatus === "reviewed") return "reviewed";
  if (normalizedStatus === "implementation_ready" || normalizedStatus === "accepted" || normalizedStatus === "ready") return "implementation_ready";
  if (normalizedStatus === "draft") return "draft";
  return "planning";
}

function deriveImplicitActivePhase(explicitPhase: string | null, planTitle: string, activeSlice: ArchitectPlanSliceRef | null): string | null {
  if (explicitPhase) return explicitPhase;
  const sliceText = `${activeSlice?.title ?? ""} ${activeSlice?.id ?? ""}`;
  const sliceNumber = sliceText.match(/\bSlice\s+([0-9]+)\b/i) ?? sliceText.match(/\bslice-([0-9]+)\b/i);
  const level = planTitle.match(/\bLevel\s+[0-9]+\b/i)?.[0] ?? null;
  if (sliceNumber && level) return `Phase ${sliceNumber[1]} / ${level}`;
  return null;
}

function buildOperationalState(
  activePhase: string | null,
  planStatus: string | null,
  planTitle: string,
  slices: ArchitectPlanSlice[],
  checkpoints: ArchitectPlanCheckpoint[],
  lastResumeNote: string | null,
): ArchitectOperationalPlanState {
  const activePhaseSlice = activePhase == null ? null : slices.find((slice) => slice.title === activePhase) ?? null;
  const implementationSlices = slices.filter((slice) => slice.category === "slice");
  const implementationCheckpoints = checkpoints.filter(isImplementationCheckpoint);
  const latestImplementationCheckpoint = implementationCheckpoints.at(-1) ?? null;
  const latestCompletedCheckpoint = [...implementationCheckpoints].reverse().find(isCompletedCheckpoint) ?? null;
  const latestImplementationSlice = findSliceById(slices, latestImplementationCheckpoint?.slice_id);
  const completedSliceIds = new Set(
    implementationCheckpoints
      .filter(isCompletedCheckpoint)
      .flatMap((checkpoint) => checkpointCompletedSliceIds(slices, checkpoint)),
  );
  const latestCompletedSlice =
    findSliceById(slices, latestCompletedCheckpoint?.slice_id) ??
    [...implementationSlices].reverse().find((slice) => completedSliceIds.has(slice.id)) ??
    null;
  const allImplementationSlicesComplete =
    implementationSlices.length > 0 && implementationSlices.every((slice) => completedSliceIds.has(slice.id));
  const rawResumeHint = latestImplementationCheckpoint?.resume_note ?? latestCompletedCheckpoint?.resume_note ?? lastResumeNote;
  const nextSlice = allImplementationSlicesComplete
    ? null
    : findNextSliceFromResume(slices, rawResumeHint, latestCompletedSlice?.id ?? latestCompletedCheckpoint?.slice_id ?? null);
  const latestImplementationComplete = latestImplementationCheckpoint ? isCompletedCheckpoint(latestImplementationCheckpoint) : false;
  const activeSlice = allImplementationSlicesComplete
    ? null
    : latestImplementationComplete
      ? nextSlice ?? latestImplementationSlice ?? activePhaseSlice
      : latestImplementationSlice ?? nextSlice ?? activePhaseSlice;
  const lifecycle = derivePlanLifecycle(planStatus, slices, implementationCheckpoints, completedSliceIds, nextSlice);
  const executionState = lifecycle === "completed" ? "complete" : deriveExecutionState(latestImplementationCheckpoint);
  const activeSliceRef = lifecycle === "completed" ? null : sliceRef(activeSlice, latestImplementationCheckpoint);
  const lastCompletedSliceRef = sliceRef(latestCompletedSlice, latestCompletedCheckpoint);
  const nextSliceRef = sliceRef(nextSlice);
  const completedResumeHint =
    lifecycle === "completed" && lastCompletedSliceRef
      ? `completed after ${lastCompletedSliceRef.title ?? lastCompletedSliceRef.id}`
      : null;
  const resumeHint = completedResumeHint ?? rawResumeHint;
  const derivedActivePhase = deriveImplicitActivePhase(activePhase, planTitle, activeSliceRef ?? nextSliceRef ?? lastCompletedSliceRef);
  const currentSliceId = activeSliceRef?.id ?? null;
  const currentSliceTitle = activeSliceRef?.title ?? null;
  const verifiedCheckpointCount = checkpoints.filter((checkpoint) => normalizeCheckpointStatus(checkpoint.status) === "verified").length;
  const completedCheckpointCount = checkpoints.filter(isCompletedCheckpoint).length;

  return {
    source: "implementation_log_projection",
    phase: derivedActivePhase,
    active_phase: derivedActivePhase,
    current_slice_id: currentSliceId,
    current_slice_title: currentSliceTitle,
    current_status: latestImplementationCheckpoint?.status ?? null,
    plan_lifecycle: lifecycle,
    execution_state: executionState,
    partial: executionState === "partial" || executionState === "timed_out",
    active_slice: activeSliceRef,
    last_completed_slice: lastCompletedSliceRef,
    next_slice: nextSliceRef,
    last_checkpoint_at: latestImplementationCheckpoint?.timestamp ?? null,
    checkpoint_count: checkpoints.length,
    verified_checkpoint_count: verifiedCheckpointCount,
    completed_checkpoint_count: completedCheckpointCount,
    resume_hint: resumeHint,
    task_memory_binding: {
      authority: "dreamgraph",
      source: "implementation_log_projection",
      binding_status: "projected",
      plan_state_owner: "daemon",
      current_slice_id: currentSliceId,
      current_checkpoint_id: latestImplementationCheckpoint?.id ?? null,
      current_status: latestImplementationCheckpoint?.status ?? null,
      last_event_at: latestImplementationCheckpoint?.timestamp ?? null,
      resume_hint: resumeHint,
      plan_lifecycle: lifecycle,
      execution_state: executionState,
      active_slice_id: activeSliceRef?.id ?? null,
      last_completed_slice_id: lastCompletedSliceRef?.id ?? null,
      next_slice_id: nextSliceRef?.id ?? null,
    },
  };
}

function buildEvidenceLinks(
  planPath: string,
  logPath: string | null,
  headings: ArchitectHeading[],
  graphBindings: ArchitectSemanticAnchor[],
): ArchitectEvidenceLink[] {
  const links: ArchitectEvidenceLink[] = [
    {
      kind: "file",
      label: "Plan markdown",
      target: planPath,
      hint: "durable source of truth",
    },
  ];

  if (logPath) {
    links.push({
      kind: "file",
      label: "Implementation log",
      target: logPath,
      hint: "append-only resume ledger",
    });
  }

  for (const heading of headings.slice(0, 10)) {
    links.push({
      kind: "heading",
      label: heading.title,
      target: heading.path,
      hint: "semantic chapter anchor",
    });
  }

  for (const binding of graphBindings.slice(0, 12)) {
    if (binding.kind === "resource") {
      links.push({ kind: "resource", label: binding.label, target: binding.id, hint: "graph resource anchor" });
      continue;
    }
    if (binding.kind === "api_route") {
      links.push({ kind: "route", label: binding.label, target: binding.id, hint: "daemon route anchor" });
      continue;
    }
    if (binding.kind === "tool") {
      links.push({ kind: "tool", label: binding.label, target: binding.id, hint: "tool authority anchor" });
    }
  }

  const unique = new Map<string, ArchitectEvidenceLink>();
  for (const link of links) {
    unique.set(`${link.kind}:${link.target}`, link);
  }
  return [...unique.values()];
}

interface ProjectPlanOptions {
  id?: string;
  path?: string;
  logFileName?: string | null;
  logPath?: string | null;
}

async function projectPlan(fileName: string, options?: ProjectPlanOptions): Promise<ArchitectPlanDetail> {
  const plansRoot = getArchitectPlansRoot();
  const planPath = resolve(plansRoot, fileName);
  const markdown = await readFile(planPath, "utf-8");
  const fileStat = await stat(planPath);
  const id = options?.id ?? basename(fileName, ".md");
  const logFileName = options?.logFileName === undefined ? `${id}.implementation-log.md` : options.logFileName;
  const logPath = logFileName == null ? null : resolve(plansRoot, logFileName);
  const logMarkdown = logPath == null ? null : await loadOptionalFile(logPath);
  const frontmatter = parseFrontmatter(markdown);
  const headings = parseHeadings(markdown);
  const title = parseFirstMatch(markdown, /^#\s+(.+)$/m) ?? id;
  const rawStatus =
    (typeof frontmatter.attributes.status === "string" ? frontmatter.attributes.status : null) ??
    parseFirstMatch(markdown, /^- Status:\s+`([^`]+)`$/m) ??
    parseFirstMatch(markdown, /^Status:\s+([^\n]+)$/m);
  const activePhase = parseFirstMatch(markdown, /^- Active phase:\s+`([^`]+)`$/m);
  const adrBindings = extractAdrBindings(markdown, frontmatter);
  const catalog = await loadGraphCatalog();
  const graphBindings = collectGraphBindings(markdown, adrBindings, catalog);
  const slices = extractSlices(markdown, headings, activePhase, catalog);
  const checkpoints = extractCheckpoints(logMarkdown);
  const path = options?.path ?? `plans/${fileName}`;
  const logPathRelative = logMarkdown == null ? null : (options?.logPath ?? (logFileName == null ? null : `plans/${logFileName}`));
  const resumeState = {
    last_log_heading: logMarkdown == null ? null : extractLastLogHeading(logMarkdown),
    last_resume_note: logMarkdown == null ? null : extractLastResumeNote(logMarkdown),
    log_excerpt: logMarkdown == null ? null : extractLogExcerpt(logMarkdown),
  };
  const operationalState = buildOperationalState(activePhase, rawStatus, title, slices, checkpoints, resumeState.last_resume_note);
  const livingState = buildLivingPlanState({ markdown, headings, checkpoints, graphBindings, adrBindings, operationalState });
  const status = deriveProjectedPlanStatus(rawStatus, operationalState.plan_lifecycle);

  return {
    id,
    title,
    path,
    log_path: logPathRelative,
    status,
    active_phase: activePhase,
    updated_at: fileStat.mtime.toISOString(),
    adr_bindings: adrBindings,
    graph_binding_count: graphBindings.length,
    slice_count: slices.length,
    checkpoint_count: checkpoints.length,
    operational_state: operationalState,
    markdown,
    headings: headings.map((heading) => ({ level: heading.level, title: heading.title, path: heading.path })),
    resume_state: resumeState,
    living_state: livingState,
    registry: {
      source: "markdown_projection",
      summary: {
        heading_count: headings.length,
        adr_binding_count: adrBindings.length,
        graph_binding_count: graphBindings.length,
        slice_count: slices.length,
        checkpoint_count: checkpoints.length,
      },
      adr_bindings: adrBindings,
      graph_bindings: graphBindings,
      slices,
      checkpoints,
      operational_state: operationalState,
      evidence_links: buildEvidenceLinks(path, logPathRelative, headings, graphBindings),
    },
  };
}

function isSafePlanId(planId: string): boolean {
  return /^[A-Za-z0-9._-]+$/.test(planId) && !planId.endsWith(".implementation-log");
}

export async function listPlanFiles(): Promise<string[]> {
  let entries: Array<{ isFile(): boolean; name: string }>;
  try {
    entries = await readdir(getArchitectPlansRoot(), { withFileTypes: true });
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") return [];
    throw error;
  }
  return entries
    .filter((entry) => entry.isFile())
    .map((entry) => entry.name)
    .filter((name) => name.endsWith(".md") && !name.endsWith(".implementation-log.md"))
    .sort((left, right) => left.localeCompare(right));
}

export async function buildPlanSummary(fileName: string): Promise<ArchitectPlanSummary> {
  const detail = await projectPlan(fileName);
  return {
    id: detail.id,
    title: detail.title,
    path: detail.path,
    log_path: detail.log_path,
    status: detail.status,
    active_phase: detail.active_phase,
    updated_at: detail.updated_at,
    adr_bindings: detail.adr_bindings,
    graph_binding_count: detail.graph_binding_count,
    slice_count: detail.slice_count,
    checkpoint_count: detail.checkpoint_count,
    operational_state: detail.operational_state,
  };
}

async function resolveArchivedPlanSnapshot(planId: string): Promise<{
  fileName: string;
  path: string;
  logFileName: string | null;
  logPath: string | null;
} | null> {
  const archiveRoot = resolve(getArchitectPlansRoot(), "archive");
  let entries: Array<{ isFile(): boolean; name: string }>;
  try {
    entries = await readdir(archiveRoot, { withFileTypes: true });
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") return null;
    throw error;
  }

  const prefix = `${planId}.`;
  const planFile = entries
    .filter((entry) => entry.isFile())
    .map((entry) => entry.name)
    .filter((name) => name.startsWith(prefix) && name.endsWith(".md") && !name.endsWith(".implementation-log.md"))
    .sort((left, right) => right.localeCompare(left))[0];
  if (!planFile) return null;

  const snapshotId = basename(planFile, ".md");
  const logFileName = entries.some((entry) => entry.isFile() && entry.name === `${snapshotId}.implementation-log.md`)
    ? `archive/${snapshotId}.implementation-log.md`
    : null;
  return {
    fileName: `archive/${planFile}`,
    path: `plans/archive/${planFile}`,
    logFileName,
    logPath: logFileName == null ? null : `plans/${logFileName}`,
  };
}

export async function loadPlanDetail(planId: string): Promise<ArchitectPlanDetail | null> {
  if (!isSafePlanId(planId)) return null;
  try {
    return await projectPlan(`${planId}.md`);
  } catch {
    const archived = await resolveArchivedPlanSnapshot(planId);
    if (!archived) return null;
    try {
      return await projectPlan(archived.fileName, {
        id: planId,
        path: archived.path,
        logFileName: archived.logFileName,
        logPath: archived.logPath,
      });
    } catch {
      return null;
    }
  }
}

function compactAuditValue(value: string | null | undefined): string | null {
  const normalized = value?.replace(/\s+/g, " ").trim() ?? "";
  return normalized.length > 0 ? normalized.replace(/`/g, "'") : null;
}

function auditLine(label: string, value: string | null | undefined): string | null {
  const compact = compactAuditValue(value);
  return compact == null ? null : `- ${label}: ${compact}`;
}

function buildPlanActionLogEntry(
  planId: string,
  timestamp: string,
  input: ArchitectPlanActionAuditInput,
): string {
  const action = compactAuditValue(input.action) ?? "unspecified";
  const sliceId = compactAuditValue(input.slice_id) ?? "standalone-architect-project-bound-chat-shell";
  const explicitStatus = compactAuditValue(input.status);
  const status = explicitStatus ?? (input.kind === "review_gate" ? "review_gate_recorded" : "action_recorded");
  const chatPlanUpdate = input.kind === "plan_action" && action === "chat_plan_update";
  const architectPassCompletion = input.kind === "plan_action" && action === "architect_pass_completed";
  const lines = [
    `### ${timestamp} — slice: ${sliceId} — status: ${status}`,
    "",
    `- Plan id: \`${planId}\``,
    "- Actor/session id: `standalone-architect-browser`",
    `- Action: recorded daemon-governed ${input.kind.replace("_", " ")} through \`/api/architect/v1\` without exposing direct filesystem authority`,
    `- Request action: \`${action}\``,
    `- Audit reason: ${compactAuditValue(input.audit_reason) ?? "not supplied"}`,
    auditLine("Actor", input.actor),
    auditLine("Gate id", input.gate_id),
    auditLine("Decision", input.decision),
    auditLine("Evidence", input.evidence),
    auditLine("Content", input.content),
    chatPlanUpdate
      ? "- Tool groups used: `/api/architect/v1/chat`, selected-plan markdown update, implementation-log projection"
      : architectPassCompletion
        ? "- Tool groups used: `/api/architect/v1/chat`, continuation envelope parsing, implementation-log projection"
        : "- Tool groups used: `/api/architect/v1/plans/{planId}/actions`, `/api/architect/v1/plans/{planId}/review-gates`, implementation-log projection",
    chatPlanUpdate
      ? "- Result: selected plan markdown was updated by the daemon and the request was captured in the append-only implementation log"
      : architectPassCompletion
        ? "- Result: successful Architect pass was captured as a completed implementation checkpoint for cursor projection"
        : "- Result: request captured in the append-only implementation log; no source patch was applied by the browser endpoint",
    `- Resume note: ${compactAuditValue(input.resume_note) ?? "continue from the project-bound Architect browser surface with daemon-governed chat, plan, review, and scheduler controls"}`,
  ].filter((line): line is string => line != null);

  return `${lines.join("\n")}\n`;
}

export async function recordPlanActionAudit(
  planId: string,
  input: ArchitectPlanActionAuditInput,
): Promise<ArchitectPlanActionAuditResult | null> {
  const detail = await loadPlanDetail(planId);
  if (!detail) return null;

  const timestamp = new Date().toISOString();
  const logFileName = `${planId}.implementation-log.md`;
  const logPath = resolve(getArchitectPlansRoot(), logFileName);
  const auditId = `${input.kind}:${timestamp}`;
  await appendFile(logPath, `\n${buildPlanActionLogEntry(planId, timestamp, input)}`, "utf-8");

  return {
    plan_id: detail.id,
    plan_path: detail.path,
    log_path: `plans/${logFileName}`,
    status: "recorded",
    changed: true,
    audit_id: auditId,
    action_kind: input.kind,
    action: compactAuditValue(input.action) ?? "unspecified",
    audit_reason: compactAuditValue(input.audit_reason) ?? "not supplied",
    markdown_refs: [detail.path, `plans/${logFileName}`],
    graph_refs: detail.registry.graph_bindings.slice(0, 8).map((binding) => `${binding.kind}:${binding.id}`),
    warnings: [],
    next_actions: [
      "Refresh the plan detail snapshot before presenting follow-up review controls.",
      "Require a separate governed endpoint before applying any source patch or graph mutation.",
    ],
  };
}
