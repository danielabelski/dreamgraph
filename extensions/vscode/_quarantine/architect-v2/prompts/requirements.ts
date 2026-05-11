// STRICT ISOLATION (ADR-140 + ADR-171 + ADR-174): no v1 imports; no graph,
// MCP, vscode, fs, http, or executor imports. This module is pure data +
// pure functions. It is the *declarative seam* between the prompt layer
// (which knows what a particular pass *needs*) and the assembler layer
// (which knows how to *retrieve* it).
//
// Slice 8A.2 — Context requirements manifest.
//
// HARD CONTRACT (per ADR-174):
//   declareContextRequirements is pure. Same inputs → identical, deeply-
//   equal manifest. The composer publishes a wishlist; the assembler
//   decides what is feasible against the active provider window and the
//   project graph's actual richness.
//
//   The assembler MAY satisfy fewer requirement kinds than declared (e.g.
//   sparse-mode: no ADR lineage available). The composer MUST tolerate
//   this — missing kinds are not an error, they are a signal the
//   assembler will surface via section provenance in 8A.3.

import type { TaskState } from "../autonomy/index.js";
import type { CapabilityId } from "../capabilities/index.js";
import type { UserIntent } from "../orchestrator/types.js";

// ---------------------------------------------------------------------------
// Requirement vocabulary
// ---------------------------------------------------------------------------

/**
 * Closed enumeration of context kinds the composer may request. Adding a
 * kind requires an ADR amendment (per ADR-174 guard rails) so the
 * assembler can enumerate exhaustive support.
 *
 * Kinds map roughly to:
 *   - Decision history    : architectural_decisions, adr_lineage
 *   - Open work           : unresolved_blockers, prior_failed_attempts
 *   - Code surface        : graph_neighborhood, file_excerpts
 *   - Operational signals : recent_history, runtime_diagnostics, environment_state
 */
export type ContextRequirementKind =
  | "architectural_decisions"
  | "adr_lineage"
  | "unresolved_blockers"
  | "prior_failed_attempts"
  | "graph_neighborhood"
  | "file_excerpts"
  | "recent_history"
  | "runtime_diagnostics"
  | "environment_state";

/**
 * Coarse budget hint. The assembler converts this to a token allocation
 * against the active provider window — there is intentionally no token
 * count here, because the composer does not know the window size.
 */
export type ContextRequirementBudget = "small" | "medium" | "large";

/**
 * One declared requirement. `anchors` are opaque ids the assembler can
 * use to focus retrieval (file paths, capability ids, ADR ids, etc.);
 * the composer may leave it empty when it has no anchor in mind.
 */
export interface ContextRequirement {
  readonly kind: ContextRequirementKind;
  readonly budget: ContextRequirementBudget;
  /** Human-readable reason this requirement was declared (audit + tests). */
  readonly rationale: string;
  /** Optional anchors (paths, capability ids, ADR ids, node ids). */
  readonly anchors?: readonly string[];
  /**
   * Optional priority within the manifest. Higher = the assembler should
   * satisfy this first when budget pressure forces choices. Defaults to 0.
   */
  readonly priority?: number;
}

export interface ContextRequirementManifest {
  readonly schemaVersion: 1;
  readonly requirements: readonly ContextRequirement[];
  /**
   * Free-form note explaining *why this manifest looks like this*, for
   * golden-file diffs and audit. Not consumed by the assembler.
   */
  readonly note: string;
}

// ---------------------------------------------------------------------------
// Inputs to declaration
// ---------------------------------------------------------------------------

export interface DeclareRequirementsInput {
  readonly userIntent: UserIntent;
  readonly taskState: TaskState;
  /**
   * Optional capability hint. Continuations carry one (the action they
   * intend to retry); fresh user turns usually do not. The composer uses
   * this to add capability-specific requirement kinds.
   */
  readonly capabilityHint?: CapabilityId;
}

// ---------------------------------------------------------------------------
// Pure declaration
// ---------------------------------------------------------------------------

/**
 * Build the requirement manifest for the upcoming pass.
 *
 * Pure: same inputs → deeply-equal output. No clock, no randomness.
 * No I/O. No graph access. No MCP calls. No filesystem.
 */
export function declareContextRequirements(
  input: DeclareRequirementsInput,
): ContextRequirementManifest {
  const reqs: ContextRequirement[] = [];

  // Always: environment + recent history. These are the cheapest signals
  // and a composer with neither produces context-free prompts.
  reqs.push({
    kind: "environment_state",
    budget: "small",
    rationale: "Provider/window/mode banner so the model knows where it is.",
    priority: 10,
  });

  if (input.taskState.passes.length > 0) {
    reqs.push({
      kind: "recent_history",
      budget: input.taskState.passes.length > 3 ? "medium" : "small",
      rationale: "Prior pass deltas so the model can build on what was just done.",
      priority: 9,
    });
  }

  // Continuation-driven needs: the model just tried something. Show it
  // what got in the way last time.
  if (input.userIntent.continuation) {
    reqs.push({
      kind: "prior_failed_attempts",
      budget: "medium",
      rationale: "This pass is a continuation; surface the prior attempt's outcome.",
      priority: 8,
    });
    reqs.push({
      kind: "unresolved_blockers",
      budget: "small",
      rationale: "Continuations frequently chain through blockers; show open ones.",
      priority: 7,
    });
  }

  // Capability hint: pull capability-shaped context.
  if (input.capabilityHint) {
    for (const r of capabilityShapedRequirements(input.capabilityHint)) {
      reqs.push(r);
    }
  } else {
    // Fresh user turn — we don't know the capability yet, so request a
    // broad shallow neighborhood the assembler can rank against intent text.
    reqs.push({
      kind: "graph_neighborhood",
      budget: "medium",
      rationale: "Fresh user intent; broad shallow graph context for ranking.",
      priority: 6,
    });
    reqs.push({
      kind: "architectural_decisions",
      budget: "small",
      rationale: "Surface relevant ADRs that constrain the response.",
      priority: 5,
    });
  }

  // Attachment-driven needs: the user pointed at specific files/urls.
  if (input.userIntent.attachments && input.userIntent.attachments.length > 0) {
    const fileAnchors = input.userIntent.attachments
      .filter((a) => a.kind === "file" || a.kind === "selection")
      .map((a) => a.uri);
    if (fileAnchors.length > 0) {
      reqs.push({
        kind: "file_excerpts",
        budget: "large",
        rationale: "User attached files/selections; include them verbatim.",
        anchors: fileAnchors,
        priority: 11, // higher than environment: user attachments are explicit
      });
    }
  }

  // De-dupe by kind+anchors-signature, preserving first-seen order; keeps
  // the manifest stable when both fresh-turn and continuation paths
  // happen to declare the same kind.
  const deduped = dedupe(reqs);

  return Object.freeze({
    schemaVersion: 1 as const,
    requirements: Object.freeze(deduped),
    note: buildNote(input, deduped),
  });
}

// ---------------------------------------------------------------------------
// Capability-shaped requirements
// ---------------------------------------------------------------------------

function capabilityShapedRequirements(
  capabilityId: CapabilityId,
): readonly ContextRequirement[] {
  // Capability ids in v2 are dotted strings: 'edit.file', 'verify.build', etc.
  // We bucket by the leading segment; sub-slice 8B may refine further.
  const head = capabilityId.split(".")[0];
  switch (head) {
    case "edit":
    case "patch":
      return [
        {
          kind: "file_excerpts",
          budget: "large",
          rationale: `Capability '${capabilityId}' mutates code; include target file context.`,
          priority: 8,
        },
        {
          kind: "graph_neighborhood",
          budget: "medium",
          rationale: "Show callers/dependents of the mutation site.",
          priority: 6,
        },
        {
          kind: "adr_lineage",
          budget: "small",
          rationale: "Surface ADRs governing the touched modules.",
          priority: 5,
        },
      ];
    case "verify":
      return [
        {
          kind: "runtime_diagnostics",
          budget: "medium",
          rationale: `Capability '${capabilityId}' is verification; show recent diagnostics.`,
          priority: 8,
        },
        {
          kind: "prior_failed_attempts",
          budget: "small",
          rationale: "Verification often follows a mutation; show what was attempted.",
          priority: 6,
        },
      ];
    case "explain":
    case "explore":
    case "search":
      return [
        {
          kind: "graph_neighborhood",
          budget: "large",
          rationale: `Capability '${capabilityId}' is read-only; broaden graph context.`,
          priority: 8,
        },
        {
          kind: "architectural_decisions",
          budget: "medium",
          rationale: "Frame the explanation around recorded decisions.",
          priority: 6,
        },
      ];
    case "decide":
    case "design":
      return [
        {
          kind: "architectural_decisions",
          budget: "large",
          rationale: `Capability '${capabilityId}' produces a decision; show ADR lineage.`,
          priority: 9,
        },
        {
          kind: "adr_lineage",
          budget: "medium",
          rationale: "Surface the closest existing ADRs for context.",
          priority: 8,
        },
        {
          kind: "unresolved_blockers",
          budget: "small",
          rationale: "Decisions often resolve open blockers.",
          priority: 6,
        },
      ];
    default:
      return [
        {
          kind: "graph_neighborhood",
          budget: "medium",
          rationale: `Unknown capability head '${head}'; default to shallow graph context.`,
          priority: 5,
        },
      ];
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function dedupe(
  reqs: readonly ContextRequirement[],
): readonly ContextRequirement[] {
  const seen = new Set<string>();
  const out: ContextRequirement[] = [];
  for (const r of reqs) {
    const key = `${r.kind}|${(r.anchors ?? []).join(",")}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(Object.freeze(r));
  }
  // Stable order: by priority desc, then kind asc — the assembler may
  // re-order, but the manifest itself is canonical for golden-file tests.
  out.sort((a, b) => {
    const pa = a.priority ?? 0;
    const pb = b.priority ?? 0;
    if (pa !== pb) return pb - pa;
    return a.kind.localeCompare(b.kind);
  });
  return out;
}

function buildNote(
  input: DeclareRequirementsInput,
  reqs: readonly ContextRequirement[],
): string {
  const parts: string[] = [];
  parts.push(`mode=${input.taskState.mode}`);
  parts.push(`passes=${input.taskState.passes.length}`);
  if (input.userIntent.continuation) parts.push("continuation");
  if (input.capabilityHint) parts.push(`cap=${input.capabilityHint}`);
  if (input.userIntent.attachments && input.userIntent.attachments.length > 0) {
    parts.push(`attachments=${input.userIntent.attachments.length}`);
  }
  parts.push(`reqs=${reqs.length}`);
  return parts.join(" ");
}
