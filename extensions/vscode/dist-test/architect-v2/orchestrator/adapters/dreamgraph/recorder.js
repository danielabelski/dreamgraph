"use strict";
// SCOPED EXCEPTION (ADR-171): this directory is the only location in
// architect-v2 where DreamGraph MCP tool names may appear in code.
//
// Slice 8A.4 — DreamGraph adapter for ProjectGraphRecorder + ContextDiscoveryRecorder.
//
// The recorder writes deliberate cognition produced by the orchestrator
// (cards, decisions, outcomes, continuations) and incidental cognition
// surfaced by the assembler (file URIs touched, graph nodes referenced).
// Both responsibilities are bundled here because they share the same
// transport (the McpClient seam from reader.ts) and the same backend.
//
// All methods are best-effort: transport failures are swallowed so the
// orchestrator pass always completes. Errors are surfaced via console
// for debug; durable audit lives in the DreamGraph server itself.
Object.defineProperty(exports, "__esModule", { value: true });
exports.DreamGraphRecorderAdapter = void 0;
class DreamGraphRecorderAdapter {
    client;
    logErrors;
    constructor(options) {
        this.client = options.client;
        this.logErrors = options.logErrors ?? false;
    }
    // -------------------------------------------------------------------------
    // ProjectGraphRecorder
    // -------------------------------------------------------------------------
    async recordCards(cards) {
        for (const c of cards) {
            await this.safeCall("mcp_dreamgraph_solidify_cognitive_insight", {
                kind: "architect_card",
                title: c.kind,
                body: JSON.stringify(c),
                source_id: c.id,
                confidence: 0.9,
            });
        }
    }
    async recordDecision(decision) {
        await this.safeCall("mcp_dreamgraph_record_architecture_decision", {
            title: `Architect decision ${decision.id}`,
            problem: `Architect pass for task ${decision.taskId} required a next-step decision.`,
            chosen: decision.chosen,
            alternatives: decision.alternatives.map((a) => ({
                option: a,
                rejected_because: "Lower-ranked candidate.",
            })),
            decided_by: "collaborative",
            constraints: [],
            expected_consequences: [],
            guard_rails: [],
            risks: [decision.rationale],
            tags: ["architect-v2", "auto-recorded"],
            affected_entities: [],
        });
    }
    async recordOutcome(outcome) {
        await this.safeCall("mcp_dreamgraph_solidify_cognitive_insight", {
            kind: "architect_outcome",
            title: `${outcome.tool} ${outcome.succeeded ? "succeeded" : "failed"}`,
            body: outcome.summary,
            source_id: outcome.id,
            confidence: outcome.succeeded ? 0.95 : 0.6,
            affected_entities: [...outcome.touchedNodeIds],
        });
    }
    async recordContinuation(continuation) {
        await this.safeCall("mcp_dreamgraph_solidify_cognitive_insight", {
            kind: "architect_continuation",
            title: continuation.selectedAction.label,
            body: continuation.reasoningTrace,
            source_id: `continuation:${continuation.selectedAction.id}`,
            confidence: 0.7,
        });
    }
    // -------------------------------------------------------------------------
    // ContextDiscoveryRecorder
    // -------------------------------------------------------------------------
    async recordDiscoveries(discoveries) {
        if (discoveries.length === 0)
            return;
        // Aggregate into one wire-link batch per task to minimize chatter.
        const links = [];
        for (const d of discoveries) {
            for (const ref of d.artifactRefs) {
                links.push({
                    from: `architect_task:${d.taskId}`,
                    to: ref,
                    relation: d.via === "fallback"
                        ? "context_touched_via_fallback"
                        : "context_referenced",
                    properties: { requirement_kind: d.sourceRequirementKind },
                });
            }
        }
        if (links.length === 0)
            return;
        await this.safeCall("mcp_dreamgraph_wire_links", { links });
    }
    // -------------------------------------------------------------------------
    // Internal
    // -------------------------------------------------------------------------
    async safeCall(name, args) {
        try {
            await this.client.callTool(name, args);
        }
        catch (err) {
            if (this.logErrors) {
                // eslint-disable-next-line no-console
                console.warn(`[DreamGraphRecorderAdapter] ${name} failed:`, err);
            }
        }
    }
}
exports.DreamGraphRecorderAdapter = DreamGraphRecorderAdapter;
//# sourceMappingURL=recorder.js.map