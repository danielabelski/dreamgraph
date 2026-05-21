"use strict";
// SPDX-License-Identifier: AGPL-3.0-or-later
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const node_test_1 = __importDefault(require("node:test"));
const strict_1 = __importDefault(require("node:assert/strict"));
const index_js_1 = require("../architect-core/adapters/copilot-cli/index.js");
(0, node_test_1.default)("serializeConversationForCopilotCli: rejects empty conversations", () => {
    strict_1.default.throws(() => (0, index_js_1.serializeConversationForCopilotCli)([]));
});
(0, node_test_1.default)("serializeConversationForCopilotCli: renders [system]/[user]/[assistant] headers in order", () => {
    const conv = [
        { role: "system", content: "rules" },
        { role: "user", content: "hello" },
        { role: "assistant", content: "hi back" },
        { role: "user", content: "follow up" },
    ];
    const out = (0, index_js_1.serializeConversationForCopilotCli)(conv);
    strict_1.default.equal(out, [
        "[system]\nrules",
        "[user]\nhello",
        "[assistant]\nhi back",
        "[user]\nfollow up",
    ].join("\n\n"));
});
(0, node_test_1.default)("serializeConversationForCopilotCli: joins multiple text blocks with newlines", () => {
    const conv = [
        {
            role: "user",
            content: [
                { type: "text", text: "part A" },
                { type: "text", text: "part B" },
            ],
        },
    ];
    const out = (0, index_js_1.serializeConversationForCopilotCli)(conv);
    strict_1.default.equal(out, "[user]\npart A\npart B");
});
(0, node_test_1.default)("serializeConversationForCopilotCli: replaces image blocks with placeholder", () => {
    const conv = [
        {
            role: "user",
            content: [
                { type: "text", text: "see attached" },
                {
                    type: "image",
                    mimeType: "image/png",
                    dataBase64: "iVBOR…",
                    fileName: "diagram.png",
                },
            ],
        },
    ];
    const out = (0, index_js_1.serializeConversationForCopilotCli)(conv);
    strict_1.default.match(out, /see attached/);
    strict_1.default.match(out, /image attachment elided/);
    strict_1.default.match(out, /diagram\.png/);
    strict_1.default.match(out, /image\/png/);
    strict_1.default.doesNotMatch(out, /iVBOR/); // base64 bytes never leak through
});
(0, node_test_1.default)("serializeConversationForCopilotCli: honors custom role headers", () => {
    const conv = [
        { role: "system", content: "S" },
        { role: "user", content: "U" },
    ];
    const out = (0, index_js_1.serializeConversationForCopilotCli)(conv, {
        roleHeaders: { system: "## SYS ##", user: "## USR ##", assistant: "## ASS ##" },
    });
    strict_1.default.equal(out, "## SYS ##\nS\n\n## USR ##\nU");
});
(0, node_test_1.default)("serializeConversationForCopilotCli: tools manifest advertises mutation and verification routing", () => {
    const conv = [
        { role: "system", content: "rules" },
        { role: "user", content: "fix it" },
    ];
    const out = (0, index_js_1.serializeConversationForCopilotCli)(conv, {
        cliToolsManifest: {
            server: "dreamgraph",
            tools: [
                "query_resource",
                "read_source_code",
                "edit_entity",
                "patch_file",
                "edit_markdown_section",
                "patch_markdown_chapter",
                "run_command",
            ],
            nativeCommandTools: [],
        },
    });
    strict_1.default.match(out, /Available dreamgraph tools/);
    strict_1.default.match(out, /  - edit_entity/);
    strict_1.default.match(out, /  - run_command/);
    strict_1.default.doesNotMatch(out, /cli:powershell .*available/);
    strict_1.default.match(out, /dreamgraph:run_command .*available.*ONLY supported shell execution route/);
    strict_1.default.match(out, /HARD DENIAL .* DO NOT EXIST in this run .* cli:powershell, cli:bash, cli:cmd/);
    strict_1.default.match(out, /Do not claim command execution is unavailable/);
    strict_1.default.match(out, /File\/entity mutations\s+→ prefer dreamgraph:edit_entity/);
    strict_1.default.match(out, /ADRs \/ graph \/ project state\s+→ prefer dreamgraph mutation tools/);
    strict_1.default.match(out, /Verification \/ build \/ tests\s+→ dreamgraph:run_command/);
    strict_1.default.match(out, /Copilot CLI adapter authority override/);
    strict_1.default.match(out, /local support tools such as write_file, modify_entity, read_local_file, or run_command/);
    strict_1.default.match(out, /Native CLI mutation tools \(cli:write, cli:edit\) are denied by adapter policy/);
    strict_1.default.match(out, /source mutations through dreamgraph:edit_entity, dreamgraph:patch_file, dreamgraph:create_file/);
    strict_1.default.match(out, /knowledge mutations through dreamgraph:enrich_seed_data, dreamgraph:register_ui_element, dreamgraph:modify_api_surface, dreamgraph:record_architecture_decision/);
    strict_1.default.match(out, /ADR-aware task policy: for every repository task/);
    strict_1.default.match(out, /record it with dreamgraph:record_architecture_decision in the same task/);
    strict_1.default.match(out, /Graph sync policy: after any source or project-state mutation/);
    strict_1.default.match(out, /bypassing an available DreamGraph mutation\/verification tool is a protocol violation/);
});
(0, node_test_1.default)("serializeConversationForCopilotCli: command policy names disabled routes explicitly", () => {
    const conv = [
        { role: "system", content: "rules" },
        { role: "user", content: "fix it" },
    ];
    const out = (0, index_js_1.serializeConversationForCopilotCli)(conv, {
        cliToolsManifest: {
            server: "dreamgraph",
            tools: ["query_resource"],
            nativeCommandTools: [],
            commandExecutionDisabledReason: "command execution disabled by policy",
        },
    });
    strict_1.default.doesNotMatch(out, /cli:powershell .*available/);
    strict_1.default.match(out, /dreamgraph:run_command .*unavailable: command execution disabled by policy/);
    strict_1.default.match(out, /Command execution is disabled by policy for this run/);
});
//# sourceMappingURL=copilot-cli-prompt-serializer.test.js.map