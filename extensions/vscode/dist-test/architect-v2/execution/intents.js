"use strict";
// architect-v2/execution/intents.ts
// Slice 4 — Intent identifiers grouped by tier family.
//
// STRICT ISOLATION (ADR-140): no import from v1.
//
// Intent strings are the canonical capability identifiers. Slice 3
// `ActionCandidate.requiresCapabilities` references these; the
// `CapabilityInventory.has(intent)` answer is "is there any available tool in
// any tier that covers this intent?".
//
// The list is intentionally finite. Adding a new intent requires updating
// NATIVE_TOOL_CATALOG so the inventory can answer it (per ADR-155).
Object.defineProperty(exports, "__esModule", { value: true });
exports.INTENT_GROUPS = void 0;
/**
 * Full set of recognized intents. `INTENT_GROUPS[tier]` exposes the intents
 * that the corresponding tier is expected to cover.
 */
exports.INTENT_GROUPS = Object.freeze({
    1: Object.freeze([
        "graph.read",
        "graph.rag",
        "graph.shortest_path",
        "entity.read",
        "api.query",
        "markdown.read",
        "markdown.list_chapters",
        "dir.list",
        "file.read",
        "source.search",
        "git.read.log",
        "git.read.blame",
        "dream.read",
        "runtime.read",
        "web.fetch",
        "narrative.read",
        "adr.read",
        "discipline.read",
        "data_model.search",
        "db_schema.query",
        "ui.query",
        "self.metrics",
        "schedule.read",
        "webhook.read",
        "remediation.read",
    ]),
    2: Object.freeze([
        "file.create",
        "file.edit",
        "file.patch",
        "file.append",
        "file.delete",
        "file.rename",
        "markdown.patch_chapter",
        "markdown.edit_section",
        "entity.edit",
        "api.modify",
        "graph.wire",
        "graph.scan",
        "graph.scan_database",
        "graph.init",
        "seed.enrich",
        "ui.register",
        "dreams.normalize",
        "dreams.import",
        "dreams.export",
    ]),
    3: Object.freeze([
        "verify.discipline",
        "verify.invariant",
        "runtime.metrics",
        "cognitive.status",
        "cognitive.solidify",
        "cognitive.resolve_tension",
        "cognitive.event",
        "cognitive.preamble",
        "metacognition.analyze",
        "dream.cycle",
        "dream.nightmare",
        "dream.lucid.start",
        "dream.lucid.act",
        "dream.lucid.wake",
        "adr.record",
        "adr.deprecate",
        "schedule.manage",
        "schedule.run_now",
        "webhook.manage",
        "webhook.replay",
        "webhook.test",
        "plugin.manage",
        "discipline.session",
        "living_docs.export",
        "ui_migration.plan",
        "visual_flow.generate",
    ]),
    4: Object.freeze([
        "editor.diagnostics",
        "editor.symbol",
        "editor.openFile",
        "editor.command",
        "lm.tool",
    ]),
    5: Object.freeze(["shell.run", "clipboard.read", "clipboard.write"]),
});
//# sourceMappingURL=intents.js.map