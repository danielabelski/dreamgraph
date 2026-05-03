/**
 * Phase 4 #8 — Tension resolution lifecycle tests.
 *
 * Covers:
 *   1. proposeTensionResolution stamps a candidate (idempotent overwrite).
 *   2. runTensionResolverCycle picks top-N urgency, falls back to heuristic
 *      when no proposer is supplied.
 *   3. validateResolutionCandidates confirms when bridging edge exists,
 *      accepts wont_fix, escalates otherwise (urgency bump + attempted=true).
 *   4. getResolutionPipelineStats reflects pending + by_strategy counts.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setDataDirOverride } from "../src/utils/paths.js";
import { engine } from "../src/cognitive/engine.js";
import type { ValidatedEdgesFile } from "../src/cognitive/types.js";

let tempDir: string;

async function seedValidatedEdges(file: ValidatedEdgesFile): Promise<void> {
  await mkdir(tempDir, { recursive: true });
  await writeFile(join(tempDir, "validated_edges.json"), JSON.stringify(file, null, 2), "utf-8");
}

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "dg-resolver-"));
  setDataDirOverride(tempDir);
});

afterEach(async () => {
  await rm(tempDir, { recursive: true, force: true });
});

describe("Phase 4 #8 — tension resolution lifecycle", () => {
  it("proposeTensionResolution stamps a candidate and is overwritable", async () => {
    const sig = await engine.recordTension({
      type: "missing_link",
      entities: ["a", "b"],
      description: "needs a bridge",
      urgency: 0.6,
    });

    const stamped = await engine.proposeTensionResolution(sig.id, {
      strategy: "merge",
      rationale: "first try",
      validation_window: 2,
      source: "heuristic",
    });
    expect(stamped?.resolution_candidate?.strategy).toBe("merge");
    expect(stamped?.resolution_candidate?.validation_window).toBe(2);

    // Overwrite with a different strategy/source.
    const stamped2 = await engine.proposeTensionResolution(sig.id, {
      strategy: "split",
      rationale: "second try",
      validation_window: 1,
      source: "llm",
    });
    expect(stamped2?.resolution_candidate?.strategy).toBe("split");
    expect(stamped2?.resolution_candidate?.source).toBe("llm");
  });

  it("proposeTensionResolution returns null for unknown tension id", async () => {
    const result = await engine.proposeTensionResolution("does_not_exist", {
      strategy: "merge",
      rationale: "noop",
      validation_window: 1,
      source: "heuristic",
    });
    expect(result).toBeNull();
  });

  it("runTensionResolverCycle uses heuristic fallback when no proposer is supplied", async () => {
    const high = await engine.recordTension({
      type: "missing_link",
      entities: ["x", "y"],
      description: "high urgency",
      urgency: 0.9,
    });
    await engine.recordTension({
      type: "ungrounded_dream",
      entities: ["z"],
      description: "low urgency",
      urgency: 0.1,
    });

    const { proposed } = await engine.runTensionResolverCycle({ maxSamples: 1 });
    expect(proposed).toBe(1);

    const stats = await engine.getResolutionPipelineStats();
    expect(stats.pending_candidates).toBe(1);
    // missing_link → merge per heuristic.
    expect(stats.by_strategy.merge).toBe(1);

    // The high-urgency one should have been picked.
    const tensions = await engine.loadTensions();
    const stamped = tensions.signals.find((s) => s.id === high.id);
    expect(stamped?.resolution_candidate?.strategy).toBe("merge");
  });

  it("runTensionResolverCycle honours an injected proposer and skips already-stamped tensions", async () => {
    const sig = await engine.recordTension({
      type: "weak_connection",
      entities: ["m", "n"],
      description: "weak bridge",
      urgency: 0.7,
    });

    const first = await engine.runTensionResolverCycle({
      maxSamples: 5,
      proposer: () => ({
        strategy: "mediator",
        rationale: "from llm",
        validation_window: 2,
        source: "llm",
      }),
    });
    expect(first.proposed).toBe(1);

    // Second pass: tension already has a candidate → skipped.
    const second = await engine.runTensionResolverCycle({ maxSamples: 5 });
    expect(second.proposed).toBe(0);

    const tensions = await engine.loadTensions();
    const stamped = tensions.signals.find((s) => s.id === sig.id);
    expect(stamped?.resolution_candidate?.source).toBe("llm");
  });

  it("validateResolutionCandidates confirms when a bridging edge exists in validated_edges", async () => {
    const sig = await engine.recordTension({
      type: "missing_link",
      entities: ["alpha", "beta"],
      description: "should be bridged",
      urgency: 0.5,
    });

    await engine.proposeTensionResolution(sig.id, {
      strategy: "merge",
      rationale: "bridge expected",
      validation_window: 1,
      source: "heuristic",
    });

    await seedValidatedEdges({
      metadata: {
        description: "test",
        schema_version: "1.0.0",
        last_validation: null,
        total_validated: 1,
        created_at: new Date().toISOString(),
      },
      edges: [
        {
          id: "e1",
          from: "alpha",
          to: "beta",
          type: "feature",
          relation: "bridges",
          description: "test bridge",
          confidence: 0.9,
          plausibility: 0.9,
          evidence_score: 0.9,
          origin: "rem",
          status: "validated",
          evidence_summary: "seeded by test",
          evidence_count: 2,
          reinforcement_count: 1,
          dream_cycle: 1,
          normalization_cycle: 1,
          validated_at: new Date().toISOString(),
        } as ValidatedEdgesFile["edges"][number],
      ],
    });

    const result = await engine.validateResolutionCandidates();
    expect(result.confirmed).toBe(1);
    expect(result.escalated).toBe(0);

    const resolvedList = await engine.getResolvedTensions();
    expect(resolvedList.find((r) => r.tension_id === sig.id)?.resolution_type).toBe("confirmed_fixed");
  });

  it("validateResolutionCandidates accepts wont_fix candidates without bridging evidence", async () => {
    const sig = await engine.recordTension({
      type: "ungrounded_dream",
      entities: ["g"],
      description: "speculative only",
      urgency: 0.2,
    });

    await engine.proposeTensionResolution(sig.id, {
      strategy: "wont_fix",
      rationale: "accept as speculative",
      validation_window: 1,
      source: "heuristic",
    });

    const result = await engine.validateResolutionCandidates();
    expect(result.accepted_wont_fix).toBe(1);
    expect(result.confirmed).toBe(0);
    expect(result.escalated).toBe(0);

    const resolvedList = await engine.getResolvedTensions();
    expect(resolvedList.find((r) => r.tension_id === sig.id)?.resolution_type).toBe("wont_fix");
  });

  it("validateResolutionCandidates escalates when window expires without bridging evidence", async () => {
    const sig = await engine.recordTension({
      type: "missing_link",
      entities: ["p", "q"],
      description: "no bridge yet",
      urgency: 0.5,
    });

    await engine.proposeTensionResolution(sig.id, {
      strategy: "merge",
      rationale: "guess",
      validation_window: 1,
      source: "heuristic",
    });

    const result = await engine.validateResolutionCandidates();
    expect(result.escalated).toBe(1);

    const tensions = await engine.loadTensions();
    const escalated = tensions.signals.find((s) => s.id === sig.id);
    expect(escalated?.resolved).toBe(false);
    expect(escalated?.attempted).toBe(true);
    expect(escalated?.resolution_candidate).toBeUndefined();
    // urgency bumped by 0.05 (capped at 1).
    expect(escalated?.urgency).toBeGreaterThan(0.5);
  });

  it("validateResolutionCandidates leaves candidates with non-zero window untouched", async () => {
    const sig = await engine.recordTension({
      type: "missing_link",
      entities: ["s", "t"],
      description: "wait",
      urgency: 0.4,
    });

    await engine.proposeTensionResolution(sig.id, {
      strategy: "merge",
      rationale: "later",
      validation_window: 3,
      source: "heuristic",
    });

    const result = await engine.validateResolutionCandidates();
    expect(result.awaiting).toBe(1);
    expect(result.confirmed + result.accepted_wont_fix + result.escalated).toBe(0);

    const tensions = await engine.loadTensions();
    const stamped = tensions.signals.find((s) => s.id === sig.id);
    // window decremented from 3 → 2.
    expect(stamped?.resolution_candidate?.validation_window).toBe(2);
  });
});
