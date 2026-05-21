"use strict";
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Copilot CLI adapter — pure prompt serializer (Slice 4).
//
// The Copilot CLI surface is single-shot: every run takes one
// `--prompt <string>` argument and produces one transcript. There is
// no native concept of multi-turn messages, system prompts, or
// tool-result interleaving on the wire. The architect-core seam,
// however, hands us a `PromptParts` envelope with a system prompt and
// a list of `ArchitectMessage`s.
//
// `serializeConversationForCopilotCli` flattens that envelope into
// a single string the CLI model can read. The flattening is:
//
//   [system]
//   <system text>
//
//   [user]
//   <user text>
//
//   [assistant]
//   <assistant text>
//
//   …
//
//   [user]
//   <final user turn>
//
// Image content blocks are not transmissible through `--prompt` and
// are replaced by a SYSTEM-card-style placeholder so the model knows
// an image was elided. This matches the multi-modal output
// normalization rule (provider-agnostic): any provider that cannot
// ingest images receives the same surface notice instead of a
// silently-dropped attachment.
//
// Pure: no I/O, no time, no randomness. Safe to call in tests.
Object.defineProperty(exports, "__esModule", { value: true });
exports.CURRENT_TURN_CLOSE_MARKER = exports.CURRENT_TURN_OPEN_MARKER = void 0;
exports.serializeConversationForCopilotCli = serializeConversationForCopilotCli;
const ROLE_HEADERS = {
    system: "[system]",
    user: "[user]",
    assistant: "[assistant]",
};
function renderContentBlock(block) {
    if (block.type === "text") {
        return block.text;
    }
    // Image / binary block. The CLI cannot ingest it; emit a
    // surface-uniform placeholder.
    const label = block.fileName ? `${block.fileName} (${block.mimeType})` : block.mimeType;
    return `[image attachment elided — Copilot CLI surface does not support image input: ${label}]`;
}
function renderMessageContent(content) {
    if (typeof content === "string")
        return content;
    return content.map(renderContentBlock).join("\n");
}
/**
 * Stable markers wrapping the final user turn. Single-shot CLI runs
 * read the FULL conversation; without unambiguous delimiters the
 * model can latch onto an earlier `[user]` block in the history
 * (manifests as the assistant answering the previous turn's prompt
 * for the new turn). The closing marker mirrors the opener so the
 * region is parseable in audit dumps.
 */
exports.CURRENT_TURN_OPEN_MARKER = "===== CURRENT TURN — RESPOND ONLY TO THIS MESSAGE =====";
exports.CURRENT_TURN_CLOSE_MARKER = "===== END CURRENT TURN =====";
function renderToolsManifest(manifest) {
    const lines = [];
    const nativeCommandTools = manifest.nativeCommandTools ?? [];
    const hasDreamgraphRunCommand = manifest.tools.includes("run_command");
    const commandExecutionAvailable = nativeCommandTools.length > 0 || hasDreamgraphRunCommand;
    lines.push(`### REQUIRED FIRST STEP — DreamGraph MCP context economy`);
    lines.push("");
    lines.push(`This conversation runs inside the DreamGraph VS Code extension. A project-aware MCP server "${manifest.server}" is connected and exposes graph-first context (cognitive knowledge graph, ADRs, workflows, data model, UI registry, source code, API surface).`);
    lines.push("");
    lines.push(`Available ${manifest.server} tools (call by the SHORT name; the MCP layer routes server prefix automatically):`);
    for (const tool of manifest.tools) {
        lines.push(`  - ${tool}`);
    }
    lines.push("");
    lines.push("Exposed command execution routes:");
    if (hasDreamgraphRunCommand) {
        lines.push(`  - ${manifest.server}:run_command — DreamGraph-mediated shell execution through MCP (available; workspace-constrained, timeout-bounded, output-limited, and audited). Call with { command, cwd?, timeoutMs? }. This is the ONLY supported shell execution route for this run.`);
    }
    else {
        lines.push(`  - ${manifest.server}:run_command — unavailable: ${manifest.commandExecutionDisabledReason ?? "not present in the effective DreamGraph tool catalogue for this run"}.`);
    }
    for (const tool of nativeCommandTools) {
        lines.push(`  - cli:${tool} — Copilot-native command tool (available; subject to CLI permission policy).`);
    }
    lines.push(`HARD DENIAL — the following tool names DO NOT EXIST in this run and WILL FAIL if called: cli:shell, cli:write, cli:powershell, cli:bash, cli:cmd, cli:pwsh, cli:zsh, cli:sh, cli:exec, cli:run, cli:edit, cli:read. Copilot CLI's only native shell tools are 'shell' and 'write', both denied by adapter policy. There is no inline 'powershell' / 'bash' / 'cmd' tool — those are training-memory hallucinations from older Copilot CLI builds. Every call to one of those names wastes a tool slot and pollutes the verdict. ${hasDreamgraphRunCommand ? `Use ${manifest.server}:run_command({ command, cwd?, timeoutMs? }) instead.` : "Command execution is disabled for this run; do not attempt it."}`);
    if (commandExecutionAvailable) {
        lines.push(`If a task requires build, test, lint, or other shell execution, use ${hasDreamgraphRunCommand ? `${manifest.server}:run_command` : "an available command route above"}. Do not claim command execution is unavailable while a route is listed as available.`);
    }
    else {
        lines.push(`Command execution is disabled by policy for this run; state that explicitly instead of claiming the tools do not exist.`);
    }
    lines.push("");
    lines.push(`MANDATORY POLICY — before answering ANY question about this repository, its architecture, its tools, its data model, its workflows, its ADRs, its UI registry, its dreams/insights, OR before reading any project file with a native tool (view/read/glob/rg), you MUST first ground yourself by calling at least ONE relevant ${manifest.server} tool. Suggested grounding calls:`);
    lines.push(`  • Project overview / capabilities → query_resource("system://overview") or query_resource("system://capabilities")`);
    lines.push(`  • Architecture decisions             → query_resource("dream://adrs")`);
    lines.push(`  • Workflows                          → query_resource("system://workflows")`);
    lines.push(`  • Data model                         → query_resource("system://data-model") or search_data_model(query)`);
    lines.push(`  • Semantic code/graph search         → graph_rag_retrieve(query)`);
    lines.push(`  • Source inspection                  → read_source_code(repo, filePath, entity?/range?)`);
    lines.push(`  • Directory layout                   → list_directory(repo, dirPath?)`);
    lines.push(`  • File/entity mutations              → prefer ${manifest.server}:edit_entity, ${manifest.server}:patch_file, ${manifest.server}:create_file, ${manifest.server}:edit_file, or markdown/ADR/project-state mutation tools`);
    lines.push(`  • ADRs / graph / project state       → prefer ${manifest.server} mutation tools such as record_architecture_decision, enrich_seed_data, register_ui_element, and related listed tools before local fallbacks`);
    lines.push(`  • Verification / build / tests       → ${hasDreamgraphRunCommand ? `${manifest.server}:run_command({ command, cwd?, timeoutMs? }) — there is no other shell route for this run` : "command execution is disabled for this run"}`);
    lines.push("");
    lines.push(`Copilot CLI adapter authority override: if earlier generic Architect instructions mention local support tools such as write_file, modify_entity, read_local_file, or run_command, treat them as unavailable or last-resort fallbacks for this Copilot CLI run. Listed ${manifest.server} MCP tools take precedence because they are graph-aware, provenance/audit-preserving, and multi-repository aware.`);
    lines.push("");
    lines.push(`Mutation routing policy: when modifying files, repositories, entities, ADRs, graph knowledge, or project state, prefer the listed ${manifest.server} MCP mutation tools first: source mutations through ${manifest.server}:edit_entity, ${manifest.server}:patch_file, ${manifest.server}:create_file, ${manifest.server}:edit_file, ${manifest.server}:rename_file, or ${manifest.server}:delete_file; knowledge mutations through ${manifest.server}:enrich_seed_data, ${manifest.server}:register_ui_element, ${manifest.server}:modify_api_surface, ${manifest.server}:record_architecture_decision, and related graph tools. Native CLI mutation tools (cli:write, cli:edit) are denied by adapter policy. Skipping the grounding call or bypassing an available DreamGraph mutation/verification tool is a protocol violation.`);
    lines.push("");
    lines.push(`ADR-aware task policy: for every repository task, consider applicable accepted ADRs; before proposing or applying code, architecture, workflow, data-model, UI, command-execution, or tool-policy changes, query accepted ADRs with ${manifest.server}:query_resource("dream://adrs") or ${manifest.server}:query_architecture_decisions and include an ADR Review in the response. If the change establishes or revises a durable architectural rule, record it with ${manifest.server}:record_architecture_decision in the same task.`);
    lines.push("");
    lines.push(`Graph sync policy: after any source or project-state mutation, assess whether the knowledge graph must change. If behavior, public API, workflow steps, data model, UI registry, capability definitions, or architectural rules changed, update the graph in the same task with the appropriate ${manifest.server} mutation tool before reporting completion.`);
    return lines.join("\n");
}
function applyHistoryCap(conversation, keepLast) {
    if (!Number.isFinite(keepLast) || keepLast <= 0)
        return conversation;
    const systems = [];
    const rest = [];
    for (const m of conversation) {
        if (m.role === "system")
            systems.push(m);
        else
            rest.push(m);
    }
    if (rest.length <= keepLast)
        return conversation;
    const trimmed = rest.slice(rest.length - keepLast);
    return [...systems, ...trimmed];
}
function applyToolsManifest(conversation, manifest) {
    if (manifest.tools.length === 0)
        return conversation;
    const addendum = renderToolsManifest(manifest);
    let lastSystemIdx = -1;
    for (let i = 0; i < conversation.length; i++) {
        if (conversation[i].role === "system")
            lastSystemIdx = i;
    }
    if (lastSystemIdx === -1) {
        const synthetic = {
            role: "system",
            content: addendum,
        };
        return [synthetic, ...conversation];
    }
    const out = conversation.slice();
    const existing = out[lastSystemIdx];
    const existingText = renderMessageContent(existing.content);
    out[lastSystemIdx] = {
        role: "system",
        content: `${existingText}\n\n${addendum}`,
    };
    return out;
}
/**
 * Flatten an architect-core conversation into a single prompt string
 * suitable for passing to `runCopilotCli({ prompt })`.
 *
 * Throws when the conversation is empty (the caller must always
 * include at least the user turn the architect-core driver composed).
 */
function serializeConversationForCopilotCli(conversation, options = {}) {
    if (conversation.length === 0) {
        throw new Error("serializeConversationForCopilotCli: conversation must contain at least one message");
    }
    const headers = options.roleHeaders ?? ROLE_HEADERS;
    let working = conversation;
    if (options.cliToolsManifest) {
        working = applyToolsManifest(working, options.cliToolsManifest);
    }
    if (options.historyKeepLast !== undefined) {
        working = applyHistoryCap(working, options.historyKeepLast);
    }
    let lastUserIdx = -1;
    if (options.markCurrentTurn) {
        for (let i = 0; i < working.length; i++) {
            if (working[i].role === "user")
                lastUserIdx = i;
        }
    }
    const parts = [];
    for (let i = 0; i < working.length; i++) {
        const msg = working[i];
        const header = headers[msg.role];
        const body = renderMessageContent(msg.content);
        if (i === lastUserIdx) {
            parts.push(`${header}\n${exports.CURRENT_TURN_OPEN_MARKER}\n${body}\n${exports.CURRENT_TURN_CLOSE_MARKER}`);
        }
        else {
            parts.push(`${header}\n${body}`);
        }
    }
    return parts.join("\n\n");
}
//# sourceMappingURL=prompt-serializer.js.map