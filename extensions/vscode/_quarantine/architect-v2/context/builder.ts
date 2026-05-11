// STRICT ISOLATION (ADR-140 + ADR-171 + ADR-176): no v1 imports; no
// mcp_dreamgraph_* imports; no vscode/fs/http imports. The builder is
// pure-shaped over ports. It is the single RelevanceEngine site for the
// Architect.
//
// Slice 8A.3 — Default ContextBuilder.
//
// Pipeline (per ADR-174 + ADR-176):
//   composer.declareRequirements(...)  ← runs upstream
//   buildContext({ requirements, ... }):
//     1. allocate budget per requirement (priority + budget hint)
//     2. for each requirement, dispatch to one of:
//          - ProjectGraphReader   (graph-shaped kinds)
//          - FallbackSignalProvider (non-graph kinds)
//        with transparent fallback when graph reader is sparse/absent
//     3. record provenance on every emitted section
//     4. record unmet requirements (could not satisfy)
//     5. return ContextEnvelope (never throws)

import type {
  BuildContextInput,
  ContextBuilderPort,
} from "../orchestrator/ports.js";
import type {
  ContextEnvelope,
  ContextSection,
  SectionProvenance,
  UnmetRequirement,
} from "../orchestrator/types.js";
import type {
  ProjectGraphNode,
  ProjectGraphReader,
  ProjectSubgraph,
} from "../orchestrator/project-graph.js";
import type {
  ContextRequirement,
  ContextRequirementBudget,
  ContextRequirementKind,
  ContextRequirementManifest,
} from "../prompts/index.js";
import type {
  DiagnosticSnapshot,
  FallbackSignalProvider,
  FileExcerpt,
  ProjectEntry,
  RecentHistorySnapshot,
  EnvironmentSnapshot,
} from "./fallback-signals.js";
import {
  NullContextDiscoveryRecorder,
  type ContextDiscovery,
  type ContextDiscoveryRecorder,
} from "./discovery-recorder.js";

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface DefaultContextBuilderDeps {
  readonly graphReader: ProjectGraphReader;
  readonly fallback: FallbackSignalProvider;
  /**
   * ADR-177: optional sink for incidental cognition discovered during
   * assembly (file URIs surfaced via fallback, graph nodes the task did
   * not previously reference). Defaults to no-op so single-source
   * deployments and tests do not have to wire a recorder. The builder
   * never blocks on this; failures are swallowed.
   */
  readonly discoveryRecorder?: ContextDiscoveryRecorder;
}

export class DefaultContextBuilder implements ContextBuilderPort {
  constructor(private readonly deps: DefaultContextBuilderDeps) {}

  async buildContext(input: BuildContextInput): Promise<ContextEnvelope> {
    return assembleContext(input, this.deps);
  }
}

// ---------------------------------------------------------------------------
// Core assembly
// ---------------------------------------------------------------------------

const GRAPH_KINDS: ReadonlySet<ContextRequirementKind> = new Set([
  "architectural_decisions",
  "adr_lineage",
  "unresolved_blockers",
  "prior_failed_attempts",
  "graph_neighborhood",
]);

const FALLBACK_KINDS: ReadonlySet<ContextRequirementKind> = new Set([
  "file_excerpts",
  "recent_history",
  "runtime_diagnostics",
  "environment_state",
]);

async function assembleContext(
  input: BuildContextInput,
  deps: DefaultContextBuilderDeps,
): Promise<ContextEnvelope> {
  const windowTokens = effectiveWindow(input);
  const manifest = input.requirements ?? emptyManifest();

  const allocations = allocateBudget(manifest, windowTokens);
  const sections: ContextSection[] = [];
  const unmet: UnmetRequirement[] = [];
  const discoveries: ContextDiscovery[] = [];

  for (const { requirement, tokenBudget } of allocations) {
    if (tokenBudget <= 0) {
      unmet.push({
        requirementKind: requirement.kind,
        reason: "budget_dropped",
        note: "No tokens left after higher-priority allocations.",
      });
      continue;
    }

    let satisfied: ContextSection[] = [];
    let satisfiedRefs: readonly string[] | undefined;
    let satisfiedVia: ContextDiscovery["via"] | undefined;
    let unmetReason: UnmetRequirement["reason"] | undefined;
    let unmetNote: string | undefined;

    if (GRAPH_KINDS.has(requirement.kind)) {
      const graphResult = await tryGraphRequirement(
        requirement,
        tokenBudget,
        deps,
        input,
      );
      if (graphResult.kind === "ok") {
        satisfied = graphResult.sections;
        satisfiedRefs = graphResult.artifactRefs;
        satisfiedVia = "project_graph";
      } else if (graphResult.kind === "fallback") {
        // Fall back to non-graph signals for this same requirement.
        const fallbackResult = await tryFallbackForGraphKind(
          requirement,
          tokenBudget,
          graphResult.fallbackReason,
          deps,
          input,
        );
        if (fallbackResult.kind === "ok") {
          satisfied = fallbackResult.sections;
          satisfiedRefs = fallbackResult.artifactRefs;
          satisfiedVia = "fallback";
        } else {
          unmetReason = fallbackResult.reason;
          unmetNote = fallbackResult.note;
        }
      } else {
        unmetReason = graphResult.reason;
        unmetNote = graphResult.note;
      }
    } else if (FALLBACK_KINDS.has(requirement.kind)) {
      const r = await tryFallbackRequirement(
        requirement,
        tokenBudget,
        deps,
        input,
      );
      if (r.kind === "ok") {
        satisfied = r.sections;
        satisfiedRefs = r.artifactRefs;
        satisfiedVia = "fallback";
      } else {
        unmetReason = r.reason;
        unmetNote = r.note;
      }
    } else {
      unmetReason = "no_signal_source";
      unmetNote = `Unknown requirement kind '${requirement.kind}'.`;
    }

    if (satisfied.length > 0) {
      for (const s of satisfied) sections.push(s);
      if (satisfiedRefs && satisfiedRefs.length > 0 && satisfiedVia) {
        discoveries.push({
          taskId: input.taskState.id,
          sourceRequirementKind: requirement.kind,
          via: satisfiedVia,
          artifactRefs: satisfiedRefs,
        });
      }
    } else {
      unmet.push({
        requirementKind: requirement.kind,
        reason: unmetReason ?? "fallback_empty",
        note: unmetNote,
      });
    }
  }

  // ADR-177: fire-and-forget incidental cognition write-back. Never blocks
  // assembly; failures are swallowed (the recorder has its own audit).
  if (discoveries.length > 0) {
    const recorder = deps.discoveryRecorder ?? NullContextDiscoveryRecorder;
    void safeCall(() => recorder.recordDiscoveries(discoveries), undefined);
  }

  const estimatedTokens = sections.reduce((acc, s) => acc + s.tokens, 0);

  return Object.freeze({
    schemaVersion: 1 as const,
    windowTokens,
    estimatedTokens,
    sections: Object.freeze(sections),
    unmetRequirements: Object.freeze(unmet),
  });
}

function emptyManifest(): ContextRequirementManifest {
  return Object.freeze({
    schemaVersion: 1 as const,
    requirements: Object.freeze([]),
    note: "no manifest supplied",
  });
}

function effectiveWindow(input: BuildContextInput): number {
  // 8A.5: host wiring resolves providerProfile.defaultModel.contextWindow
  // once at session start and threads it via input.windowTokens. When
  // absent (early tests, sparse-mode dry runs) we use a conservative
  // 16k floor. The composer (ADR-174 invariant) catches over-budget at
  // render time.
  if (typeof input.windowTokens === "number" && input.windowTokens > 0) {
    return input.windowTokens;
  }
  return 16_000;
}

// ---------------------------------------------------------------------------
// Budget allocation
// ---------------------------------------------------------------------------

interface Allocation {
  readonly requirement: ContextRequirement;
  readonly tokenBudget: number;
}

const BUDGET_WEIGHT: Readonly<Record<ContextRequirementBudget, number>> =
  Object.freeze({ small: 1, medium: 3, large: 6 });

/**
 * Pure budget allocator. Splits the window proportionally by
 * (priority + 1) * BUDGET_WEIGHT[budget]. Reserves ~25% of the window
 * for the prompt frame (system text, headers); the rest is split.
 */
export function allocateBudget(
  manifest: ContextRequirementManifest,
  windowTokens: number,
): readonly Allocation[] {
  if (manifest.requirements.length === 0) return [];

  const reserve = Math.max(512, Math.floor(windowTokens * 0.25));
  const usable = Math.max(0, windowTokens - reserve);

  const weighted = manifest.requirements.map((r) => ({
    r,
    w: ((r.priority ?? 0) + 1) * BUDGET_WEIGHT[r.budget],
  }));
  const totalW = weighted.reduce((a, x) => a + x.w, 0);

  return weighted.map(({ r, w }) => ({
    requirement: r,
    tokenBudget: totalW === 0 ? 0 : Math.floor((usable * w) / totalW),
  }));
}

// ---------------------------------------------------------------------------
// Graph requirement dispatch
// ---------------------------------------------------------------------------

type Outcome =
  | { kind: "ok"; sections: ContextSection[]; artifactRefs?: readonly string[] }
  | { kind: "fallback"; fallbackReason: NonNullable<SectionProvenance["fallbackReason"]> }
  | { kind: "unmet"; reason: UnmetRequirement["reason"]; note?: string };

/** Fallback dispatch can only succeed or report unmet — never re-trigger fallback. */
type FallbackOutcome =
  | { kind: "ok"; sections: ContextSection[]; artifactRefs?: readonly string[] }
  | { kind: "unmet"; reason: UnmetRequirement["reason"]; note?: string };

async function tryGraphRequirement(
  requirement: ContextRequirement,
  tokenBudget: number,
  deps: DefaultContextBuilderDeps,
  input: BuildContextInput,
): Promise<Outcome> {
  const richness = await safeCall(
    () => deps.graphReader.getRichnessSignal({ kind: "global" }),
    undefined,
  );
  if (!richness || richness.richness === "absent") {
    return { kind: "fallback", fallbackReason: "graph_absent" };
  }
  if (richness.richness === "sparse") {
    return { kind: "fallback", fallbackReason: "graph_sparse" };
  }

  const subgraph = await safeCall(
    () =>
      deps.graphReader.retrieveSubgraph({
        anchors: requirement.anchors,
        freeText: input.userIntent.text,
        maxNodes: nodesForBudget(tokenBudget),
        maxDepth: 2,
      }),
    undefined,
  );
  if (!subgraph) {
    return { kind: "fallback", fallbackReason: "graph_error" };
  }
  if (subgraph.nodes.length === 0) {
    return { kind: "fallback", fallbackReason: "graph_sparse" };
  }

  const section: ContextSection = makeSection({
    id: `graph:${requirement.kind}`,
    source: "graph",
    content: renderSubgraph(requirement.kind, subgraph),
    tokens: estimateTokens(renderSubgraph(requirement.kind, subgraph)),
    provenance: {
      requirementKind: requirement.kind,
      signalSource: "project_graph",
    },
  });
  const artifactRefs = collectGraphArtifactRefs(subgraph);
  return { kind: "ok", sections: [section], artifactRefs };
}

async function tryFallbackForGraphKind(
  requirement: ContextRequirement,
  tokenBudget: number,
  fallbackReason: NonNullable<SectionProvenance["fallbackReason"]>,
  deps: DefaultContextBuilderDeps,
  input: BuildContextInput,
): Promise<FallbackOutcome> {
  // For graph-shaped requirements, the best fallback is a shallow project
  // walk (gives the model orientation) plus, when relevant, file
  // excerpts of any anchors.
  const parts: string[] = [];
  const refs: string[] = [];

  if (requirement.anchors && requirement.anchors.length > 0) {
    const excerpts = await safeCall(
      () =>
        deps.fallback.readFileExcerpts({
          uris: requirement.anchors!,
          maxCharsPerFile: charsForBudget(tokenBudget) / requirement.anchors!.length,
        }),
      [] as readonly FileExcerpt[],
    );
    if (excerpts.length > 0) {
      parts.push(renderExcerpts(excerpts));
      for (const e of excerpts) refs.push(e.uri);
    }
  }

  if (parts.length === 0) {
    const walk = await safeCall(
      () => deps.fallback.walkProjectShallow(nodesForBudget(tokenBudget)),
      [] as readonly ProjectEntry[],
    );
    if (walk.length > 0) {
      parts.push(renderProjectWalk(walk, fallbackReason));
      for (const e of walk) refs.push(e.uri);
    }
  }

  if (parts.length === 0) {
    return {
      kind: "unmet",
      reason: "fallback_empty",
      note: `Fallback for '${requirement.kind}' produced no signals.`,
    };
  }

  const content = parts.join("\n\n");
  const section: ContextSection = makeSection({
    id: `fallback:${requirement.kind}`,
    source: "graph", // graph-shaped requirement; section group stays 'graph'
    content,
    tokens: estimateTokens(content),
    provenance: {
      requirementKind: requirement.kind,
      signalSource: "fallback",
      fallbackReason,
    },
  });
  void input;
  return { kind: "ok", sections: [section], artifactRefs: refs };
}

// ---------------------------------------------------------------------------
// Fallback (non-graph) requirement dispatch
// ---------------------------------------------------------------------------

async function tryFallbackRequirement(
  requirement: ContextRequirement,
  tokenBudget: number,
  deps: DefaultContextBuilderDeps,
  input: BuildContextInput,
): Promise<FallbackOutcome> {
  switch (requirement.kind) {
    case "environment_state": {
      const env = await safeCall(
        () => deps.fallback.readEnvironment(),
        undefined,
      );
      if (!env) return { kind: "unmet", reason: "source_error" };
      const content = renderEnvironment(env);
      return {
        kind: "ok",
        sections: [
          makeSection({
            id: "env:state",
            source: "environment",
            content,
            tokens: estimateTokens(content),
            provenance: {
              requirementKind: requirement.kind,
              signalSource: "fallback",
            },
          }),
        ],
      };
    }
    case "runtime_diagnostics": {
      const diags = await safeCall(
        () => deps.fallback.readRecentDiagnostics(itemsForBudget(tokenBudget)),
        [] as readonly DiagnosticSnapshot[],
      );
      if (diags.length === 0) {
        return { kind: "unmet", reason: "fallback_empty" };
      }
      const content = renderDiagnostics(diags);
      return {
        kind: "ok",
        sections: [
          makeSection({
            id: "diag:recent",
            source: "environment",
            content,
            tokens: estimateTokens(content),
            provenance: {
              requirementKind: requirement.kind,
              signalSource: "fallback",
            },
          }),
        ],
      };
    }
    case "recent_history": {
      const hist = await safeCall(
        () =>
          deps.fallback.readRecentHistory(
            input.taskState.id,
            itemsForBudget(tokenBudget),
          ),
        undefined,
      );
      if (!hist || hist.priorPassDeltas.length === 0) {
        return { kind: "unmet", reason: "fallback_empty" };
      }
      const content = renderHistory(hist);
      return {
        kind: "ok",
        sections: [
          makeSection({
            id: "history:recent",
            source: "history",
            content,
            tokens: estimateTokens(content),
            provenance: {
              requirementKind: requirement.kind,
              signalSource: "fallback",
            },
          }),
        ],
      };
    }
    case "file_excerpts": {
      if (!requirement.anchors || requirement.anchors.length === 0) {
        return { kind: "unmet", reason: "no_signal_source", note: "no anchors" };
      }
      const excerpts = await safeCall(
        () =>
          deps.fallback.readFileExcerpts({
            uris: requirement.anchors!,
            maxCharsPerFile: charsForBudget(tokenBudget) / requirement.anchors!.length,
          }),
        [] as readonly FileExcerpt[],
      );
      if (excerpts.length === 0) {
        return { kind: "unmet", reason: "fallback_empty" };
      }
      const content = renderExcerpts(excerpts);
      return {
        kind: "ok",
        sections: [
          makeSection({
            id: "file:excerpts",
            source: "file",
            content,
            tokens: estimateTokens(content),
            provenance: {
              requirementKind: requirement.kind,
              signalSource: "fallback",
            },
          }),
        ],
        artifactRefs: excerpts.map((e) => e.uri),
      };
    }
    default: {
      return {
        kind: "unmet",
        reason: "no_signal_source",
        note: `No fallback handler for '${requirement.kind}'.`,
      };
    }
  }
}

// ---------------------------------------------------------------------------
// Renderers — plain text, deterministic, no emojis
// ---------------------------------------------------------------------------

function renderSubgraph(
  kind: ContextRequirementKind,
  sub: ProjectSubgraph,
): string {
  const lines: string[] = [];
  lines.push(`(${kind}: ${sub.nodes.length} node(s), ${sub.edges.length} edge(s)${sub.truncated ? ", truncated" : ""})`);
  for (const n of sub.nodes) lines.push(formatNode(n));
  for (const e of sub.edges) {
    lines.push(`  ${e.fromId} --[${e.relation}]--> ${e.toId}`);
  }
  return lines.join("\n");
}

function formatNode(n: ProjectGraphNode): string {
  const uri = n.uri ? ` <${n.uri}>` : "";
  return `- [${n.kind}] ${n.label} (${n.id})${uri}`;
}

function renderEnvironment(env: EnvironmentSnapshot): string {
  const lines: string[] = [];
  lines.push(`os: ${env.osPlatform}`);
  lines.push(`host: ${env.editorHostName}`);
  if (env.workspaceName) lines.push(`workspace: ${env.workspaceName}`);
  if (env.openFolderUris.length > 0) {
    lines.push(`folders: ${env.openFolderUris.join(", ")}`);
  }
  if (env.activeFileUri) lines.push(`active: ${env.activeFileUri}`);
  if (env.extras) {
    for (const [k, v] of Object.entries(env.extras)) lines.push(`${k}: ${v}`);
  }
  return lines.join("\n");
}

function renderDiagnostics(diags: readonly DiagnosticSnapshot[]): string {
  return diags
    .map(
      (d) =>
        `[${d.severity}] ${d.fileUri}${
          d.line !== undefined ? `:${d.line}` : ""
        } ${d.source ? `(${d.source}) ` : ""}${d.message}`,
    )
    .join("\n");
}

function renderHistory(h: RecentHistorySnapshot): string {
  const lines: string[] = [];
  if (h.taskIntentDigest) lines.push(`intent: ${h.taskIntentDigest}`);
  for (const [i, d] of h.priorPassDeltas.entries()) {
    lines.push(`pass ${i}: ${d}`);
  }
  return lines.join("\n");
}

function renderExcerpts(excerpts: readonly FileExcerpt[]): string {
  return excerpts
    .map((e) => {
      const head = `--- ${e.uri}${e.truncated ? " (truncated)" : ""} ---`;
      return `${head}\n${e.content}`;
    })
    .join("\n\n");
}

function renderProjectWalk(
  entries: readonly ProjectEntry[],
  fallbackReason?: NonNullable<SectionProvenance["fallbackReason"]>,
): string {
  // The header reflects WHY we fell back. Saying "graph absent" when the
  // graph is actually rich (we just couldn't anchor a sub-query) misled
  // the model into planning a `scan_project` it doesn't need.
  let header: string;
  switch (fallbackReason) {
    case "graph_sparse":
      header =
        "(graph available but no anchors matched this query — shallow project walk)";
      break;
    case "graph_error":
      header = "(graph query failed — shallow project walk)";
      break;
    case "graph_absent":
    default:
      header = "(graph absent — shallow project walk)";
      break;
  }
  const lines: string[] = [header];
  for (const e of entries) {
    lines.push(`${e.kind === "directory" ? "d" : "f"} ${e.relPath ?? e.uri}`);
  }
  return lines.join("\n");
}

function collectGraphArtifactRefs(sub: ProjectSubgraph): readonly string[] {
  const refs: string[] = [];
  for (const n of sub.nodes) {
    refs.push(n.uri ?? n.id);
  }
  return refs;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeSection(s: {
  id: string;
  source: ContextSection["source"];
  content: string;
  tokens: number;
  provenance: SectionProvenance;
}): ContextSection {
  return Object.freeze({
    id: s.id,
    source: s.source,
    content: s.content,
    tokens: s.tokens,
    provenance: Object.freeze(s.provenance),
  });
}

/**
 * Cheap deterministic token estimator. Real assemblers may swap in a
 * provider-specific tokenizer via 8A.5; for the skeleton, ~4 chars per
 * token is the standard rough heuristic.
 */
function estimateTokens(s: string): number {
  return Math.max(1, Math.ceil(s.length / 4));
}

function charsForBudget(tokens: number): number {
  return Math.max(64, tokens * 4);
}

function nodesForBudget(tokens: number): number {
  // ~10 tokens per node line average; cap at 100 to keep prompts focused.
  return Math.min(100, Math.max(5, Math.floor(tokens / 10)));
}

function itemsForBudget(tokens: number): number {
  return Math.min(50, Math.max(3, Math.floor(tokens / 20)));
}

async function safeCall<T>(fn: () => Promise<T>, fallback: T): Promise<T> {
  try {
    return await fn();
  } catch {
    return fallback;
  }
}
