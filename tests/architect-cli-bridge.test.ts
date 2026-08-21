import { describe, expect, it } from "vitest";

import { createArchitectCliToolRequirementsSection, serializeCliPrompt } from "../src/architect/cli-bridge.js";

describe("Architect CLI bridge execution requirements", () => {
  it("serializes concrete governed MCP tool requirements without continuation semantics", () => {
    const section = createArchitectCliToolRequirementsSection({
      required_tools: ["read_source_code", "patch_file"],
      preferred_tools: ["run_command", "register_ui_element"],
    });

    expect(section).toContain("Concrete tool requirements for this execution:");
    expect(section).toContain("required_tools: read_source_code, patch_file");
    expect(section).toContain("preferred_tools: run_command, register_ui_element");
    expect(section).toContain("controller-derived execution requirements");
    expect(section).not.toContain("Continuation tool manifest");
    expect(section).toContain("instead of using a provider-native substitute");
  });

  it("keeps ordinary CLI prompts free of continuation-envelope expectations", () => {
    expect(createArchitectCliToolRequirementsSection(null)).toBe("Execution tool requirements: none beyond the adapter baseline.");
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
