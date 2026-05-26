/**
 * M6 — UI typed builder seam.
 *
 * Verifies:
 *   1. A trusted in-process plugin with capability `ui:register` and effect
 *      `mutate_ui_registry` can register a semantic UI element via
 *      `ctx.ui.register()`. The element lands in `ui_registry.json` with the
 *      `plugin:<plugin-id>` provenance tag and a `plugin.output.accepted`
 *      telemetry event is emitted.
 *   2. A plugin missing the `ui:register` capability is denied with
 *      `ui_capability_missing` and no element is written.
 *   3. An element id without the `<plugin-id>.` prefix is denied with
 *      `ui_id_unprefixed` and no element is written.
 *   4. `unloadPluginById` prunes every plugin-tagged element from
 *      `ui_registry.json`.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  bootstrapPlugins,
  unloadPluginById,
  _resetPluginManagerForTest,
} from "../../src/plugins/manager.js";
import { graphEventBus, type GraphEvent } from "../../src/graph/events.js";
import * as lifecycle from "../../src/instance/lifecycle.js";
import { InstanceScope } from "../../src/instance/scope.js";
import { setDataDirOverride } from "../../src/utils/paths.js";

const FAKE_UUID = "11111111-2222-3333-4444-555555555555";

let masterDir: string;
let scope: InstanceScope;
let dataDir: string;
const previousOverride = { dir: null as string | null };

async function makeMaster(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "dg-plugin-ui-"));
  await mkdir(join(dir, FAKE_UUID, "plugins"), { recursive: true });
  await mkdir(join(dir, FAKE_UUID, "data"), { recursive: true });
  await writeFile(
    join(dir, FAKE_UUID, "instance.json"),
    JSON.stringify({ uuid: FAKE_UUID, name: "test", plugins: [] }, null, 2),
  );
  return dir;
}

async function readRegistryElements(): Promise<Array<Record<string, unknown>>> {
  const path = join(dataDir, "ui_registry.json");
  if (!existsSync(path)) return [];
  const raw = await readFile(path, "utf-8");
  const parsed = JSON.parse(raw);
  return Array.isArray(parsed.elements) ? parsed.elements : [];
}

async function writeUiPlugin(
  pluginId: string,
  manifestExtras: Record<string, unknown>,
  registerScript: string,
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
        intent: "M6 UI seam test",
        ...manifestExtras,
      },
      null,
      2,
    ),
  );
  await writeFile(
    join(pluginDir, "index.js"),
    `export default function activate(ctx) {
  ${registerScript}
  return {};
}
`,
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

function collectPluginEvents(): {
  events: GraphEvent[];
  unsubscribe: () => void;
} {
  const events: GraphEvent[] = [];
  const unsubscribe = graphEventBus.subscribe((evt) => {
    if (typeof evt.kind === "string" && evt.kind.startsWith("plugin.")) {
      events.push(evt);
    }
  });
  return { events, unsubscribe };
}

beforeEach(async () => {
  _resetPluginManagerForTest();
  masterDir = await makeMaster();
  scope = new InstanceScope(FAKE_UUID, masterDir);
  dataDir = join(masterDir, FAKE_UUID, "data");
  setDataDirOverride(dataDir);
});

afterEach(async () => {
  vi.restoreAllMocks();
  _resetPluginManagerForTest();
  delete process.env.DG_ALLOW_INPROCESS_PLUGINS;
  setDataDirOverride(previousOverride.dir as unknown as string);
  await rm(masterDir, { recursive: true, force: true });
});

// We need to wait for the fire-and-forget registry write to settle.
async function flushRegistryWrite(expectedCount?: number): Promise<void> {
  const deadline = Date.now() + 1_000;
  do {
    if (expectedCount === undefined || (await readRegistryElements()).length === expectedCount) {
      return;
    }
    await new Promise((r) => setTimeout(r, 25));
  } while (Date.now() < deadline);
}

describe("plugin UI seam (M6)", () => {
  it("registers a UI element and tags it with plugin provenance", async () => {
    await writeUiPlugin(
      "examples.ui-ok",
      {
        expectedEffects: ["mutate_ui_registry"],
        capabilities: ["ui:register"],
        ui: [{ id: "examples.ui-ok.greeting" }],
      },
      `ctx.ui.register({
        id: "examples.ui-ok.greeting",
        name: "Greeting",
        purpose: "Display a friendly greeting",
        category: "data_display",
        inputs: [{ name: "who", type: "string", description: "subject", required: true }],
        outputs: [],
        interactions: [],
      });`,
    );
    vi.spyOn(lifecycle, "getActiveScope").mockReturnValue(scope);
    const { events, unsubscribe } = collectPluginEvents();
    try {
      await bootstrapPlugins();
      await flushRegistryWrite(1);

      const elements = await readRegistryElements();
      expect(elements.length).toBe(1);
      expect(elements[0].id).toBe("examples.ui-ok.greeting");
      expect((elements[0].tags as string[]) ?? []).toContain("plugin:examples.ui-ok");

      const accepted = events.find(
        (e) =>
          e.kind === "plugin.output.accepted" &&
          (e.payload as { seam?: string; target?: string })?.seam === "ui",
      );
      expect(accepted).toBeDefined();
      expect((accepted!.payload as { target?: string }).target).toBe(
        "examples.ui-ok.greeting",
      );
    } finally {
      unsubscribe();
    }
  });

  it("rejects ui.register when capability ui:register is missing", async () => {
    await writeUiPlugin(
      "examples.ui-no-cap",
      {
        expectedEffects: ["mutate_ui_registry"],
        capabilities: ["events:read"],
      },
      `try { ctx.ui.register({
        id: "examples.ui-no-cap.x",
        name: "X", purpose: "p", category: "data_display",
        inputs: [], outputs: [], interactions: [],
      }); } catch (_) {}`,
    );
    vi.spyOn(lifecycle, "getActiveScope").mockReturnValue(scope);
    const { events, unsubscribe } = collectPluginEvents();
    try {
      await bootstrapPlugins();
      await flushRegistryWrite(0);
      const elements = await readRegistryElements();
      expect(elements.length).toBe(0);
      const rejected = events.find(
        (e) =>
          e.kind === "plugin.output.rejected" &&
          (e.payload as { reason?: string })?.reason === "ui_capability_missing",
      );
      expect(rejected).toBeDefined();
    } finally {
      unsubscribe();
    }
  });

  it("rejects ui.register when element id is not prefixed with plugin id", async () => {
    await writeUiPlugin(
      "examples.ui-bad-id",
      {
        expectedEffects: ["mutate_ui_registry"],
        capabilities: ["ui:register"],
      },
      `try { ctx.ui.register({
        id: "wrong.prefix.x",
        name: "X", purpose: "p", category: "data_display",
        inputs: [], outputs: [], interactions: [],
      }); } catch (_) {}`,
    );
    vi.spyOn(lifecycle, "getActiveScope").mockReturnValue(scope);
    const { events, unsubscribe } = collectPluginEvents();
    try {
      await bootstrapPlugins();
      await flushRegistryWrite(0);
      const elements = await readRegistryElements();
      expect(elements.length).toBe(0);
      const rejected = events.find(
        (e) =>
          e.kind === "plugin.output.rejected" &&
          (e.payload as { reason?: string })?.reason === "ui_id_unprefixed",
      );
      expect(rejected).toBeDefined();
    } finally {
      unsubscribe();
    }
  });

  it("unloadPluginById prunes plugin-tagged UI elements", async () => {
    await writeUiPlugin(
      "examples.ui-prune",
      {
        expectedEffects: ["mutate_ui_registry"],
        capabilities: ["ui:register"],
      },
      `ctx.ui.register({
        id: "examples.ui-prune.alpha",
        name: "Alpha", purpose: "a", category: "data_display",
        inputs: [], outputs: [], interactions: [],
      });
      ctx.ui.register({
        id: "examples.ui-prune.beta",
        name: "Beta", purpose: "b", category: "data_display",
        inputs: [], outputs: [], interactions: [],
      });`,
    );
    vi.spyOn(lifecycle, "getActiveScope").mockReturnValue(scope);
    await bootstrapPlugins();
    await flushRegistryWrite(2);
    expect((await readRegistryElements()).length).toBe(2);

    await unloadPluginById("examples.ui-prune", "disable");
    expect((await readRegistryElements()).length).toBe(0);
  });
});
