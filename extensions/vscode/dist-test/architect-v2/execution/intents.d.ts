export type T1Intent = "graph.read" | "graph.rag" | "graph.shortest_path" | "entity.read" | "api.query" | "markdown.read" | "markdown.list_chapters" | "dir.list" | "file.read" | "source.search" | "git.read.log" | "git.read.blame" | "dream.read" | "runtime.read" | "web.fetch" | "narrative.read" | "adr.read" | "discipline.read" | "data_model.search" | "db_schema.query" | "ui.query" | "self.metrics" | "schedule.read" | "webhook.read" | "remediation.read";
export type T2Intent = "file.create" | "file.edit" | "file.patch" | "file.append" | "file.delete" | "file.rename" | "markdown.patch_chapter" | "markdown.edit_section" | "entity.edit" | "api.modify" | "graph.wire" | "graph.scan" | "graph.scan_database" | "graph.init" | "seed.enrich" | "ui.register" | "dreams.normalize" | "dreams.import" | "dreams.export";
export type T3Intent = "verify.discipline" | "verify.invariant" | "runtime.metrics" | "cognitive.status" | "cognitive.solidify" | "cognitive.resolve_tension" | "cognitive.event" | "cognitive.preamble" | "metacognition.analyze" | "dream.cycle" | "dream.nightmare" | "dream.lucid.start" | "dream.lucid.act" | "dream.lucid.wake" | "adr.record" | "adr.deprecate" | "schedule.manage" | "schedule.run_now" | "webhook.manage" | "webhook.replay" | "webhook.test" | "plugin.manage" | "discipline.session" | "living_docs.export" | "ui_migration.plan" | "visual_flow.generate";
export type T4Intent = "editor.diagnostics" | "editor.symbol" | "editor.openFile" | "editor.command" | "lm.tool";
export type T5Intent = "shell.run" | "clipboard.read" | "clipboard.write";
export type Intent = T1Intent | T2Intent | T3Intent | T4Intent | T5Intent;
/**
 * Full set of recognized intents. `INTENT_GROUPS[tier]` exposes the intents
 * that the corresponding tier is expected to cover.
 */
export declare const INTENT_GROUPS: Readonly<{
    1: readonly T1Intent[];
    2: readonly T2Intent[];
    3: readonly T3Intent[];
    4: readonly T4Intent[];
    5: readonly T5Intent[];
}>;
//# sourceMappingURL=intents.d.ts.map