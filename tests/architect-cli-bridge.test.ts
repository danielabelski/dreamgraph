import { describe, expect, it } from "vitest";

import { createArchitectCliContinuationManifestSection, serializeCliPrompt } from "../src/architect/cli-bridge.js";

describe("Architect CLI bridge continuation manifest", () => {
  it("serializes governed MCP tool requirements for continuation passes", () => {
    const section = createArchitectCliContinuationManifestSection({
      required_tools: ["read_source_code", "patch_file"],
      preferred_tools: ["run_command", "register_ui_element"],
      unavailable_required_tools: ["record_architecture_decision"],
    });

    expect(section).toContain("Continuation tool manifest for this bounded pass:");
    expect(section).toContain("required_tools: read_source_code, patch_file");
    expect(section).toContain("preferred_tools: run_command, register_ui_element");
    expect(section).toContain("unavailable_required_tools: record_architecture_decision");
    expect(section).toContain("governed dreamgraph MCP tools");
    expect(section).toContain("instead of using a provider-native substitute");
  });

  it("keeps non-continuation prompts explicit", () => {
    expect(createArchitectCliContinuationManifestSection(null)).toBe("Continuation tool manifest: none for this pass.");
  });

  it("does not duplicate the user request in the CLI bridge prompt", () => {
    const request = "Investigate token economy without loading all dreams.";
    const prompt = serializeCliPrompt([
      { role: "system", content: "System context" },
      { role: "user", content: request },
    ], request, "codex-cli", null);

    expect(prompt).toContain("## CURRENT USER REQUEST\n\n" + request);
    expect(prompt).not.toContain("## USER\n" + request);
    expect(prompt.match(/Investigate token economy without loading all dreams\./g)).toHaveLength(1);
  });
});
