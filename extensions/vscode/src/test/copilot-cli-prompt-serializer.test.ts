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

test("serializeConversationForCopilotCli: tools manifest advertises mutation and verification routing", () => {
  const conv: ArchitectMessage[] = [
    { role: "system", content: "rules" },
    { role: "user", content: "fix it" },
  ];
  const out = serializeConversationForCopilotCli(conv, {
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

  assert.match(out, /Available dreamgraph tools/);
  assert.match(out, /  - edit_entity/);
  assert.match(out, /  - run_command/);
  assert.doesNotMatch(out, /cli:powershell .*available/);
  assert.match(out, /dreamgraph:run_command .*available.*ONLY supported shell execution route/);
  assert.match(out, /HARD DENIAL .* DO NOT EXIST in this run .* cli:powershell, cli:bash, cli:cmd/);
  assert.match(out, /Do not claim command execution is unavailable/);
  assert.match(out, /File\/entity mutations\s+→ prefer dreamgraph:edit_entity/);
  assert.match(out, /ADRs \/ graph \/ project state\s+→ prefer dreamgraph mutation tools/);
  assert.match(out, /Verification \/ build \/ tests\s+→ dreamgraph:run_command/);
  assert.match(out, /Copilot CLI adapter authority override/);
  assert.match(out, /local support tools such as write_file, modify_entity, read_local_file, or run_command/);
  assert.match(out, /Native CLI mutation tools \(cli:write, cli:edit\) are denied by adapter policy/);
  assert.match(out, /source mutations through dreamgraph:edit_entity, dreamgraph:patch_file, dreamgraph:create_file/);
  assert.match(out, /knowledge mutations through dreamgraph:enrich_seed_data, dreamgraph:register_ui_element, dreamgraph:modify_api_surface, dreamgraph:record_architecture_decision/);
  assert.match(out, /ADR-aware task policy: for every repository task/);
  assert.match(out, /record it with dreamgraph:record_architecture_decision in the same task/);
  assert.match(out, /Graph sync policy: after any source or project-state mutation/);
  assert.match(out, /bypassing an available DreamGraph mutation\/verification tool is a protocol violation/);
});

test("serializeConversationForCopilotCli: command policy names disabled routes explicitly", () => {
  const conv: ArchitectMessage[] = [
    { role: "system", content: "rules" },
    { role: "user", content: "fix it" },
  ];
  const out = serializeConversationForCopilotCli(conv, {
    cliToolsManifest: {
      server: "dreamgraph",
      tools: ["query_resource"],
      nativeCommandTools: [],
      commandExecutionDisabledReason: "command execution disabled by policy",
    },
  });

  assert.doesNotMatch(out, /cli:powershell .*available/);
  assert.match(out, /dreamgraph:run_command .*unavailable: command execution disabled by policy/);
  assert.match(out, /Command execution is disabled by policy for this run/);
});
