import { afterEach, describe, expect, it } from "vitest";
import { compileTaskPreamble } from "../src/cognitive/graph-rag.js";
import { initLlmProvider } from "../src/cognitive/llm.js";
import type { TaskPreambleEvidenceItem } from "../src/cognitive/types.js";

const remediationEvidence: TaskPreambleEvidenceItem = {
  anchor: "feature_adaptive_future_engine",
  kind: "graph_entity",
  summary: "Adaptive Future Engine remediation planning must preserve deterministic fallback behavior.",
  confidence: 0.9,
  priority: 0.9,
};

describe("compileTaskPreamble", () => {
  afterEach(() => {
    initLlmProvider({
      provider: "none",
      model: "",
      baseUrl: "",
      apiKey: "",
      temperature: 0.7,
      maxTokens: 2048,
      timeoutMs: 120_000,
    });
  });

  it("does not fail or add prompt context when no provider and no evidence are available", async () => {
    initLlmProvider({
      provider: "none",
      model: "",
      baseUrl: "",
      apiKey: "",
      temperature: 0.7,
      maxTokens: 2048,
      timeoutMs: 120_000,
    });

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
