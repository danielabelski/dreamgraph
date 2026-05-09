/**
 * M6 closure — archetypes provider seam (§4.8).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  _resetPluginManagerForTest,
  bootstrapPlugins,
  unloadPluginById,
} from "../../src/plugins/manager.js";
import {
  _resetClosureStoresForTest,
  listArchetypeProviders,
} from "../../src/plugins/closure-stores.js";
import { graphEventBus, type GraphEvent } from "../../src/graph/events.js";
import * as lifecycle from "../../src/instance/lifecycle.js";
import { InstanceScope } from "../../src/instance/scope.js";
import { setDataDirOverride } from "../../src/utils/paths.js";

const FAKE_UUID = "11111111-2222-3333-4444-bbbbbbbbbbbb";
let masterDir: string;
let scope: InstanceScope;
let dataDir: string;

async function makeMaster(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "dg-plugin-arch-"));
  await mkdir(join(dir, FAKE_UUID, "plugins"), { recursive: true });
  await mkdir(join(dir, FAKE_UUID, "data"), { recursive: true });
  await writeFile(
    join(dir, FAKE_UUID, "instance.json"),
    JSON.stringify({ uuid: FAKE_UUID, name: "test", plugins: [] }, null, 2),
  );
  return dir;
}

async function writePlugin(
  pluginId: string,
  manifestExtras: Record<string, unknown>,
  script: string,
): Promise<void> {
  const pluginDir = join(masterDir, FAKE_UUID, "plugins", pluginId);
  await mkdir(pluginDir, { recursive: true });
  await writeFile(
    join(pluginDir, "plugin.json"),
    JSON.stringify(
      {
        id: pluginId,
        version: "0.1.0",
        displayName: pluginId,
        engine: { dreamgraph: ">=9.0.0" },
        main: "./index.js",
        intent: "archetype seam test",
        ...manifestExtras,
      },
      null,
      2,
    ),
  );
  await writeFile(
    join(pluginDir, "index.js"),
    `export default function activate(ctx) { ${script} return {}; }\n`,
  );
  await writeFile(
    join(masterDir, FAKE_UUID, "instance.json"),
    JSON.stringify(
      {
        uuid: FAKE_UUID,
        name: "test",
        plugins: [{ path: "./plugins/" + pluginId, trusted: true }],
      },
      null,
      2,
    ),
  );
  process.env.DG_ALLOW_INPROCESS_PLUGINS = "true";
}

function collect(): { events: GraphEvent[]; off: () => void } {
  const events: GraphEvent[] = [];
  const off = graphEventBus.subscribe((e) => {
    if (typeof e.kind === "string" && e.kind.startsWith("plugin.")) events.push(e);
  });
  return { events, off };
}
async function flush(): Promise<void> {
  await new Promise((r) => setTimeout(r, 50));
}

beforeEach(async () => {
  _resetPluginManagerForTest();
  _resetClosureStoresForTest();
  masterDir = await makeMaster();
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

describe("plugin archetype provider seam (M6 closure)", () => {
  it("registers an inline provider when capability + effect declared", async () => {
    await writePlugin(
      "examples.arch-ok",
      {
        capabilities: ["archetypes:provide"],
        expectedEffects: ["provide_archetypes"],
        archetypeProviders: [{ id: "starter-pack" }],
      },
      `ctx.archetypes.registerProvider({
        id: "starter-pack",
        name: "Starter Pack",
        inline: { source: "examples", version: "1", archetypes: [
          { id: "the-tinkerer", name: "The Tinkerer", summary: "fiddles" },
        ]},
      });`,
    );
    vi.spyOn(lifecycle, "getActiveScope").mockReturnValue(scope);
    const { events, off } = collect();
    try {
      await bootstrapPlugins();
      await flush();
      const providers = listArchetypeProviders();
      expect(providers.length).toBe(1);
      expect(providers[0].provider_id).toBe("examples.arch-ok:starter-pack");
      const accepted = events.find(
        (e) =>
          e.kind === "plugin.output.accepted" &&
          (e.payload as { seam?: string })?.seam === "archetype",
      );
      expect(accepted).toBeDefined();
    } finally {
      off();
    }
  });

  it("rejects when archetypes:provide capability is missing", async () => {
    await writePlugin(
      "examples.arch-no-cap",
      {
        capabilities: ["events:read"],
        expectedEffects: ["provide_archetypes"],
      },
      `try { ctx.archetypes.registerProvider({ id: "x", name: "X", inline: { source: "s", version: "1", archetypes: [] } }); } catch (_) {}`,
    );
    vi.spyOn(lifecycle, "getActiveScope").mockReturnValue(scope);
    const { events, off } = collect();
    try {
      await bootstrapPlugins();
      await flush();
      expect(listArchetypeProviders().length).toBe(0);
      const rej = events.find(
        (e) =>
          e.kind === "plugin.output.rejected" &&
          (e.payload as { reason?: string })?.reason === "archetype_capability_missing",
      );
      expect(rej).toBeDefined();
    } finally {
      off();
    }
  });

  it("rejects providers with no url, inline, or fetch", async () => {
    await writePlugin(
      "examples.arch-empty",
      {
        capabilities: ["archetypes:provide"],
        expectedEffects: ["provide_archetypes"],
        archetypeProviders: [{ id: "empty" }],
      },
      `try { ctx.archetypes.registerProvider({ id: "empty", name: "Empty" }); } catch (_) {}`,
    );
    vi.spyOn(lifecycle, "getActiveScope").mockReturnValue(scope);
    const { events, off } = collect();
    try {
      await bootstrapPlugins();
      await flush();
      expect(listArchetypeProviders().length).toBe(0);
      const rej = events.find(
        (e) =>
          e.kind === "plugin.output.rejected" &&
          (e.payload as { reason?: string })?.reason === "archetype_schema_invalid",
      );
      expect(rej).toBeDefined();
    } finally {
      off();
    }
  });

  it("unloadPluginById prunes plugin-owned providers", async () => {
    await writePlugin(
      "examples.arch-prune",
      {
        capabilities: ["archetypes:provide"],
        expectedEffects: ["provide_archetypes"],
        archetypeProviders: [{ id: "prune-target" }],
      },
      `ctx.archetypes.registerProvider({ id: "prune-target", name: "P", inline: { source: "s", version: "1", archetypes: [] } });`,
    );
    vi.spyOn(lifecycle, "getActiveScope").mockReturnValue(scope);
    await bootstrapPlugins();
    await flush();
    expect(listArchetypeProviders().length).toBe(1);
    await unloadPluginById("examples.arch-prune", "disable");
    expect(listArchetypeProviders().length).toBe(0);
  });
});
