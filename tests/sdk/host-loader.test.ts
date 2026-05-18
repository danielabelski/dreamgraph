import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  PluginRegistry,
  RecordingTelemetryEmitter,
  discoverPlugins,
  loadDiscoveredPlugins,
  unloadPlugin,
} from "../../packages/host/src/index.js";

let instanceRoot: string;

function manifestJson(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    id: "example.plugin",
    version: "0.1.0",
    displayName: "Example Plugin",
    engine: { dreamgraph: ">=9.0.0" },
    main: "./dist/index.js",
    intent: "loader integration test plugin",
    expectedEffects: ["emit_tool"],
    forbiddenEffects: ["write_internal_graph"],
    capabilities: ["tools:register"],
    tools: [{ name: "example_plugin_echo" }],
    resources: [{ uriNamespace: "plugin://example.plugin/" }],
    ...overrides,
  });
}

beforeEach(async () => {
  instanceRoot = await mkdtemp(join(tmpdir(), "dg-host-loader-"));
});

afterEach(async () => {
  await rm(instanceRoot, { recursive: true, force: true });
});

describe("host plugin loader", () => {
  it("discovers a plugin from <instance>/plugins/<id>/plugin.json", async () => {
    const pluginDir = join(instanceRoot, "plugins", "example.plugin");
    await mkdir(pluginDir, { recursive: true });
    await writeFile(join(pluginDir, "plugin.json"), manifestJson());

    const telemetry = new RecordingTelemetryEmitter();
    const discovered = await discoverPlugins({
      instanceRoot,
      instanceUuid: "test-instance",
      telemetry,
    });

    expect(discovered).toHaveLength(1);
    expect(discovered[0].manifest.id).toBe("example.plugin");
    expect(discovered[0].trusted).toBe(false);
    expect(discovered[0].enabled).toBe(true);
  });

  it("emits plugin.loaded and a trust banner when trusted plugin is loaded with switch off", async () => {
    const pluginDir = join(instanceRoot, "plugins", "example.plugin");
    await mkdir(pluginDir, { recursive: true });
    await writeFile(join(pluginDir, "plugin.json"), manifestJson());
    await writeFile(
      join(instanceRoot, "instance.json"),
      JSON.stringify({
        plugins: [{ path: "plugins/example.plugin", trusted: true }],
      }),
    );

    const telemetry = new RecordingTelemetryEmitter();
    const banners: string[] = [];
    const registry = new PluginRegistry();
    const loader = {
      instanceRoot,
      instanceUuid: "test-instance",
      telemetry,
      safety: {
        allowInProcessPlugins: false,
        bannerSink: (line: string) => banners.push(line),
      },
    };
    const discovered = await discoverPlugins(loader);
    const outcomes = await loadDiscoveredPlugins({
      loader,
      registry,
      discovered,
    });

    expect(outcomes).toEqual([
      expect.objectContaining({ status: "loaded" }),
    ]);
    expect(registry.list()).toHaveLength(1);
    expect(telemetry.events.map((e) => e.kind)).toContain("plugin.loaded");
    expect(banners[0]).toMatch(
      /^plugin example\.plugin@0\.1\.0 loaded with FULL HOST TRUST \(in-process\)/,
    );
  });

  it("rejects in-process load when switch is off and plugin is untrusted", async () => {
    const pluginDir = join(instanceRoot, "plugins", "example.plugin");
    await mkdir(pluginDir, { recursive: true });
    await writeFile(join(pluginDir, "plugin.json"), manifestJson());

    const telemetry = new RecordingTelemetryEmitter();
    const registry = new PluginRegistry();
    const loader = {
      instanceRoot,
      instanceUuid: "test-instance",
      telemetry,
      safety: {
        allowInProcessPlugins: false,
        bannerSink: () => undefined,
      },
    };
    const discovered = await discoverPlugins(loader);
    const outcomes = await loadDiscoveredPlugins({
      loader,
      registry,
      discovered,
    });

    expect(outcomes[0].status).toBe("rejected");
    expect(outcomes[0].reason).toBe("in_process_execution_disabled");
    expect(registry.list()).toHaveLength(0);
    const rejected = telemetry.events.find(
      (e) => e.kind === "plugin.output.rejected",
    );
    expect(rejected).toBeDefined();
    expect((rejected!.payload as { reason: string }).reason).toBe(
      "in_process_execution_disabled",
    );
  });

  it("emits plugin.unloaded when a plugin is removed", async () => {
    const pluginDir = join(instanceRoot, "plugins", "example.plugin");
    await mkdir(pluginDir, { recursive: true });
    await writeFile(join(pluginDir, "plugin.json"), manifestJson());

    const telemetry = new RecordingTelemetryEmitter();
    const registry = new PluginRegistry();
    const loader = {
      instanceRoot,
      instanceUuid: "test-instance",
      telemetry,
      safety: {
        allowInProcessPlugins: true,
        bannerSink: () => undefined,
      },
    };
    const discovered = await discoverPlugins(loader);
    await loadDiscoveredPlugins({ loader, registry, discovered });
    telemetry.clear();

    unloadPlugin({
      registry,
      telemetry,
      pluginId: "example.plugin",
      reason: "shutdown",
    });

    expect(telemetry.events).toEqual([
      expect.objectContaining({
        kind: "plugin.unloaded",
        payload: expect.objectContaining({ reason: "shutdown" }),
      }),
    ]);
    expect(registry.list()).toHaveLength(0);
  });
});
