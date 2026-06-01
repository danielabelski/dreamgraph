import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { atomicWriteFile } from "../utils/atomic-write.js";
import { withFileLock } from "../utils/mutex.js";
import { dataPath } from "../utils/paths.js";
import { listPlanFiles } from "../architect/plan-registry.js";

export interface ArchitectPlanStateEntry<T = unknown> {
  value: T;
  revision: string;
  updatedAt: string;
}

interface ArchitectPlanStateFile {
  version: 1;
  entries: Record<string, ArchitectPlanStateEntry>;
}

export class ArchitectPlanStateError extends Error {
  constructor(public readonly code: "architect_plan_required" | "architect_plan_not_found" | "architect_revision_stale", message: string) {
    super(message);
  }
}

const storeName = "architect_plugin_plan_state.json";
const storePath = () => dataPath(storeName);

function entryId(pluginId: string, planId: string, tabTypeId: string, key: string): string {
  return [pluginId, planId, tabTypeId, key].map(encodeURIComponent).join("|");
}

async function loadStore(): Promise<ArchitectPlanStateFile> {
  if (!existsSync(storePath())) return { version: 1, entries: {} };
  try {
    const parsed = JSON.parse(await readFile(storePath(), "utf8")) as Partial<ArchitectPlanStateFile>;
    return { version: 1, entries: parsed.entries && typeof parsed.entries === "object" ? parsed.entries : {} };
  } catch {
    return { version: 1, entries: {} };
  }
}

async function assertPlan(planId: string | null): Promise<string> {
  if (!planId) throw new ArchitectPlanStateError("architect_plan_required", "An explicit planId is required");
  const files = await listPlanFiles();
  if (!files.includes(`${planId}.md`)) throw new ArchitectPlanStateError("architect_plan_not_found", `Plan '${planId}' does not exist`);
  return planId;
}

function revisionFor(value: unknown, updatedAt: string): string {
  return createHash("sha256").update(JSON.stringify({ value, updatedAt })).digest("hex").slice(0, 16);
}

export async function readArchitectPluginPlanState<T>(args: { pluginId: string; planId: string | null; tabTypeId: string; key: string }): Promise<ArchitectPlanStateEntry<T> | null> {
  const planId = await assertPlan(args.planId);
  const store = await loadStore();
  return (store.entries[entryId(args.pluginId, planId, args.tabTypeId, args.key)] as ArchitectPlanStateEntry<T> | undefined) ?? null;
}

export async function writeArchitectPluginPlanState<T>(args: { pluginId: string; planId: string | null; tabTypeId: string; key: string; value: T; revision?: string | null }): Promise<ArchitectPlanStateEntry<T>> {
  const planId = await assertPlan(args.planId);
  return withFileLock(storeName, async () => {
    const store = await loadStore();
    const id = entryId(args.pluginId, planId, args.tabTypeId, args.key);
    const current = store.entries[id];
    if (current && args.revision !== current.revision) {
      throw new ArchitectPlanStateError("architect_revision_stale", `Revision for '${args.key}' is stale`);
    }
    if (!current && args.revision) {
      throw new ArchitectPlanStateError("architect_revision_stale", `Revision for new key '${args.key}' must be empty`);
    }
    const updatedAt = new Date().toISOString();
    const entry = { value: args.value, updatedAt, revision: revisionFor(args.value, updatedAt) };
    store.entries[id] = entry;
    await atomicWriteFile(storePath(), JSON.stringify(store, null, 2));
    return entry;
  });
}
