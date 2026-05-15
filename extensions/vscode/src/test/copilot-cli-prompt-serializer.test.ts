// SPDX-License-Identifier: AGPL-3.0-or-later

import test from "node:test";
import assert from "node:assert/strict";

import { serializeConversationForCopilotCli } from "../architect-core/adapters/copilot-cli/index.js";
import type { ArchitectMessage } from "../architect-llm.js";

test("serializeConversationForCopilotCli: rejects empty conversations", () => {
  assert.throws(() => serializeConversationForCopilotCli([]));
});

test("serializeConversationForCopilotCli: renders [system]/[user]/[assistant] headers in order", () => {
  const conv: ArchitectMessage[] = [
    { role: "system", content: "rules" },
    { role: "user", content: "hello" },
    { role: "assistant", content: "hi back" },
    { role: "user", content: "follow up" },
  ];
  const out = serializeConversationForCopilotCli(conv);
  assert.equal(
    out,
    [
      "[system]\nrules",
      "[user]\nhello",
      "[assistant]\nhi back",
      "[user]\nfollow up",
    ].join("\n\n"),
  );
});

test("serializeConversationForCopilotCli: joins multiple text blocks with newlines", () => {
  const conv: ArchitectMessage[] = [
    {
      role: "user",
      content: [
        { type: "text", text: "part A" },
        { type: "text", text: "part B" },
      ],
    },
  ];
  const out = serializeConversationForCopilotCli(conv);
  assert.equal(out, "[user]\npart A\npart B");
});

test("serializeConversationForCopilotCli: replaces image blocks with placeholder", () => {
  const conv: ArchitectMessage[] = [
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
  const out = serializeConversationForCopilotCli(conv);
  assert.match(out, /see attached/);
  assert.match(out, /image attachment elided/);
  assert.match(out, /diagram\.png/);
  assert.match(out, /image\/png/);
  assert.doesNotMatch(out, /iVBOR/); // base64 bytes never leak through
});

test("serializeConversationForCopilotCli: honors custom role headers", () => {
  const conv: ArchitectMessage[] = [
    { role: "system", content: "S" },
    { role: "user", content: "U" },
  ];
  const out = serializeConversationForCopilotCli(conv, {
    roleHeaders: { system: "## SYS ##", user: "## USR ##", assistant: "## ASS ##" },
  });
  assert.equal(out, "## SYS ##\nS\n\n## USR ##\nU");
});
