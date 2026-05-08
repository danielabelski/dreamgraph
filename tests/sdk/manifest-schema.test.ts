import { describe, expect, it } from "vitest";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { PluginManifestSchema } from "../../packages/sdk/src/manifest.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const fixturesDir = join(__dirname, "manifest-fixtures");

async function readFixture(name: string): Promise<unknown> {
  return JSON.parse(await readFile(join(fixturesDir, name), "utf8"));
}

describe("SDK plugin manifest schema", () => {
  it("accepts the minimal valid fixture", async () => {
    const result = PluginManifestSchema.safeParse(await readFixture("valid-minimal.json"));

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.id).toBe("example.plugin");
      expect(result.data.capabilities).toEqual(["tools:register"]);
      expect(result.data.tools).toEqual([{ name: "example.plugin.echo" }]);
      expect(result.data.resources).toEqual([{ uriNamespace: "plugin://example.plugin/" }]);
    }
  });

  it.each([
    ["missing id", "invalid-missing-id.json"],
    ["invalid capability", "invalid-bad-capability.json"],
    ["unprefixed tool name", "invalid-tool-name-unprefixed.json"],
    ["resource URI outside plugin namespace", "invalid-resource-uri-out-of-namespace.json"],
  ])("rejects %s", async (_label, fixtureName) => {
    const result = PluginManifestSchema.safeParse(await readFixture(fixtureName));

    expect(result.success).toBe(false);
  });
});
