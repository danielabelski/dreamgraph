import { describe, expect, it } from "vitest";

import {
  buildAdaptiveFutureAuditTrail,
  inferAdaptiveFutureTaskClass,
} from "../src/cognitive/adaptive-future-scaffold.js";

describe("adaptive future Slice 12 scaffold", () => {
  it("classifies the V11 Phase 4 task classes deterministically", () => {
    expect(inferAdaptiveFutureTaskClass({ file_path: "plans/ADAPTIVE_FUTURE_ENGINE_IMPLEMENTATION_SLICES.md" })).toBe("planning_doc");
    expect(inferAdaptiveFutureTaskClass({ file_path: "extensions/vscode/src/architect-core/adapters/copilot-cli/orchestrator.ts" })).toBe("adapter_change");
    expect(inferAdaptiveFutureTaskClass({ file_path: "src/tools/enrich-parser-nodes.ts", tool_name: "enrich_parser_nodes" })).toBe("graph_tool_change");
    expect(inferAdaptiveFutureTaskClass({ file_path: "src/cognitive/intervention.ts", task_summary: "Update cognitive workflow" })).toBe("cognitive_workflow_change");
  });

  it("keeps selected and rejected candidate audit metadata bounded", () => {
    const audit = buildAdaptiveFutureAuditTrail({
      task_class: "planning_doc",
      selected_candidate_id: "plan:targeted-edit",
      route: "deterministic",
      fallback: "none",
      candidates: [
        {
          id: "plan:targeted-edit",
          task_class: "planning_doc",
          score_factors: {
            adr_alignment: 0.9,
            workflow_fit: 0.8,
            verification_path: 0.7,
            graph_sync_impact: 0.4,
            blast_radius: 0.2,
            evidence_strength: 0.8,
          },
          anchors: [{ kind: "plan", id: "Slice 12" }],
          objections: [],
          selected: true,
        },
        {
          id: "plan:rewrite-whole-file",
          task_class: "planning_doc",
          score_factors: {
            adr_alignment: 0.5,
            workflow_fit: 0.4,
            verification_path: 0.4,
            graph_sync_impact: 0.2,
            blast_radius: 0.9,
            evidence_strength: 0.5,
          },
          anchors: [{ kind: "plan", id: "Slice 12" }],
          objections: ["Unbounded rewrite would exceed the reviewed audit payload shape."],
        },
      ],
    });

    expect(audit.audit_version).toBe("slice12-scaffold-v1");
    expect(audit.task_class).toBe("planning_doc");
    expect(audit.selected_candidate_id).toBe("plan:targeted-edit");
    expect(audit.rejected_candidate_ids).toEqual(["plan:rewrite-whole-file"]);
    expect(audit.candidates).toHaveLength(2);
  });
});
