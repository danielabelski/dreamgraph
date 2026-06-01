import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { PluginManifestSchema } from "../../packages/sdk/src/manifest.js";

describe("examples/action-checklist", () => {
  it("ships a discoverable valid manifest and uses only the public Architect context surface", async () => {
    const manifest = PluginManifestSchema.parse(JSON.parse(await readFile("examples/action-checklist/plugin.json", "utf8")));
    const source = await readFile("examples/action-checklist/index.js", "utf8");
    expect(manifest.architectTabs).toEqual([{ id: "examples.action-checklist.checklist", renderer: "checklist", planConnectivity: "required" }]);
    expect(source).toContain("ctx.architect.tabs.register");
    expect(source).toContain("ctx.architect.planState.read");
    expect(source).toContain("ctx.architect.planState.write");
    expect(source).not.toContain("@dreamgraph/sdk");
    expect(source).not.toMatch(/localStorage|node:fs|iframe|innerHTML/);
  });
});
