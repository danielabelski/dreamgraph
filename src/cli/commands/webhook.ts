/**
 * `dg webhook` — DreamGraph outbound webhook management (M5).
 *
 * Subcommands:
 *   dg webhook list <instance>
 *   dg webhook add <instance> --url <u> --secret <s> --events <csv> [--label <l>] [--disabled]
 *   dg webhook remove <instance> <id>
 *   dg webhook enable <instance> <id>
 *   dg webhook disable <instance> <id>
 *   dg webhook test <instance> <id>
 *   dg webhook dead-letter <instance>
 *   dg webhook replay <instance> <delivery-id>
 *
 * All subcommands proxy to the running daemon via MCP (over its HTTP port).
 */

import { resolve } from "node:path";
import {
  loadRegistry,
  findInstance,
  resolveMasterDir,
} from "../../instance/cli.js";
import { readServerMeta, isProcessAlive } from "../utils/daemon.js";
import { mcpCallTool } from "../utils/mcp-call.js";
import type { ParsedArgs } from "../dg.js";

function printUsage(): void {
  console.log(`
dg webhook — Manage outbound webhook subscriptions (M5)

Subcommands:
  dg webhook list <instance>
  dg webhook add <instance> --url <u> --secret <s> --events <csv> [--label <l>] [--disabled]
  dg webhook remove <instance> <subscription-id>
  dg webhook enable <instance> <subscription-id>
  dg webhook disable <instance> <subscription-id>
  dg webhook test <instance> <subscription-id>
  dg webhook dead-letter <instance>
  dg webhook replay <instance> <delivery-id>

Options:
  --url <url>             Destination URL (https or http://localhost).
  --secret <secret>       Shared HMAC-SHA256 secret (>=16 chars).
  --events <csv>          Comma-separated event kinds, or '*' for all.
  --label <label>         Optional human label.
  --disabled              Register paused (default enabled).
  --master-dir <path>     Override master directory.
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

async function callDaemon(
  instanceRoot: string,
  tool: string,
  args: Record<string, unknown>,
): Promise<void> {
  const meta = await readServerMeta(instanceRoot);
  if (!meta || !isProcessAlive(meta.pid) || meta.port == null) {
    console.error(`Daemon is not running for this instance. Start it with: dg start <instance>`);
    process.exit(1);
  }
  try {
    const result = await mcpCallTool(meta.port, tool, args, 30_000);
    const text = result.content?.[0]?.text ?? "{}";
    console.log(text);
  } catch (err) {
    console.error(`Daemon call '${tool}' failed: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }
}

function requireFlagString(flags: ParsedArgs["flags"], key: string): string {
  const v = flags[key];
  if (typeof v !== "string" || v.length === 0) {
    console.error(`Missing required flag: --${key}`);
    process.exit(1);
  }
  return v as string;
}

/**
 * Normalize the --events flag, accepting any of:
 *   --events snapshot.changed,webhook.delivered      (PowerShell, csv)
 *   --events "snapshot.changed webhook.delivered"   (bash, space)
 *   --events snapshot.changed --events webhook.delivered  (repeated)
 */
function parseEvents(raw: string | string[] | true | undefined): string[] {
  if (raw === undefined || raw === true) return [];
  const parts = Array.isArray(raw) ? raw : [raw];
  return parts
    .flatMap((v) => v.split(/[,\s]+/))
    .map((v) => v.trim())
    .filter((v) => v.length > 0);
}

export async function cmdWebhook(
  positional: string[],
  flags: ParsedArgs["flags"],
): Promise<void> {
  if (flags.help || flags.h) {
    printUsage();
    return;
  }
  const sub = positional[0];
  const rest = positional.slice(1);
  switch (sub) {
    case undefined:
    case "help":
      printUsage();
      return;

    case "list": {
      const [query] = rest;
      if (!query) return printUsage();
      const root = await resolveInstanceRoot(query, flags);
      await callDaemon(root, "webhook_list", {});
      return;
    }

    case "add": {
      const [query] = rest;
      if (!query) return printUsage();
      const root = await resolveInstanceRoot(query, flags);
      const url = requireFlagString(flags, "url");
      const secret = requireFlagString(flags, "secret");
      const events = parseEvents(flags.events);
      if (events.length === 0) {
        console.error("Missing required flag: --events <csv|space-separated|repeated>");
        process.exit(1);
      }
      const args: Record<string, unknown> = { url, secret, events };
      if (typeof flags.label === "string") args.label = flags.label;
      if (flags.disabled === true) args.enabled = false;
      await callDaemon(root, "webhook_register", args);
      return;
    }

    case "remove": {
      const [query, id] = rest;
      if (!query || !id) return printUsage();
      const root = await resolveInstanceRoot(query, flags);
      await callDaemon(root, "webhook_remove", { id });
      return;
    }

    case "enable":
    case "disable": {
      const [query, id] = rest;
      if (!query || !id) return printUsage();
      const root = await resolveInstanceRoot(query, flags);
      await callDaemon(root, "webhook_set_enabled", { id, enabled: sub === "enable" });
      return;
    }

    case "test": {
      const [query, id] = rest;
      if (!query || !id) return printUsage();
      const root = await resolveInstanceRoot(query, flags);
      await callDaemon(root, "webhook_test", { id });
      return;
    }

    case "dead-letter":
    case "deadletter":
    case "dlq": {
      const [query] = rest;
      if (!query) return printUsage();
      const root = await resolveInstanceRoot(query, flags);
      await callDaemon(root, "webhook_dead_letter_list", {});
      return;
    }

    case "replay": {
      const [query, deliveryId] = rest;
      if (!query || !deliveryId) return printUsage();
      const root = await resolveInstanceRoot(query, flags);
      await callDaemon(root, "webhook_replay", { delivery_id: deliveryId });
      return;
    }

    default:
      console.error(`Unknown webhook subcommand: ${sub}`);
      printUsage();
      process.exit(1);
  }
}
