/**
 * `dg plugin` — DreamGraph plugin host management commands.
 *
 * Subcommands:
 *   dg plugin list <instance>             List discovered plugins
 *   dg plugin inspect <instance> <id>     Show full manifest + status
 *   dg plugin enable <instance> <id>      Mark plugin enabled in instance.json
 *   dg plugin disable <instance> <id>     Mark plugin disabled in instance.json
 *   dg plugin trust <instance> <id>       Mark plugin trusted (in-process exec)
 *   dg plugin untrust <instance> <id>     Remove trust override
 *
 * `list` and `inspect` are read-only and run discovery in-process, so they
 * work whether or not the daemon is running. `enable/disable/trust/untrust`
 * mutate `<instance>/instance.json` and require a restart to take effect.
 */

import { promises as fs } from "node:fs";
import { resolve } from "node:path";
import {
  discoverPlugins,
  type DiscoveredPlugin,
} from "@dreamgraph/host";
import {
  loadRegistry,
  findInstance,
  resolveMasterDir,
} from "../../instance/cli.js";
import {
  readServerMeta,
  isProcessAlive,
} from "../utils/daemon.js";
import { mcpCallTool } from "../utils/mcp-call.js";
import type { ParsedArgs } from "../dg.js";

interface InstancePluginEntry {
  path?: string;
  package?: string;
  trusted?: boolean;
  enabled?: boolean;
}
interface InstancePluginsManifest {
  plugins?: InstancePluginEntry[];
  experimental_plugins?: boolean;
  [k: string]: unknown;
}

class NullEmitter {
  emit(): void {}
}

function printPluginUsage(): void {
  console.log(`
dg plugin — Manage host runtime plugins (M3)

Subcommands:
  dg plugin list <instance>                List discovered plugins
  dg plugin inspect <instance> <plugin-id> Show full manifest + status
  dg plugin enable <instance> <plugin-id>  Mark plugin enabled in instance.json
  dg plugin disable <instance> <plugin-id> Mark plugin disabled in instance.json
  dg plugin trust <instance> <plugin-id>   Trust plugin for in-process execution
  dg plugin untrust <instance> <plugin-id> Remove trust override
  dg plugin reload <instance> <plugin-id>  Hot-reload a plugin in the running daemon
  dg plugin unload <instance> <plugin-id>  Hot-unload a plugin in the running daemon

Options:
  --json                  Output structured JSON
  --master-dir <path>     Override master directory

Plugins are loaded from <instance>/plugins/<id>/plugin.json and from any
entries in <instance>/instance.json:plugins[]. Mutating subcommands
(enable/disable/trust/untrust) require a daemon restart to take effect.
The reload/unload subcommands take effect immediately on the running daemon.
`);
}

async function resolveInstanceRoot(
  query: string,
  flags: ParsedArgs["flags"],
): Promise<string> {
  const masterDir =
    typeof flags["master-dir"] === "string"
      ? resolve(flags["master-dir"])
      : undefined;
  const { registry } = await loadRegistry(masterDir);
  const entry = findInstance(registry, query);
  if (!entry) {
    console.error(`Instance not found: ${String(query).replace(/[^\w\-]/g, "?")}`);
    process.exit(1);
  }
  const dir = masterDir ?? resolveMasterDir();
  return resolve(dir, entry.uuid);
}

async function loadDiscovered(
  instanceRoot: string,
): Promise<DiscoveredPlugin[]> {
  return await discoverPlugins({
    instanceRoot,
    instanceUuid: "cli-readonly",
    telemetry: new NullEmitter(),
  });
}

async function readInstancePluginsManifest(
  instanceRoot: string,
): Promise<{ data: InstancePluginsManifest; path: string; raw: string }> {
  const path = resolve(instanceRoot, "instance.json");
  const raw = await fs.readFile(path, "utf-8");
  const stripped = raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw;
  return { data: JSON.parse(stripped) as InstancePluginsManifest, path, raw };
}

async function writeInstancePluginsManifest(
  path: string,
  data: InstancePluginsManifest,
): Promise<void> {
  await fs.writeFile(path, JSON.stringify(data, null, 2) + "\n", "utf-8");
}

async function ensurePluginEntry(
  instanceRoot: string,
  pluginId: string,
): Promise<{ entry: InstancePluginEntry; data: InstancePluginsManifest; path: string }> {
  const { data, path } = await readInstancePluginsManifest(instanceRoot);
  if (!Array.isArray(data.plugins)) data.plugins = [];

  const discovered = await loadDiscovered(instanceRoot);
  const match = discovered.find((d) => d.manifest.id === pluginId);

  let entry = data.plugins.find((p) => {
    if (p.path) {
      // Match the instance-relative path to the discovered plugin root.
      return match?.rootDir?.endsWith(p.path.replace(/\\/g, "/"));
    }
    return false;
  });

  if (!entry) {
    if (!match || !match.rootDir) {
      console.error(
        `Plugin '${pluginId}' was not discovered under <instance>/plugins/. ` +
          `Add an entry to instance.json:plugins[] manually if it lives outside.`,
      );
      process.exit(1);
    }
    const relPath = match.rootDir.startsWith(instanceRoot)
      ? match.rootDir.slice(instanceRoot.length + 1).replace(/\\/g, "/")
      : match.rootDir;
    entry = { path: relPath };
    data.plugins.push(entry);
  }
  return { entry, data, path };
}

/* ------------------------------------------------------------------ */
/*  list                                                              */
/* ------------------------------------------------------------------ */

async function cmdList(positional: string[], flags: ParsedArgs["flags"]): Promise<void> {
  const query = positional[0];
  if (!query) {
    console.error("Usage: dg plugin list <instance>");
    process.exit(1);
  }
  const instanceRoot = await resolveInstanceRoot(query, flags);
  const discovered = await loadDiscovered(instanceRoot);

  if (flags.json === true) {
    const out = discovered.map((d) => ({
      id: d.manifest.id,
      version: d.manifest.version,
      enabled: d.enabled,
      trusted: d.trusted,
      capabilities: d.manifest.capabilities,
      manifest_source: d.manifestSourcePath,
    }));
    console.log(JSON.stringify(out, null, 2));
    return;
  }

  if (discovered.length === 0) {
    console.log("No plugins discovered.");
    console.log(
      `  Looked in: ${resolve(instanceRoot, "plugins")} and ${resolve(instanceRoot, "instance.json")}:plugins[]`,
    );
    return;
  }

  console.log(`Discovered ${discovered.length} plugin(s) for instance at ${instanceRoot}:\n`);
  for (const d of discovered) {
    const trust = d.trusted ? "trusted" : "untrusted";
    const enabled = d.enabled ? "enabled" : "DISABLED";
    console.log(
      `  ${d.manifest.id}@${d.manifest.version}  [${enabled}] [${trust}]`,
    );
    console.log(
      `    capabilities: ${d.manifest.capabilities.join(", ") || "(none)"}`,
    );
    console.log(`    manifest:     ${d.manifestSourcePath}`);
  }
}

/* ------------------------------------------------------------------ */
/*  inspect                                                           */
/* ------------------------------------------------------------------ */

async function cmdInspect(
  positional: string[],
  flags: ParsedArgs["flags"],
): Promise<void> {
  const [query, pluginId] = positional;
  if (!query || !pluginId) {
    console.error("Usage: dg plugin inspect <instance> <plugin-id>");
    process.exit(1);
  }
  const instanceRoot = await resolveInstanceRoot(query, flags);
  const discovered = await loadDiscovered(instanceRoot);
  const match = discovered.find((d) => d.manifest.id === pluginId);
  if (!match) {
    console.error(
      `Plugin '${pluginId.replace(/[^\w.\-]/g, "?")}' not found among ${discovered.length} discovered.`,
    );
    process.exit(1);
  }
  const summary = {
    id: match.manifest.id,
    version: match.manifest.version,
    enabled: match.enabled,
    trusted: match.trusted,
    manifest_source: match.manifestSourcePath,
    root_dir: match.rootDir,
    manifest: match.manifest,
  };
  if (flags.json === true) {
    console.log(JSON.stringify(summary, null, 2));
    return;
  }
  console.log(JSON.stringify(summary, null, 2));
}

/* ------------------------------------------------------------------ */
/*  enable / disable / trust / untrust                                */
/* ------------------------------------------------------------------ */

async function setEntryFlag(
  positional: string[],
  flags: ParsedArgs["flags"],
  field: "enabled" | "trusted",
  value: boolean,
  successVerb: string,
): Promise<void> {
  const [query, pluginId] = positional;
  if (!query || !pluginId) {
    console.error(`Usage: dg plugin <subcommand> <instance> <plugin-id>`);
    process.exit(1);
  }
  const instanceRoot = await resolveInstanceRoot(query, flags);
  const { entry, data, path } = await ensurePluginEntry(instanceRoot, pluginId);
  entry[field] = value;
  await writeInstancePluginsManifest(path, data);
  console.log(`${successVerb} '${pluginId}' in ${path}`);
  console.log("  Restart the daemon for changes to take effect: dg restart <instance>");
}

/* ------------------------------------------------------------------ */
/*  reload / unload — talk to running daemon via MCP                  */
/* ------------------------------------------------------------------ */

async function callDaemonTool(
  instanceRoot: string,
  tool: string,
  args: Record<string, unknown>,
): Promise<void> {
  const meta = await readServerMeta(instanceRoot);
  if (!meta || !isProcessAlive(meta.pid) || meta.port == null) {
    console.error(
      `Daemon is not running for this instance. Start it first: dg start <instance>`,
    );
    process.exit(1);
  }
  try {
    const result = await mcpCallTool(meta.port, tool, args, 30_000);
    const text = result.content?.[0]?.text ?? "{}";
    console.log(text);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`Daemon call '${tool}' failed: ${msg}`);
    process.exit(1);
  }
}

async function cmdReload(
  positional: string[],
  flags: ParsedArgs["flags"],
): Promise<void> {
  const [query, pluginId] = positional;
  if (!query || !pluginId) {
    console.error("Usage: dg plugin reload <instance> <plugin-id>");
    process.exit(1);
  }
  const instanceRoot = await resolveInstanceRoot(query, flags);
  await callDaemonTool(instanceRoot, "plugin_reload", { plugin_id: pluginId });
}

async function cmdUnload(
  positional: string[],
  flags: ParsedArgs["flags"],
): Promise<void> {
  const [query, pluginId] = positional;
  if (!query || !pluginId) {
    console.error("Usage: dg plugin unload <instance> <plugin-id>");
    process.exit(1);
  }
  const instanceRoot = await resolveInstanceRoot(query, flags);
  const args: Record<string, unknown> = { plugin_id: pluginId };
  if (typeof flags.reason === "string") args.reason = flags.reason;
  await callDaemonTool(instanceRoot, "plugin_unload", args);
}

/* ------------------------------------------------------------------ */
/*  Router                                                            */
/* ------------------------------------------------------------------ */

export async function cmdPlugin(
  positional: string[],
  flags: ParsedArgs["flags"],
): Promise<void> {
  if (flags.help || flags.h) {
    printPluginUsage();
    return;
  }
  const sub = positional[0];
  const rest = positional.slice(1);
  switch (sub) {
    case undefined:
    case "help":
      printPluginUsage();
      return;
    case "list":
      await cmdList(rest, flags);
      return;
    case "inspect":
      await cmdInspect(rest, flags);
      return;
    case "enable":
      await setEntryFlag(rest, flags, "enabled", true, "Enabled plugin");
      return;
    case "disable":
      await setEntryFlag(rest, flags, "enabled", false, "Disabled plugin");
      return;
    case "trust":
      await setEntryFlag(rest, flags, "trusted", true, "Trusted plugin");
      return;
    case "untrust":
      await setEntryFlag(rest, flags, "trusted", false, "Untrusted plugin");
      return;
    case "reload":
      await cmdReload(rest, flags);
      return;
    case "unload":
      await cmdUnload(rest, flags);
      return;
    default:
      console.error(`Unknown plugin subcommand: ${sub}`);
      printPluginUsage();
      process.exit(1);
  }
}
