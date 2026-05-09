/**
 * M6 closure — markdown_fences seam (§4.9, manifest-only stub).
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
  listMarkdownFences,
} from "../../src/plugins/closure-stores.js";
import { graphEventBus, type GraphEvent } from "../../src/graph/events.js";
import * as lifecycle from "../../src/instance/lifecycle.js";
import { InstanceScope } from "../../src/instance/scope.js";
import { setDataDirOverride } from "../../src/utils/paths.js";

const FAKE_UUID = "11111111-2222-3333-4444-cccccccccccc";
let masterDir: string;
let scope: InstanceScope;
let dataDir: string;

async function makeMaster(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "dg-plugin-fence-"));
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
): Promise<{ append: boolean }> {
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
        intent: "fence seam test",
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
  return { append: true };
}

async function setInstancePlugins(ids: string[]): Promise<void> {
  await writeFile(
    join(masterDir, FAKE_UUID, "instance.json"),
    JSON.stringify(
      {
        uuid: FAKE_UUID,
        name: "test",
        plugins: ids.map((id) => ({ path: "./plugins/" + id, trusted: true })),
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

describe("plugin markdown fence seam (M6 closure)", () => {
  it("registers a fence when capability + effect declared", async () => {
    await writePlugin(
      "examples.fence-ok",
      {
        capabilities: ["markdown:register_fence"],
        expectedEffects: ["render_markdown_fence"],
        markdownFences: [{ language: "dg-flow" }],
      },
      `ctx.markdownFences.register({
        language: "dg-flow",
        label: "DG Flow",
        description: "DreamGraph flow diagrams",
      });`,
    );
    await setInstancePlugins(["examples.fence-ok"]);
    vi.spyOn(lifecycle, "getActiveScope").mockReturnValue(scope);
    const { events, off } = collect();
    try {
      await bootstrapPlugins();
      await flush();
      const fences = listMarkdownFences();
      expect(fences.length).toBe(1);
      expect(fences[0].language).toBe("dg-flow");
      const accepted = events.find(
        (e) =>
          e.kind === "plugin.output.accepted" &&
          (e.payload as { seam?: string })?.seam === "markdown_fence",
      );
      expect(accepted).toBeDefined();
    } finally {
      off();
    }
  });

  it("rejects when markdown:register_fence capability is missing", async () => {
    await writePlugin(
      "examples.fence-no-cap",
      {
        capabilities: ["events:read"],
        expectedEffects: ["render_markdown_fence"],
      },
      `try { ctx.markdownFences.register({ language: "dg-x", label: "X", description: "x" }); } catch (_) {}`,
    );
    await setInstancePlugins(["examples.fence-no-cap"]);
    vi.spyOn(lifecycle, "getActiveScope").mockReturnValue(scope);
    const { events, off } = collect();
    try {
      await bootstrapPlugins();
      await flush();
      expect(listMarkdownFences().length).toBe(0);
      const rej = events.find(
        (e) =>
          e.kind === "plugin.output.rejected" &&
          (e.payload as { reason?: string })?.reason === "markdown_fence_capability_missing",
      );
      expect(rej).toBeDefined();
    } finally {
      off();
    }
  });

  it("rejects collisions across plugins on the same language", async () => {
    await writePlugin(
      "examples.fence-a",
      {
        capabilities: ["markdown:register_fence"],
        expectedEffects: ["render_markdown_fence"],
        markdownFences: [{ language: "dg-shared" }],
      },
      `ctx.markdownFences.register({ language: "dg-shared", label: "A", description: "a" });`,
    );
    await writePlugin(
      "examples.fence-b",
      {
        capabilities: ["markdown:register_fence"],
        expectedEffects: ["render_markdown_fence"],
        markdownFences: [{ language: "dg-shared" }],
      },
      `try { ctx.markdownFences.register({ language: "dg-shared", label: "B", description: "b" }); } catch (_) {}`,
    );
    await setInstancePlugins(["examples.fence-a", "examples.fence-b"]);
    vi.spyOn(lifecycle, "getActiveScope").mockReturnValue(scope);
    const { events, off } = collect();
    try {
      await bootstrapPlugins();
      await flush();
      expect(listMarkdownFences().length).toBe(1);
      const rej = events.find(
        (e) =>
          e.kind === "plugin.output.rejected" &&
          (e.payload as { reason?: string })?.reason === "markdown_fence_language_collision",
      );
      expect(rej).toBeDefined();
    } finally {
      off();
    }
  });

  it("unloadPluginById prunes plugin-owned fences", async () => {
    await writePlugin(
      "examples.fence-prune",
      {
        capabilities: ["markdown:register_fence"],
        expectedEffects: ["render_markdown_fence"],
        markdownFences: [{ language: "dg-prune" }],
      },
      `ctx.markdownFences.register({ language: "dg-prune", label: "P", description: "p" });`,
    );
    await setInstancePlugins(["examples.fence-prune"]);
    vi.spyOn(lifecycle, "getActiveScope").mockReturnValue(scope);
    await bootstrapPlugins();
    await flush();
    expect(listMarkdownFences().length).toBe(1);
    await unloadPluginById("examples.fence-prune", "disable");
    expect(listMarkdownFences().length).toBe(0);
  });
});
