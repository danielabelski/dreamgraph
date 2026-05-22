"use strict";
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Codex CLI adapter - pure prompt serializer (Slice 4).
//
// Codex `exec` is single-shot: the provider port flattens the
// architect-core conversation into one prompt string and sends it on
// stdin using the positional `-` argument. The prompt carries the same
// graph-authority rules as the Copilot CLI adapter, but keeps Codex-
// specific wording local to this adapter.
Object.defineProperty(exports, "__esModule", { value: true });
exports.CURRENT_TURN_CLOSE_MARKER = exports.CURRENT_TURN_OPEN_MARKER = void 0;
exports.serializeConversationForCodexCli = serializeConversationForCodexCli;
const ROLE_HEADERS = {
    system: "[system]",
    user: "[user]",
    assistant: "[assistant]",
};
exports.CURRENT_TURN_OPEN_MARKER = "===== CURRENT TURN — RESPOND ONLY TO THIS MESSAGE =====";
exports.CURRENT_TURN_CLOSE_MARKER = "===== END CURRENT TURN =====";
function renderContentBlock(block) {
    if (block.type === "text")
        return block.text;
    const label = block.fileName ? `${block.fileName} (${block.mimeType})` : block.mimeType;
    return `[image attachment elided - Codex CLI exec stdin prompt does not support image input: ${label}]`;
}
function renderMessageContent(content) {
    if (typeof content === "string")
        return content;
    return content.map(renderContentBlock).join("\n");
}
function renderToolsManifest(manifest) {
    const lines = [];
    const hasDreamgraphRunCommand = manifest.tools.includes("run_command");
    lines.push("### REQUIRED FIRST STEP - DreamGraph MCP context economy");
    lines.push("");
    lines.push(`This conversation runs inside the DreamGraph VS Code extension. A project-aware MCP server "${manifest.server}" is connected and exposes graph-first context (cognitive knowledge graph, ADRs, workflows, data model, UI registry, source code, API surface).`);
    lines.push("");
    lines.push(`MCP server availability note: the ${manifest.server} MCP server exposes TOOLS only - it intentionally publishes NO MCP "resources" or "resource templates". Codex builtin probes such as list_mcp_resources / list_mcp_resource_templates will therefore return EMPTY arrays for this server; that is expected and is NOT evidence that the server is missing. Do not gate any answer on those probes. Verify availability by calling a listed ${manifest.server} tool directly (e.g. cognitive_status or query_resource("system://overview")). The full tool catalogue is listed below.`);
    lines.push("");
    lines.push(`Available ${manifest.server} tools (call by the SHORT name; the MCP layer routes server prefix automatically):`);
    for (const tool of manifest.tools) {
        lines.push(`  - ${tool}`);
    }
    lines.push("");
    lines.push("Exposed command execution routes:");
    if (hasDreamgraphRunCommand) {
        lines.push(`  - ${manifest.server}:run_command - DreamGraph-mediated shell execution through MCP (available; workspace-constrained, timeout-bounded, output-limited, and audited). Call with { command, cwd?, timeoutMs? }. This is the ONLY supported shell execution route for this run.`);
    }
    else {
        lines.push(`  - ${manifest.server}:run_command - unavailable: ${manifest.commandExecutionDisabledReason ?? "not present in the effective DreamGraph tool catalogue for this run"}.`);
    }
    lines.push(`HARD DENIAL - the following tool names DO NOT EXIST in this Codex run and WILL FAIL if called: cli:shell, cli:write, cli:powershell, cli:bash, cli:cmd, cli:pwsh, cli:zsh, cli:sh, cli:exec, cli:run, cli:edit, cli:read. Codex CLI provider-inline shell/write/edit/read routes are denied by adapter policy; repository grounding, mutation, and verification must go through ${manifest.server}. ${hasDreamgraphRunCommand ? `Use ${manifest.server}:run_command({ command, cwd?, timeoutMs? }) for build/test/lint verification instead.` : "Command execution is disabled for this run; do not attempt it."}`);
    if (hasDreamgraphRunCommand) {
        lines.push(`If a task requires build, test, lint, or other shell execution, use ${manifest.server}:run_command. Do not claim command execution is unavailable while this route is listed as available.`);
    }
    else {
        lines.push("Command execution is disabled by policy for this run; state that explicitly instead of claiming the tools do not exist.");
    }
    lines.push("");
    lines.push(`MANDATORY POLICY - before answering ANY question about this repository, its architecture, its tools, its data model, its workflows, its ADRs, its UI registry, its dreams/insights, OR before reading any project file with a native tool (view/read/glob/rg), you MUST first ground yourself by calling at least ONE relevant ${manifest.server} tool. Suggested grounding calls:`);
    lines.push(`  - Project overview / capabilities -> query_resource("system://overview") or query_resource("system://capabilities")`);
    lines.push(`  - Architecture decisions             -> query_resource("dream://adrs")`);
    lines.push(`  - Workflows                          -> query_resource("system://workflows")`);
    lines.push(`  - Data model                         -> query_resource("system://data-model") or search_data_model(query)`);
    lines.push(`  - Semantic code/graph search         -> graph_rag_retrieve(query)`);
    lines.push(`  - Source inspection                  -> read_source_code(repo, filePath, entity?/range?)`);
    lines.push(`  - Directory layout                   -> list_directory(repo, dirPath?)`);
    lines.push(`  - File/entity mutations              -> prefer ${manifest.server}:edit_entity, ${manifest.server}:patch_file, ${manifest.server}:create_file, ${manifest.server}:edit_file, or markdown/ADR/project-state mutation tools`);
    lines.push(`  - ADRs / graph / project state       -> prefer ${manifest.server} mutation tools such as record_architecture_decision, enrich_seed_data, register_ui_element, and related listed tools before local fallbacks`);
    lines.push(`  - Verification / build / tests       -> ${hasDreamgraphRunCommand ? `${manifest.server}:run_command({ command, cwd?, timeoutMs? }) - there is no other shell route for this run` : "command execution is disabled for this run"}`);
    lines.push("");
    lines.push(`Codex CLI adapter authority override: if earlier generic Architect instructions mention local support tools such as write_file, modify_entity, read_local_file, run_command, powershell, bash, or shell, treat them as unavailable or last-resort fallbacks for this Codex CLI run. Listed ${manifest.server} MCP tools take precedence because they are graph-aware, provenance/audit-preserving, and multi-repository aware.`);
    lines.push("");
    lines.push(`Mutation routing policy: when modifying files, repositories, entities, ADRs, graph knowledge, or project state, prefer the listed ${manifest.server} MCP mutation tools first: source mutations through ${manifest.server}:edit_entity, ${manifest.server}:patch_file, ${manifest.server}:create_file, ${manifest.server}:edit_file, ${manifest.server}:rename_file, or ${manifest.server}:delete_file; knowledge mutations through ${manifest.server}:enrich_seed_data, ${manifest.server}:register_ui_element, ${manifest.server}:modify_api_surface, ${manifest.server}:record_architecture_decision, and related graph tools. Native Codex CLI write/edit/read/shell routes are denied by adapter policy. Skipping the grounding call or bypassing an available DreamGraph mutation/verification tool is a protocol violation.`);
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
    return [...systems, ...rest.slice(rest.length - keepLast)];
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
        return [{ role: "system", content: addendum }, ...conversation];
    }
    const out = conversation.slice();
    const existing = out[lastSystemIdx];
    out[lastSystemIdx] = {
        role: "system",
        content: `${renderMessageContent(existing.content)}\n\n${addendum}`,
    };
    return out;
}
function serializeConversationForCodexCli(conversation, options = {}) {
    if (conversation.length === 0) {
        throw new Error("serializeConversationForCodexCli: conversation must contain at least one message");
    }
    const headers = options.roleHeaders ?? ROLE_HEADERS;
    let working = conversation;
    if (options.cliToolsManifest)
        working = applyToolsManifest(working, options.cliToolsManifest);
    if (options.historyKeepLast !== undefined)
        working = applyHistoryCap(working, options.historyKeepLast);
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