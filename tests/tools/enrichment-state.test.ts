import { describe, expect, it } from "vitest";
import { classifyEnrichmentFailure, createEnrichmentRun, recordEnrichmentOutcome, resumableNodeIds } from "../../src/tools/enrichment-state.js";

describe("resumable enrichment state", () => {
  it("resumes pending/retryable nodes without reprocessing success", () => {
    let state = createEnrichmentRun("scan-1", "provider-1", ["b", "a"]);
    state = recordEnrichmentOutcome(state, "a", { state: "enriched" });
    state = recordEnrichmentOutcome(state, "b", { state: "failed_retryable", reason: "transient_timeout" });
    expect(resumableNodeIds(state)).toEqual(["b"]);
    expect(recordEnrichmentOutcome(state, "a", { state: "failed_terminal", reason: "validation_failure" })).toBe(state);
  });

  it.each([
    [new Error("request timed out"), "failed_retryable", "transient_timeout"],
    [new Error("provider unavailable"), "failed_retryable", "provider_unavailable"],
    [new Error("context token limit exceeded"), "failed_terminal", "context_overflow"],
    [new Error("schema validation"), "failed_terminal", "validation_failure"],
  ])("classifies %s", (failure, state, reason) => {
    expect(classifyEnrichmentFailure(failure)).toEqual({ state, reason });
  });
});
