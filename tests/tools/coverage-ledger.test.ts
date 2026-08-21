import { describe, expect, it } from "vitest";
import { COVERAGE_LEDGER_SCHEMA, coverageFileKey, coverageRevision, summarizeCoverage, validateCoverageLedger, type ScanCoverageLedger } from "../../src/tools/coverage-ledger.js";

function fixture(): ScanCoverageLedger {
  const files = {
    [coverageFileKey("repo", "src/a.ts", "features")]: {
      repo: "repo", path: "src/a.ts", target: "features", extractor: "typescript", outcome: "parsed" as const, emitted_entity_ids: ["a"],
    },
    [coverageFileKey("repo", "dist/a.js", "features")]: {
      repo: "repo", path: "dist/a.js", target: "features", extractor: null, outcome: "generated" as const, reason: "generated_artifact", emitted_entity_ids: [],
    },
  };
  const nodes = {
    a: { id: "a", target: "features", supports: [{ repo: "repo", path: "src/a.ts" }], eligible: true, semantic_state: "pending" as const },
    manual: { id: "manual", target: "features", supports: [], eligible: false, semantic_state: "not_eligible" as const, reason: "manual_governed_knowledge" },
  };
  const base = { schema: COVERAGE_LEDGER_SCHEMA, files, nodes };
  return { ...base, revision: coverageRevision(base) };
}

describe("truthful scan coverage ledger", () => {
  it("classifies every file and node while excluding ineligible nodes from enrichment debt", () => {
    const ledger = fixture();
    expect(validateCoverageLedger(ledger)).toEqual([]);
    expect(summarizeCoverage(ledger)).toMatchObject({ files_terminal: 2, nodes_classified: 2, eligible: 1, pending: 1, enriched: 0 });
  });

  it("is deterministic and rejects silent omissions or unstable missing reasons", () => {
    const ledger = fixture();
    expect(coverageRevision({ schema: ledger.schema, files: ledger.files, nodes: ledger.nodes })).toBe(ledger.revision);
    ledger.files[coverageFileKey("repo", "src/a.ts", "features")].emitted_entity_ids.push("missing");
    ledger.nodes.manual.reason = undefined;
    expect(validateCoverageLedger(ledger)).toEqual(expect.arrayContaining([
      expect.stringContaining("unclassified node missing"),
      expect.stringContaining("manual requires a reason"),
    ]));
  });
});
