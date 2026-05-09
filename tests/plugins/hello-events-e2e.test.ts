/**
 * End-to-end smoke test for examples/hello-events (M6 closure).
 *
 * Copies the real example into a temp instance, bootstraps the host with
 * in-process plugins enabled, and asserts that every seam the manifest
 * declares produced its corresponding contribution + acceptance event.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  _resetPluginManagerForTest,
  bootstrapPlugins,
  getContributedArchetypeProviderIds,
  getContributedMarkdownFenceLanguages,
  getContributedPolicyIds,
  getContributedResources,
  getContributedTools,
  getContributedUiElementIds,
  isPluginActivated,
  unloadPluginById,
} from "../../src/plugins/manager.js";
import { _resetClosureStoresForTest } from "../../src/plugins/closure-stores.js";
import { graphEventBus, type GraphEvent } from "../../src/graph/events.js";
import * as lifecycle from "../../src/instance/lifecycle.js";
import { InstanceScope } from "../../src/instance/scope.js";
import { setDataDirOverride } from "../../src/utils/paths.js";

const FAKE_UUID = "11111111-2222-3333-4444-eeeeeeeeeeee";
const PLUGIN_ID = "examples.hello-events";
const SOURCE_DIR = resolve(__dirname, "..", "..", "examples", "hello-events");

let masterDir: string;
let scope: InstanceScope;
let dataDir: string;

beforeEach(async () => {
  _resetPluginManagerForTest();
  _resetClosureStoresForTest();
  masterDir = await mkdtemp(join(tmpdir(), "dg-hello-events-"));
  await mkdir(join(masterDir, FAKE_UUID, "plugins"), { recursive: true });
  await mkdir(join(masterDir, FAKE_UUID, "data"), { recursive: true });
  // Drop the live example into the instance.
  await cp(SOURCE_DIR, join(masterDir, FAKE_UUID, "plugins", PLUGIN_ID), {
    recursive: true,
  });
  await writeFile(
    join(masterDir, FAKE_UUID, "instance.json"),
    JSON.stringify(
      {
        uuid: FAKE_UUID,
        name: "test",
        plugins: [{ path: "./plugins/" + PLUGIN_ID, trusted: true }],
      },
      null,
      2,
    ),
  );
  process.env.DG_ALLOW_INPROCESS_PLUGINS = "true";
  scope = new InstanceScope(FAKE_UUID, masterDir);
  dataDir = join(masterDir, FAKE_UUID, "data");
  setDataDirOverride(dataDir);
});

afterEach(async () => {
  vi.restoreAllMocks();
  _resetPluginManagerForTest();
  _resetClosureStoresForTest();
  delete process.env.DG_ALLOW_INPROCESS_PLUGINS;
  setDataDirOverride(null as unknown as string);
  await rm(masterDir, { recursive: true, force: true });
});

async function flush(): Promise<void> {
  await new Promise((r) => setTimeout(r, 80));
}

describe("examples/hello-events full-seam smoke", () => {
  it("activates and exercises every seam declared in plugin.json", async () => {
    vi.spyOn(lifecycle, "getActiveScope").mockReturnValue(scope);
    const accepted: GraphEvent[] = [];
    const rejected: GraphEvent[] = [];
    const off = graphEventBus.subscribe((e) => {
      if (e.kind === "plugin.output.accepted") accepted.push(e);
      else if (e.kind === "plugin.output.rejected") rejected.push(e);
    });
    try {
      await bootstrapPlugins();
      await flush();

      // No contribution should have been rejected.
      expect(rejected.map((e) => (e.payload as { reason?: string }).reason)).toEqual([]);

      // Plugin is activated.
      expect(isPluginActivated(PLUGIN_ID)).toBe(true);

      // Tool contribution.
      const tools = getContributedTools().filter((t) => t.pluginId === PLUGIN_ID);
      expect(tools.map((t) => t.definition.name)).toEqual([
        "examples.hello-events.greet",
      ]);

      // Resource contribution.
      const resources = getContributedResources().filter(
        (r) => r.pluginId === PLUGIN_ID,
      );
      expect(resources.map((r) => r.definition.uriNamespace)).toEqual([
        "plugin://examples.hello-events/manifest",
      ]);

      // UI element written + tagged.
      expect(getContributedUiElementIds(PLUGIN_ID)).toEqual([
        "examples.hello-events.greeting",
      ]);
      const uiPath = join(dataDir, "ui_registry.json");
      expect(existsSync(uiPath)).toBe(true);
      const uiFile = JSON.parse(await readFile(uiPath, "utf-8"));
      const elt = uiFile.elements.find(
        (x: { id: string }) => x.id === "examples.hello-events.greeting",
      );
      expect(elt).toBeDefined();
      expect(elt.tags).toContain(`plugin:${PLUGIN_ID}`);

      // Policy proposal journaled.
      expect(getContributedPolicyIds(PLUGIN_ID)).toEqual([
        `${PLUGIN_ID}:declare-effects`,
      ]);
      const polFile = JSON.parse(
        await readFile(join(dataDir, "plugin_policy_proposals.json"), "utf-8"),
      );
      expect(polFile.proposals[0].source).toBe(`plugin:${PLUGIN_ID}`);

      // Archetype provider in-memory.
      expect(getContributedArchetypeProviderIds(PLUGIN_ID)).toEqual([
        `${PLUGIN_ID}:starter-pack`,
      ]);

      // Markdown fence in-memory.
      expect(getContributedMarkdownFenceLanguages(PLUGIN_ID)).toEqual(["dg-hello"]);

      // Each seam emitted at least one accepted telemetry event.
      const seams = new Set(
        accepted.map((e) => (e.payload as { seam?: string }).seam),
      );
      for (const expected of [
        "tool",
        "resource",
        "ui",
        "policy",
        "archetype",
        "markdown_fence",
      ]) {
        expect(seams.has(expected), `missing accept for seam '${expected}'`).toBe(
          true,
        );
      }
    } finally {
      off();
    }
  });

  it("unload prunes UI, policies, archetypes, and markdown fences", async () => {
    vi.spyOn(lifecycle, "getActiveScope").mockReturnValue(scope);
    await bootstrapPlugins();
    await flush();

    expect(getContributedUiElementIds(PLUGIN_ID).length).toBe(1);
    expect(getContributedPolicyIds(PLUGIN_ID).length).toBe(1);
    expect(getContributedArchetypeProviderIds(PLUGIN_ID).length).toBe(1);
    expect(getContributedMarkdownFenceLanguages(PLUGIN_ID).length).toBe(1);

    await unloadPluginById(PLUGIN_ID, "disable");

    expect(getContributedUiElementIds(PLUGIN_ID).length).toBe(0);
    expect(getContributedPolicyIds(PLUGIN_ID).length).toBe(0);
    expect(getContributedArchetypeProviderIds(PLUGIN_ID).length).toBe(0);
    expect(getContributedMarkdownFenceLanguages(PLUGIN_ID).length).toBe(0);

    // ui_registry.json no longer contains the plugin's element.
    const uiFile = JSON.parse(
      await readFile(join(dataDir, "ui_registry.json"), "utf-8"),
    );
    expect(
      uiFile.elements.find(
        (x: { id: string }) => x.id === "examples.hello-events.greeting",
      ),
    ).toBeUndefined();
    // plugin_policy_proposals.json no longer contains plugin proposals.
    const polFile = JSON.parse(
      await readFile(join(dataDir, "plugin_policy_proposals.json"), "utf-8"),
    );
    expect(polFile.proposals.length).toBe(0);
  });
});
