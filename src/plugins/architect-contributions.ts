import type { ArchitectStoredState, ArchitectTabTypeDefinition, PluginManifest, PluginRejectReason } from "@dreamgraph/sdk";
import { readArchitectPluginPlanState, writeArchitectPluginPlanState } from "./architect-plan-state.js";

export class ArchitectContributionError extends Error {
  constructor(public readonly code: PluginRejectReason, message: string) {
    super(message);
  }
}

export interface RegisteredArchitectTab {
  pluginId: string;
  pluginVersion: string;
  definition: ArchitectTabTypeDefinition;
  active: boolean;
}

export interface ArchitectTabDescriptor {
  id: string;
  pluginId: string;
  pluginVersion: string;
  title: string;
  icon?: string;
  renderer: "checklist";
  planConnectivity: "required" | "optional" | "none";
  actions: Array<{ id: string; inputSchema: Record<string, unknown> }>;
  sidebarSummary?: { kind: "checklist-progress" };
  badges?: Array<{ id: string; kind: "count" | "status" }>;
}

const tabs = new Map<string, RegisteredArchitectTab>();

function fail(code: PluginRejectReason, message: string): never {
  throw new ArchitectContributionError(code, message);
}

function requireCapability(manifest: PluginManifest, capability: "architect:register_tab" | "architect:read_plan" | "architect:write_plan_state" | "architect:register_sidebar_summary"): void {
  if (!manifest.capabilities.includes(capability)) fail(capability === "architect:register_tab" ? "architect_tab_capability_missing" : "architect_plan_state_capability_missing", `Manifest requires capability '${capability}'`);
}

function requireEffect(manifest: PluginManifest, effect: "render_architect_tab" | "read_architect_plan_projection" | "write_architect_plan_state" | "render_architect_sidebar_summary"): void {
  if (!manifest.expectedEffects.includes(effect)) fail("effect_undeclared", `Manifest requires effect '${effect}'`);
  if (manifest.forbiddenEffects.includes(effect)) fail("effect_forbidden", `Manifest forbids effect '${effect}'`);
}

function descriptorOf(tab: RegisteredArchitectTab): ArchitectTabDescriptor {
  const definition = tab.definition;
  return {
    id: definition.id,
    pluginId: tab.pluginId,
    pluginVersion: tab.pluginVersion,
    title: definition.title,
    ...(definition.icon ? { icon: definition.icon } : {}),
    renderer: definition.renderer,
    planConnectivity: definition.planConnectivity,
    actions: definition.actions.map((action) => ({ id: action.id, inputSchema: action.inputSchema })),
    ...(definition.sidebarSummary ? { sidebarSummary: definition.sidebarSummary } : {}),
    ...(definition.badges ? { badges: [...definition.badges] } : {}),
  };
}

function matchesSchema(schema: Record<string, unknown>, value: unknown): boolean {
  if (schema.type === "object") {
    if (!value || typeof value !== "object" || Array.isArray(value)) return false;
    const record = value as Record<string, unknown>;
    const required = Array.isArray(schema.required) ? schema.required.filter((item): item is string => typeof item === "string") : [];
    if (required.some((key) => !(key in record))) return false;
    const properties = schema.properties && typeof schema.properties === "object" ? schema.properties as Record<string, Record<string, unknown>> : {};
    return Object.entries(properties).every(([key, child]) => !(key in record) || matchesSchema(child, record[key]));
  }
  if (schema.type === "string") return typeof value === "string";
  if (schema.type === "boolean") return typeof value === "boolean";
  if (schema.type === "number") return typeof value === "number" && Number.isFinite(value);
  if (schema.type === "integer") return typeof value === "number" && Number.isInteger(value);
  if (schema.type === "array") return Array.isArray(value) && value.every((item) => matchesSchema((schema.items as Record<string, unknown> | undefined) ?? {}, item));
  return true;
}

export function registerArchitectTab(manifest: PluginManifest, definition: ArchitectTabTypeDefinition): () => void {
  requireCapability(manifest, "architect:register_tab");
  requireCapability(manifest, "architect:read_plan");
  requireEffect(manifest, "render_architect_tab");
  requireEffect(manifest, "read_architect_plan_projection");
  if (definition.sidebarSummary) {
    requireCapability(manifest, "architect:register_sidebar_summary");
    requireEffect(manifest, "render_architect_sidebar_summary");
  }
  if (!definition.id.startsWith(`${manifest.id}.`)) fail("architect_tab_id_unprefixed", `Tab '${definition.id}' must start with '${manifest.id}.'`);
  if (!manifest.architectTabs.some((tab) => tab.id === definition.id && tab.renderer === definition.renderer && tab.planConnectivity === definition.planConnectivity)) fail("architect_tab_undeclared", `Tab '${definition.id}' is not declared in plugin.json`);
  const existing = tabs.get(definition.id);
  if (existing && existing.pluginId !== manifest.id) fail("architect_tab_collision", `Tab '${definition.id}' is owned by '${existing.pluginId}'`);
  const tab = { pluginId: manifest.id, pluginVersion: manifest.version, definition, active: true };
  tabs.set(definition.id, tab);
  return () => { tab.active = false; if (tabs.get(definition.id) === tab) tabs.delete(definition.id); };
}

export function listArchitectTabs(): ArchitectTabDescriptor[] {
  return [...tabs.values()].filter((tab) => tab.active).map(descriptorOf);
}

function activeTab(tabTypeId: string): RegisteredArchitectTab {
  const tab = tabs.get(tabTypeId);
  if (!tab?.active) fail("architect_tab_unavailable", `Architect tab '${tabTypeId}' is unavailable`);
  return tab;
}

export async function loadArchitectTabSnapshot(tabTypeId: string, planId: string | null): Promise<Record<string, unknown>> {
  const tab = activeTab(tabTypeId);
  if (tab.definition.planConnectivity === "required" && !planId) fail("architect_plan_required", "This Architect tab requires an explicit planId");
  const state = await tab.definition.loadState({ pluginId: tab.pluginId, tabTypeId, planId });
  return { descriptor: descriptorOf(tab), planId, state };
}

export async function dispatchArchitectTabAction(tabTypeId: string, planId: string | null, action: unknown, revision: string | null): Promise<Record<string, unknown>> {
  const tab = activeTab(tabTypeId);
  if (tab.definition.planConnectivity === "required" && !planId) fail("architect_plan_required", "This Architect tab requires an explicit planId");
  if (!action || typeof action !== "object") fail("architect_action_schema_invalid", "Action payload must be an object");
  const actionId = (action as Record<string, unknown>).type;
  const declared = tab.definition.actions.find((candidate) => candidate.id === actionId);
  if (!declared) fail("architect_action_unknown", `Unknown action '${String(actionId)}'`);
  if (!matchesSchema(declared.inputSchema, action)) fail("architect_action_schema_invalid", `Action '${declared.id}' does not match its schema`);
  if (!tab.definition.handleAction) fail("architect_action_unknown", `Tab '${tabTypeId}' has no action handler`);
  const state = await tab.definition.handleAction(action, { pluginId: tab.pluginId, tabTypeId, planId, revision });
  return { descriptor: descriptorOf(tab), planId, state };
}

export function createArchitectPlanStateSurface(manifest: PluginManifest) {
  return {
    async read<T>(key: string, context: { planId: string | null; tabTypeId: string }): Promise<ArchitectStoredState<T> | null> {
      requireCapability(manifest, "architect:read_plan");
      requireEffect(manifest, "read_architect_plan_projection");
      return readArchitectPluginPlanState<T>({ pluginId: manifest.id, key, ...context });
    },
    async write<T>(key: string, value: T, context: { planId: string | null; tabTypeId: string; revision: string | null }): Promise<ArchitectStoredState<T>> {
      requireCapability(manifest, "architect:write_plan_state");
      requireEffect(manifest, "write_architect_plan_state");
      return writeArchitectPluginPlanState<T>({ pluginId: manifest.id, key, value, ...context });
    },
  };
}

export function removeArchitectTabsByPlugin(pluginId: string): number {
  let removed = 0;
  for (const [id, tab] of tabs) if (tab.pluginId === pluginId) { tab.active = false; tabs.delete(id); removed += 1; }
  return removed;
}

export function _resetArchitectContributionsForTest(): void { tabs.clear(); }
