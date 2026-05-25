import { describe, expect, it } from "vitest";
import {
  harvestRemediationFutureSignals,
  scoreCandidateFuture,
  validateCandidateFuture,
  validateRemediationDraft,
} from "../src/cognitive/intervention.js";
import type { RemediationEvidenceBundle } from "../src/cognitive/types.js";

const bundle: RemediationEvidenceBundle = {
  id: "bundle-tension-remediation",
  tension_id: "tension-remediation",
  tension_type: "code_insight",
  urgency: 0.92,
  description: "Validate LLM-authored remediation candidates before surfacing them.",
  entities: ["feature_adaptive_future_engine"],
  evidence_anchors: [
    {
      kind: "graph_entity",
      id: "feature_adaptive_future_engine",
      summary: "Adaptive Future Engine is the scoped remediation planning feature.",
    },
    {
      kind: "source_anchor",
      id: "src/cognitive/intervention.ts",
      summary: "Source binding for remediation planning implementation.",
    },
    {
      kind: "adr",
      id: "ADR-203",
      summary: "LLM-enabled tools must route through connected, daemon, then deterministic fallback.",
    },
  ],
  entity_summaries: [
    {
      id: "feature_adaptive_future_engine",
      exists: true,
      source_files: ["src/cognitive/intervention.ts"],
      domain: "core",
    },
  ],
  adr_guard_rails: [
    {
      adr_id: "ADR-203",
      title: "LLM Tool Routing And Fallback Order",
      guard_rails: ["Do not surface LLM-generated output until validation passes."],
    },
  ],
  allowed_action_classes: ["source_change", "graph_enrichment"],
  deterministic_short_circuit: "none",
  verification_obligations: [
    {
      id: "verify-remediation-drafting",
      description: "Run focused remediation drafting validation tests.",
      command: "npm test -- remediation-drafting-validation.test.ts",
      evidence_anchor_ids: ["feature_adaptive_future_engine"],
    },
  ],
};

function validCandidate(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "candidate-source-change",
    title: "Validate remediation drafting before use",
    action_class: "source_change",
    evidence_anchor_ids: ["feature_adaptive_future_engine", "ADR-203"],
    verification_steps: [
      {
        id: "run-focused-tests",
        description: "Run the focused remediation drafting validation tests.",
        command: "npm test -- remediation-drafting-validation.test.ts",
        evidence_anchor_ids: ["feature_adaptive_future_engine"],
      },
    ],
    graph_sync_impact: {
      required: true,
      targets: ["features", "api_surface"],
      rationale: "Validation behavior and exported API surface changed.",
    },
    future_fit_score: 1.2,
    objections: [
      {
        id: "test-only-confidence",
        description: "Focused validation tests do not replace full build verification.",
        evidence_anchor_ids: ["ADR-203"],
        severity: "medium",
      },
    ],
    ...overrides,
  };
}

describe("validateCandidateFuture", () => {
  it("accepts schema-valid remediation candidates and clamps future-fit score", () => {
    const candidate = validateCandidateFuture(validCandidate(), bundle);

    expect(candidate).toMatchObject({
      id: "candidate-source-change",
      title: "Validate remediation drafting before use",
      action_class: "source_change",
      evidence_anchor_ids: ["feature_adaptive_future_engine", "ADR-203"],
      graph_sync_impact: {
        required: true,
        targets: ["features", "api_surface"],
        rationale: "Validation behavior and exported API surface changed.",
      },
      future_fit_score: 1,
      objections: [
        {
          id: "test-only-confidence",
          description: "Focused validation tests do not replace full build verification.",
          evidence_anchor_ids: ["ADR-203"],
          severity: "medium",
        },
      ],
    });
    expect(candidate?.verification_steps).toEqual([
      {
        id: "run-focused-tests",
        description: "Run the focused remediation drafting validation tests.",
        command: "npm test -- remediation-drafting-validation.test.ts",
        evidence_anchor_ids: ["feature_adaptive_future_engine"],
      },
    ]);
  });

  it("rejects unsupported action classes", () => {
    expect(validateCandidateFuture(validCandidate({ action_class: "delete_everything" }), bundle)).toBeUndefined();
  });

  it("rejects unknown top-level evidence anchors", () => {
    expect(
      validateCandidateFuture(
        validCandidate({ evidence_anchor_ids: ["feature_adaptive_future_engine", "missing-anchor"] }),
        bundle,
      ),
    ).toBeUndefined();
  });

  it("rejects candidates with no valid verification path", () => {
    expect(
      validateCandidateFuture(
        validCandidate({
          verification_steps: [
            {
              id: "bad-verification",
              description: "References invented evidence.",
              evidence_anchor_ids: ["missing-anchor"],
            },
          ],
        }),
        bundle,
      ),
    ).toBeUndefined();
  });

  it("rejects unsupported graph sync targets", () => {
    expect(
      validateCandidateFuture(
        validCandidate({
          graph_sync_impact: {
            required: true,
            targets: ["raw_prompt_store"],
            rationale: "Invalid graph sync target should not pass validation.",
          },
        }),
        bundle,
      ),
    ).toBeUndefined();
  });

  it("drops malformed objections instead of surfacing partial objection records", () => {
    const candidate = validateCandidateFuture(
      validCandidate({
        objections: [
          {
            id: "missing-anchor-objection",
            description: "This objection is missing evidence anchors.",
            severity: "high",
          },
        ],
      }),
      bundle,
    );

    expect(candidate?.objections).toEqual([]);
  });
});

describe("future-fit scoring", () => {
  it("harvests scoped future signals only from known evidence anchors", () => {
    const signals = harvestRemediationFutureSignals(bundle, "source_change");

    expect(signals.map((signal) => signal.source)).toEqual(
      expect.arrayContaining(["explicit_preference", "accepted", "recurring_pattern"]),
    );
    expect(signals.every((signal) => signal.evidence_anchor_ids.length > 0)).toBe(true);
    expect(
      signals.every((signal) =>
        signal.evidence_anchor_ids.every((anchorId) =>
          bundle.evidence_anchors.some((anchor) => anchor.id === anchorId),
        ),
      ),
    ).toBe(true);
  });

  it("scores preferred, source-anchored candidates above valid but misaligned candidates", () => {
    const signals = harvestRemediationFutureSignals(bundle, "source_change");
    const preferred = validateCandidateFuture(
      validCandidate({ evidence_anchor_ids: ["feature_adaptive_future_engine", "src/cognitive/intervention.ts", "ADR-203"] }),
      bundle,
    );
    const misaligned = validateCandidateFuture(
      validCandidate({
        id: "candidate-graph-enrichment",
        action_class: "graph_enrichment",
        evidence_anchor_ids: ["feature_adaptive_future_engine", "ADR-203"],
        future_fit_score: 0.8,
      }),
      bundle,
    );

    expect(preferred).toBeDefined();
    expect(misaligned).toBeDefined();

    const preferredScore = scoreCandidateFuture(preferred!, bundle, signals, "source_change");
    const misalignedScore = scoreCandidateFuture(misaligned!, bundle, signals, "source_change");

    expect(preferredScore.future_fit_score).toBeGreaterThan(misalignedScore.future_fit_score ?? 0);
    expect(misalignedScore.objections).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "future_objection:candidate-graph-enrichment:strategy_mismatch",
          severity: "medium",
        }),
      ]),
    );
  });

  it("does not rescue candidates that fail hard validation constraints", () => {
    const invalid = validateCandidateFuture(
      validCandidate({
        id: "invalid-but-high-score",
        action_class: "delete_everything",
        future_fit_score: 1,
      }),
      bundle,
    );

    expect(invalid).toBeUndefined();
  });

  it("keeps rejected-but-valid candidates explainable with future objections", () => {
    const candidate = validateCandidateFuture(
      validCandidate({
        id: "source-without-source-anchor",
        evidence_anchor_ids: ["feature_adaptive_future_engine", "ADR-203"],
        future_fit_score: 0.9,
      }),
      bundle,
    );

    expect(candidate).toBeDefined();
    const scored = scoreCandidateFuture(
      candidate!,
      bundle,
      harvestRemediationFutureSignals(bundle, "source_change"),
      "source_change",
    );

    expect(scored.objections).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "future_objection:source-without-source-anchor:no_source_anchor",
          severity: "high",
        }),
      ]),
    );
  });
});

describe("validateRemediationDraft", () => {
  it("keeps only candidates that pass schema and evidence validation", () => {
    const candidates = validateRemediationDraft(
      {
        candidates: [
          validCandidate({ id: "valid-one" }),
          validCandidate({ id: "invalid-action", action_class: "unknown" }),
          validCandidate({ id: "invalid-anchor", evidence_anchor_ids: ["missing-anchor"] }),
        ],
      },
      bundle,
    );

    expect(candidates.map((candidate) => candidate.id)).toEqual(["valid-one"]);
  });

  it("rejects malformed draft envelopes", () => {
    expect(validateRemediationDraft({ candidates: "not-an-array" }, bundle)).toEqual([]);
    expect(validateRemediationDraft(undefined, bundle)).toEqual([]);
  });
});

describe('Slice 5 adaptive future persistence', () => {
  it('keeps the remediation log sidecar bounded and metric-backed', async () => {
    const { readFile } = await import('node:fs/promises');
    const source = await readFile('src/cognitive/intervention.ts', 'utf8');

    expect(source).toContain('adaptive_future');
    expect(source).toContain('signals');
    expect(source).toContain('outcomes');
    expect(source).toContain('candidate_runs');
    expect(source).toContain('metrics');
    expect(source).toContain('average_future_fit_score');
    expect(source).toContain('MAX_REMEDIATION_FUTURE_SIGNALS');
    expect(source).toContain('MAX_REMEDIATION_FUTURE_OUTCOMES');
    expect(source).toContain('MAX_REMEDIATION_CANDIDATE_RUNS');
  });

  it('persists adaptive future audit data without storing prompts or secrets', async () => {
    const { readFile } = await import('node:fs/promises');
    const source = await readFile('src/cognitive/intervention.ts', 'utf8');

    expect(source).toContain('candidate_runs');
    expect(source).toContain('fallback_used');
    expect(source).toContain('selected_source');
    expect(source).toContain('future_fit_score');
    expect(source).not.toContain('prompt_text');
    expect(source).not.toContain('raw_prompt');
    expect(source).not.toContain('api_key');
  });
});
