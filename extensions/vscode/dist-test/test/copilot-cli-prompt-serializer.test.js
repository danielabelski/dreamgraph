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
//# sourceMappingURL=copilot-cli-prompt-serializer.test.js.map