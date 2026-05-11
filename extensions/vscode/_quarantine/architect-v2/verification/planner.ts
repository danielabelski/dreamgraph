// STRICT ISOLATION (ADR-140): no import from v1.
// Slice 7 — Verification planner.
//
// Pure mapping from a Slice-6 source capability to the
// `VerificationStep[]` that must follow before the task may claim
// completion. The mapping is a frozen table (Slice 7 plan §1) — no
// switch logic, no I/O.
//
// `planVerifications(capabilityId, mutationOutcome)` consults
// `VERIFICATION_PLAN_TABLE` and returns the steps. The orchestrator
// (post-cutover) then asks Slice 6 to choose a path for each step's
// `performedBy` capability and Slice 4 to execute it.

import type { CapabilityId } from "../capabilities/index.js";
import type { ToolOutcome } from "../execution/index.js";
import type {
  VerificationKind,
  VerificationPlan,
  VerificationReason,
  VerificationStep,
} from "./types.js";

/**
 * Slice-7 mapping: which VerificationKind is performed by which Slice-6
 * capability. Used to turn the abstract "this needs a build check" into
 * a concrete capability the orchestrator can route through Slice 6.
 */
export const VERIFICATION_PERFORMED_BY: Readonly<
  Record<VerificationKind, CapabilityId>
> = Object.freeze({
  build: "verify.build",
  test: "verify.test",
  type: "verify.type",
  lint: "verify.lint",
  mcp_verify: "verify.discipline",
  invariant: "verify.invariant",
});

interface PlanEntry {
  readonly kinds: readonly VerificationKind[];
  readonly reason: VerificationReason;
}

const NONE: PlanEntry = Object.freeze({
  kinds: Object.freeze([]) as readonly VerificationKind[],
  reason: "mutation_compile_check",
});

/**
 * Frozen lookup from CapabilityId -> required verification kinds.
 * Mirrors Slice 7 plan §1 table 1:1. Read-only / cognition / env-IO
 * capabilities map to NONE.
 */
export const VERIFICATION_PLAN_TABLE: Readonly<Record<CapabilityId, PlanEntry>> =
  Object.freeze({
    // --- Navigation & search (read-only) ---
    "navigate.symbol": NONE,
    "navigate.references": NONE,
    "read.file": NONE,
    "read.dir": NONE,
    "read.markdown.chapter": NONE,
    "search.text": NONE,
    "search.semantic": NONE,
    "search.api": NONE,
    "search.data_model": NONE,
    "search.ui": NONE,

    // --- History & rationale (read-only) ---
    "read.history.git": NONE,
    "read.adr": NONE,
    "read.workflow": NONE,
    "read.narrative": NONE,
    "explain.causal": NONE,
    "explain.temporal": NONE,
    "plan.remediation": NONE,
    "memory.recall": NONE,

    // --- Mutation: compile + build ---
    "mutate.file.create": Object.freeze({
      kinds: Object.freeze(["type", "build"] as const) as readonly VerificationKind[],
      reason: "mutation_compile_check" as const,
    }),
    "mutate.file.edit": Object.freeze({
      kinds: Object.freeze(["type", "build"] as const) as readonly VerificationKind[],
      reason: "mutation_compile_check" as const,
    }),
    "mutate.file.patch": Object.freeze({
      kinds: Object.freeze(["type", "build"] as const) as readonly VerificationKind[],
      reason: "mutation_compile_check" as const,
    }),
    "mutate.file.append": Object.freeze({
      kinds: Object.freeze(["type", "build"] as const) as readonly VerificationKind[],
      reason: "mutation_compile_check" as const,
    }),
    "mutate.file.delete_rename": Object.freeze({
      kinds: Object.freeze(["type", "build"] as const) as readonly VerificationKind[],
      reason: "mutation_compile_check" as const,
    }),
    "mutate.markdown.chapter": Object.freeze({
      kinds: Object.freeze(["lint"] as const) as readonly VerificationKind[],
      reason: "markdown_structure_check" as const,
    }),
    "mutate.api.surface": Object.freeze({
      kinds: Object.freeze(["type", "test"] as const) as readonly VerificationKind[],
      reason: "mutation_behavior_check" as const,
    }),
    "mutate.graph.wire": Object.freeze({
      kinds: Object.freeze(["mcp_verify", "invariant"] as const) as readonly VerificationKind[],
      reason: "graph_invariant_check" as const,
    }),
    "mutate.entity.edit": Object.freeze({
      kinds: Object.freeze(["mcp_verify", "invariant"] as const) as readonly VerificationKind[],
      reason: "graph_invariant_check" as const,
    }),

    // --- Verification capabilities (no recursion) ---
    "verify.build": NONE,
    "verify.test": NONE,
    "verify.type": NONE,
    "verify.lint": NONE,
    "verify.discipline": NONE,
    "verify.invariant": NONE,

    // --- Cognition (read-only) ---
    "memory.persist": NONE,
    "cognition.dream": NONE,
    "cognition.tension.resolve": NONE,
    "task.create_continuation": NONE,

    // --- Environment ---
    "env.web.fetch": NONE,
    "env.terminal.run": NONE, // caller flags via mutationOutcome if mutating
    "env.clipboard": NONE,
    "env.diagnostics.live": NONE,
    "env.lm.invoke_tool": NONE,
  });

/**
 * Plan the verifications required for one source-capability invocation.
 * Pure: same `(capabilityId, mutationOutcome)` always returns the same
 * `VerificationPlan`.
 *
 * `mutationOutcome` is currently consumed only to early-exit on
 * non-success outcomes (no point planning verification for a mutation
 * that never produced an artifact). The orchestrator calls
 * `classifyCompletion` with `mutation_failed` in that case.
 */
export function planVerifications(
  capabilityId: CapabilityId,
  mutationOutcome: ToolOutcome,
): VerificationPlan {
  // Failed mutations never warrant verification; the harness produces
  // `mutation_failed` instead. We still return an empty plan so the
  // call site can uniformly thread VerificationPlan through.
  if (mutationOutcome.kind === "failure") {
    return Object.freeze({
      sourceCapability: capabilityId,
      steps: Object.freeze([]) as readonly VerificationStep[],
    });
  }

  const entry = VERIFICATION_PLAN_TABLE[capabilityId];
  if (entry.kinds.length === 0) {
    return Object.freeze({
      sourceCapability: capabilityId,
      steps: Object.freeze([]) as readonly VerificationStep[],
    });
  }

  const steps: VerificationStep[] = entry.kinds.map((k) =>
    Object.freeze({
      kind: k,
      reason: entry.reason,
      performedBy: VERIFICATION_PERFORMED_BY[k],
    }),
  );
  return Object.freeze({
    sourceCapability: capabilityId,
    steps: Object.freeze(steps) as readonly VerificationStep[],
  });
}
