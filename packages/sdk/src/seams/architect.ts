/**
 * Declarative standalone Architect plugin surfaces.
 *
 * Plugins execute trusted host-side handlers. Browser clients receive only
 * validated JSON snapshots rendered by host-supported renderer kinds.
 */
export type ArchitectPlanConnectivity = "required" | "optional" | "none";
export type ArchitectRendererKind = "checklist";
export type ArchitectJsonSchema = Record<string, unknown>;

export interface ArchitectPlanContext {
  pluginId: string;
  tabTypeId: string;
  planId: string | null;
}

export interface ArchitectPlanActionContext extends ArchitectPlanContext {
  revision: string | null;
}

export interface ArchitectPlanWriteContext extends ArchitectPlanContext {
  revision: string | null;
}

export interface ArchitectStoredState<T = unknown> {
  value: T;
  revision: string;
  updatedAt: string;
}

export interface ArchitectActionDefinition<TAction = unknown> {
  id: string;
  inputSchema: ArchitectJsonSchema;
}

export interface ArchitectSidebarSummaryDefinition {
  kind: "checklist-progress";
}

export interface ArchitectStatusBadgeDefinition {
  id: string;
  kind: "count" | "status";
}

export interface ArchitectTabTypeDefinition<TState = unknown, TAction = unknown> {
  id: string;
  title: string;
  icon?: string;
  renderer: ArchitectRendererKind;
  planConnectivity: ArchitectPlanConnectivity;
  stateSchema: ArchitectJsonSchema;
  actions: readonly ArchitectActionDefinition<TAction>[];
  sidebarSummary?: ArchitectSidebarSummaryDefinition;
  badges?: readonly ArchitectStatusBadgeDefinition[];
  loadState(context: ArchitectPlanContext): Promise<TState> | TState;
  handleAction?(action: TAction, context: ArchitectPlanActionContext): Promise<TState> | TState;
}

export function defineArchitectTab<TState = unknown, TAction = unknown>(
  definition: ArchitectTabTypeDefinition<TState, TAction>,
): ArchitectTabTypeDefinition<TState, TAction> {
  return definition;
}
