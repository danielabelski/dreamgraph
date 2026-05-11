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

// ---------------------------------------------------------------------------
// Tier 1 — MCP knowledge / read
// ---------------------------------------------------------------------------

export type T1Intent =
  | "graph.read"
  | "graph.rag"
  | "graph.shortest_path"
  | "entity.read"
  | "api.query"
  | "markdown.read"
  | "markdown.list_chapters"
  | "dir.list"
  | "file.read"
  | "source.search"
  | "git.read.log"
  | "git.read.blame"
  | "dream.read"
  | "runtime.read"
  | "web.fetch"
  | "narrative.read"
  | "adr.read"
  | "discipline.read"
  | "data_model.search"
  | "db_schema.query"
  | "ui.query"
  | "self.metrics"
  | "schedule.read"
  | "webhook.read"
  | "remediation.read";

// ---------------------------------------------------------------------------
// Tier 2 — MCP mutation
// ---------------------------------------------------------------------------

export type T2Intent =
  | "file.create"
  | "file.edit"
  | "file.patch"
  | "file.append"
  | "file.delete"
  | "file.rename"
  | "markdown.patch_chapter"
  | "markdown.edit_section"
  | "entity.edit"
  | "api.modify"
  | "graph.wire"
  | "graph.scan"
  | "graph.scan_database"
  | "graph.init"
  | "seed.enrich"
  | "ui.register"
  | "dreams.normalize"
  | "dreams.import"
  | "dreams.export";

// ---------------------------------------------------------------------------
// Tier 3 — MCP verification, runtime senses, cognitive
// ---------------------------------------------------------------------------

export type T3Intent =
  | "verify.discipline"
  | "verify.invariant"
  | "runtime.metrics"
  | "cognitive.status"
  | "cognitive.solidify"
  | "cognitive.resolve_tension"
  | "cognitive.event"
  | "cognitive.preamble"
  | "metacognition.analyze"
  | "dream.cycle"
  | "dream.nightmare"
  | "dream.lucid.start"
  | "dream.lucid.act"
  | "dream.lucid.wake"
  | "adr.record"
  | "adr.deprecate"
  | "schedule.manage"
  | "schedule.run_now"
  | "webhook.manage"
  | "webhook.replay"
  | "webhook.test"
  | "plugin.manage"
  | "discipline.session"
  | "living_docs.export"
  | "ui_migration.plan"
  | "visual_flow.generate";

// ---------------------------------------------------------------------------
// Tier 4 — VS Code editor APIs (fallback only)
// ---------------------------------------------------------------------------

export type T4Intent =
  | "editor.diagnostics"
  | "editor.symbol"
  | "editor.openFile"
  | "editor.command"
  | "lm.tool";

// ---------------------------------------------------------------------------
// Tier 5 — Shell + clipboard (fallback only)
// ---------------------------------------------------------------------------

export type T5Intent = "shell.run" | "clipboard.read" | "clipboard.write";

// ---------------------------------------------------------------------------
// Union
// ---------------------------------------------------------------------------

export type Intent = T1Intent | T2Intent | T3Intent | T4Intent | T5Intent;

/**
 * Full set of recognized intents. `INTENT_GROUPS[tier]` exposes the intents
 * that the corresponding tier is expected to cover.
 */
export const INTENT_GROUPS: Readonly<{
  1: readonly T1Intent[];
  2: readonly T2Intent[];
  3: readonly T3Intent[];
  4: readonly T4Intent[];
  5: readonly T5Intent[];
}> = Object.freeze({
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
  ] as const),
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
  ] as const),
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
  ] as const),
  4: Object.freeze([
    "editor.diagnostics",
    "editor.symbol",
    "editor.openFile",
    "editor.command",
    "lm.tool",
  ] as const),
  5: Object.freeze(["shell.run", "clipboard.read", "clipboard.write"] as const),
});
