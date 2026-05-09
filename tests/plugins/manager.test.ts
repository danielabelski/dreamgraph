/**
 * Plugin manager bootstrap tests.
 *
 * Verifies the daemon-side glue:
 *   1. No active scope → bootstrap is a no-op.
 *   2. Active scope, empty plugins dir → discovery returns 0, no errors.
 *   3. Active scope, valid plugin manifest under <instance>/plugins/<id>/
 *      → discovery surfaces it, telemetry bridge emits plugin.* events on
 *        the graphEventBus, and bootstrap is idempotent.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  bootstrapPlugins,
  getLastDiscoveredPlugins,
  getContributedTools,
  getContributedResources,
  isPluginActivated,
  unloadPluginById,
  reloadPlugin,
  _resetPluginManagerForTest,
} from "../../src/plugins/manager.js";
import { graphEventBus, type GraphEvent } from "../../src/graph/events.js";
import * as lifecycle from "../../src/instance/lifecycle.js";
import { InstanceScope } from "../../src/instance/scope.js";

const FAKE_UUID = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";

let masterDir: string;
let scope: InstanceScope;

async function makeMaster(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "dg-plugin-manager-"));
  await mkdir(join(dir, FAKE_UUID, "plugins"), { recursive: true });
  await writeFile(
    join(dir, FAKE_UUID, "instance.json"),
    JSON.stringify({ uuid: FAKE_UUID, name: "test", plugins: [] }, null, 2),
  );
  return dir;
}

beforeEach(async () => {
  _resetPluginManagerForTest();
  masterDir = await makeMaster();
  scope = new InstanceScope(FAKE_UUID, masterDir);
});

afterEach(async () => {
  vi.restoreAllMocks();
  _resetPluginManagerForTest();
  await rm(masterDir, { recursive: true, force: true });
});

describe("bootstrapPlugins", () => {
  it("no-ops when there is no active scope", async () => {
    vi.spyOn(lifecycle, "getActiveScope").mockReturnValue(null);
    const result = await bootstrapPlugins();
    expect(result.ran).toBe(false);
    expect(result.reason).toBe("no-active-scope");
    expect(result.outcomes).toEqual([]);
    expect(getLastDiscoveredPlugins()).toEqual([]);
  });

  it("succeeds with zero plugins when plugins dir is empty", async () => {
    vi.spyOn(lifecycle, "getActiveScope").mockReturnValue(scope);
    const result = await bootstrapPlugins();
    expect(result.ran).toBe(true);
    expect(result.outcomes).toEqual([]);
    expect(getLastDiscoveredPlugins()).toEqual([]);
  });

  it("is idempotent — second call is a no-op", async () => {
    vi.spyOn(lifecycle, "getActiveScope").mockReturnValue(scope);
    const first = await bootstrapPlugins();
    const second = await bootstrapPlugins();
    expect(first.ran).toBe(true);
    expect(second.ran).toBe(false);
    expect(second.reason).toBe("already-bootstrapped");
  });

  it("discovers a manifest under <instance>/plugins/<id>/ and emits telemetry", async () => {
    // Write a valid plugin manifest.
    const pluginDir = join(masterDir, FAKE_UUID, "plugins", "examples.smoke");
    await mkdir(pluginDir, { recursive: true });
    await writeFile(
      join(pluginDir, "plugin.json"),
      JSON.stringify(
        {
          id: "examples.smoke",
          version: "0.1.0",
          displayName: "Smoke",
          engine: { dreamgraph: ">=9.0.0" },
          main: "./index.js",
          intent: "smoke test",
          expectedEffects: ["emit_event"],
          capabilities: ["events:read"],
        },
        null,
        2,
      ),
    );
    await writeFile(
      join(pluginDir, "index.js"),
      "export default function activate() { return {}; }\n",
    );

    vi.spyOn(lifecycle, "getActiveScope").mockReturnValue(scope);

    // Subscribe to the bus so we can confirm the telemetry bridge fires.
    const events: GraphEvent[] = [];
    const unsubscribe = graphEventBus.subscribe((evt) => {
      if (typeof evt.kind === "string" && evt.kind.startsWith("plugin.")) {
        events.push(evt);
      }
    });

    try {
      const result = await bootstrapPlugins();
      expect(result.ran).toBe(true);
      const discovered = getLastDiscoveredPlugins();
      expect(discovered.length).toBe(1);
      expect(discovered[0].manifest.id).toBe("examples.smoke");
      // At minimum we should see a plugin.loaded or plugin.errored event.
      expect(events.length).toBeGreaterThan(0);
    } finally {
      unsubscribe();
    }
  });

  it("invokes activate() and bridges ctx.events.subscribe to graphEventBus when trusted in-process", async () => {
    const pluginDir = join(masterDir, FAKE_UUID, "plugins", "examples.activate");
    await mkdir(pluginDir, { recursive: true });
    await writeFile(
      join(pluginDir, "plugin.json"),
      JSON.stringify(
        {
          id: "examples.activate",
          version: "0.1.0",
          displayName: "Activate",
          engine: { dreamgraph: ">=9.0.0" },
          main: "./index.js",
          intent: "activate-seam test",
          expectedEffects: ["emit_event"],
          capabilities: ["events:read"],
        },
        null,
        2,
      ),
    );
    // Plugin emits a marker event during activate(), and subscribes to
    // snapshot.changed to verify the bridge wires through to graphEventBus.
    await writeFile(
      join(pluginDir, "index.js"),
      `globalThis.__dgActivateSeam__ = { activated: 0, observed: [] };
export default function activate(ctx) {
  globalThis.__dgActivateSeam__.activated += 1;
  ctx.events.subscribe('snapshot.changed', (evt) => {
    globalThis.__dgActivateSeam__.observed.push(evt.kind);
  });
  ctx.events.emit('cache.invalidated', { from: 'plugin' });
  return {};
}
`,
    );
    // Trust + opt in
    await writeFile(
      join(masterDir, FAKE_UUID, "instance.json"),
      JSON.stringify(
        {
          uuid: FAKE_UUID,
          name: "test",
          plugins: [{ path: "./plugins/examples.activate", trusted: true }],
        },
        null,
        2,
      ),
    );
    process.env.DG_ALLOW_INPROCESS_PLUGINS = "true";
    vi.spyOn(lifecycle, "getActiveScope").mockReturnValue(scope);

    try {
      const result = await bootstrapPlugins();
      expect(result.ran).toBe(true);
      const loaded = result.outcomes.filter((o) => o.status === "loaded");
      expect(loaded.length).toBe(1);
      const seam = (globalThis as unknown as {
        __dgActivateSeam__?: { activated: number; observed: string[] };
      }).__dgActivateSeam__;
      expect(seam).toBeDefined();
      expect(seam!.activated).toBe(1);

      // Now emit snapshot.changed and confirm the plugin's handler observed it.
      graphEventBus.emit("snapshot.changed", { payload: { from: "test" } });
      expect(seam!.observed).toContain("snapshot.changed");
    } finally {
      delete process.env.DG_ALLOW_INPROCESS_PLUGINS;
      delete (globalThis as Record<string, unknown>).__dgActivateSeam__;
    }
  });
});

/* ------------------------------------------------------------------ */
/*  M3.5 + M4 — contribution surfaces, hot reload/unload              */
/* ------------------------------------------------------------------ */

async function writeContribPlugin(
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
        intent: "M4 contribution test",
        ...manifestExtras,
      },
      null,
      2,
    ),
  );
  await writeFile(
    join(pluginDir, "index.js"),
    `globalThis.__dgContribSeam__ = globalThis.__dgContribSeam__ || { toolCalls: 0 };
export default function activate(ctx) {
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
        plugins: [{ path: `./plugins/${pluginId}`, trusted: true }],
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

afterEach(() => {
  delete process.env.DG_ALLOW_INPROCESS_PLUGINS;
  delete (globalThis as Record<string, unknown>).__dgContribSeam__;
});

describe("plugin contributions (M4)", () => {
  it("registers a contributed MCP tool when manifest declares tools:register + emit_tool", async () => {
    await writeContribPlugin(
      "examples.contrib-tool",
      {
        expectedEffects: ["emit_tool"],
        capabilities: ["tools:register"],
        tools: [{ name: "examples.contrib-tool.hello" }],
      },
      `ctx.tools.register({
        name: "examples.contrib-tool.hello",
        description: "say hi",
        inputSchema: {},
        expectedEffects: ["emit_tool"],
        handler: async () => ({ ok: true }),
      });`,
    );
    vi.spyOn(lifecycle, "getActiveScope").mockReturnValue(scope);
    await bootstrapPlugins();

    const tools = getContributedTools();
    expect(tools.length).toBe(1);
    expect(tools[0].pluginId).toBe("examples.contrib-tool");
    expect(tools[0].definition.name).toBe("examples.contrib-tool.hello");
    expect(tools[0].active).toBe(true);
    expect(isPluginActivated("examples.contrib-tool")).toBe(true);
  });

  it("rejects tool registration with tool_name_unprefixed when name lacks plugin id prefix", async () => {
    await writeContribPlugin(
      "examples.bad-name",
      {
        expectedEffects: ["emit_tool"],
        capabilities: ["tools:register"],
      },
      `try { ctx.tools.register({
        name: "wrong_prefix.foo",
        description: "x",
        inputSchema: {},
        expectedEffects: ["emit_tool"],
        handler: async () => ({}),
      }); } catch (_) {}`,
    );
    vi.spyOn(lifecycle, "getActiveScope").mockReturnValue(scope);
    const { events, unsubscribe } = collectPluginEvents();
    try {
      await bootstrapPlugins();
      expect(getContributedTools().length).toBe(0);
      const rejected = events.find(
        (e) =>
          e.kind === "plugin.output.rejected" &&
          (e.payload as { reason?: string })?.reason === "tool_name_unprefixed",
      );
      expect(rejected).toBeDefined();
    } finally {
      unsubscribe();
    }
  });

  it("registers a contributed resource and gates uri namespace", async () => {
    await writeContribPlugin(
      "examples.contrib-res",
      {
        expectedEffects: ["emit_resource"],
        capabilities: ["resources:register"],
        resources: [{ uriNamespace: "plugin://examples.contrib-res/data" }],
      },
      `ctx.resources.register({
        uriNamespace: "plugin://examples.contrib-res/data",
        description: "data feed",
        expectedEffects: ["emit_resource"],
        handler: async () => ({ rows: [] }),
      });`,
    );
    vi.spyOn(lifecycle, "getActiveScope").mockReturnValue(scope);
    await bootstrapPlugins();
    const resources = getContributedResources();
    expect(resources.length).toBe(1);
    expect(resources[0].definition.uriNamespace).toBe(
      "plugin://examples.contrib-res/data",
    );
    expect(resources[0].active).toBe(true);
  });
});

describe("plugin hot lifecycle (M3.5)", () => {
  it("unloadPluginById deactivates and drops contributions", async () => {
    await writeContribPlugin(
      "examples.unload-me",
      {
        expectedEffects: ["emit_tool"],
        capabilities: ["tools:register"],
      },
      `ctx.tools.register({
        name: "examples.unload-me.ping",
        description: "ping",
        inputSchema: {},
        expectedEffects: ["emit_tool"],
        handler: async () => "pong",
      });`,
    );
    vi.spyOn(lifecycle, "getActiveScope").mockReturnValue(scope);
    await bootstrapPlugins();
    expect(getContributedTools().length).toBe(1);
    expect(isPluginActivated("examples.unload-me")).toBe(true);

    const { events, unsubscribe } = collectPluginEvents();
    try {
      const result = await unloadPluginById("examples.unload-me", "disable");
      expect(result.unloaded).toBe(true);
      expect(getContributedTools().length).toBe(0);
      expect(isPluginActivated("examples.unload-me")).toBe(false);
      const unloaded = events.find((e) => e.kind === "plugin.unloaded");
      expect(unloaded).toBeDefined();
    } finally {
      unsubscribe();
    }
  });

  it("reloadPlugin re-activates a plugin and re-registers contributions fresh", async () => {
    await writeContribPlugin(
      "examples.reload-me",
      {
        expectedEffects: ["emit_tool"],
        capabilities: ["tools:register"],
      },
      `ctx.tools.register({
        name: "examples.reload-me.ping",
        description: "ping",
        inputSchema: {},
        expectedEffects: ["emit_tool"],
        handler: async () => "pong",
      });`,
    );
    vi.spyOn(lifecycle, "getActiveScope").mockReturnValue(scope);
    await bootstrapPlugins();
    expect(getContributedTools().length).toBe(1);

    const result = await reloadPlugin("examples.reload-me");
    expect(result.reloaded).toBe(true);
    const tools = getContributedTools();
    expect(tools.length).toBe(1);
    expect(tools[0].active).toBe(true);
    expect(isPluginActivated("examples.reload-me")).toBe(true);
  });
});
