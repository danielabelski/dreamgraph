/**
 * M6 — UI typed builder seam (metadata).
 *
 * Plugins describe semantic UI elements declaratively. The host writes
 * them into `ui_registry.json` via the same locked path used by the
 * `register_ui_element` MCP tool. No iframe / executable surface is
 * exposed here — that is the post-1.0 `4.7 ui (executable iframe)`
 * surface and remains SPECULATIVE until M8.
 *
 * Naming gate (enforced by the host, mirrors the tool seam): the element
 * id MUST be prefixed with `<plugin-id>.` so registry entries are
 * traceable to their owning plugin and survive unload/reload cycles.
 */
import type { PluginEffect } from "../manifest.js";

/** Element category — must match the host's SemanticElementCategory enum. */
export type UiElementCategory =
  | "data_display"
  | "data_input"
  | "navigation"
  | "feedback"
  | "layout"
  | "action"
  | "composite";

export interface UiElementInput {
  name: string;
  type: string;
  description: string;
  required: boolean;
}

export interface UiElementOutput {
  name: string;
  type: string;
  description: string;
  /** e.g. "on_click", "on_change", "on_submit" */
  trigger: string;
}

export interface UiElementInteraction {
  /** e.g. "sort", "filter", "select", "edit_inline" */
  action: string;
  description: string;
}

export interface UiElementImplementation {
  /** e.g. "react", "vscode-webview", "vue", "cli" */
  platform: string;
  /** Component name on the platform (required by the host registry). */
  component: string;
  /** Optional pointer to the source file or module. */
  source_file?: string;
  /** Optional human note about how this is realized on the platform. */
  notes?: string;
}

export interface UiElementDefinition {
  /** Must start with `<plugin-id>.` (host-enforced). */
  id: string;
  name: string;
  purpose: string;
  category: UiElementCategory;
  inputs: UiElementInput[];
  outputs: UiElementOutput[];
  interactions: UiElementInteraction[];
  /** Optional child element ids (semantic composition). */
  children?: string[];
  implementations?: UiElementImplementation[];
  used_by?: string[];
  tags?: string[];
  /**
   * Effects this element claims at registration time. Must be a subset of
   * the manifest's `expectedEffects`. The only meaningful effect for the
   * metadata seam is `mutate_ui_registry`; the field is kept for
   * symmetry with tools/resources.
   */
  expectedEffects?: PluginEffect[];
}

/** Identity helper used by `defineUiElement` for type inference. */
export function defineUiElement(definition: UiElementDefinition): UiElementDefinition {
  return definition;
}
