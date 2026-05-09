/**
 * §4.9 — Markdown fences seam.
 *
 * Plugins register a custom code-fence language (`__lang__`) the explorer
 * webview should hand off for special rendering. This seam is the
 * **manifest-only stub** described in the roadmap: the host simply
 * journals the registration so the webview SDK can introspect which
 * fences exist, but no rendering boundary is exposed in-process yet.
 *
 * The non-webview renderer surface (CLI, web) lives behind this same
 * declaration so future renderers can opt in without changing manifests.
 */

export interface MarkdownFenceDefinition {
  /**
   * Lowercase language identifier (e.g. `mermaid`, `dg-flow`). MUST match
   * the regex `/^[a-z0-9][a-z0-9._-]*$/`.
   */
  language: string;
  /** Display label, surfaced in webview hover hints. */
  label: string;
  /** One-line description of what this fence renders. */
  description: string;
  /** Optional list of platforms the plugin can render on. */
  platforms?: Array<"webview" | "cli" | "web">;
}

/** Identity helper for IDE inference. */
export function defineMarkdownFence(
  definition: MarkdownFenceDefinition,
): MarkdownFenceDefinition {
  return definition;
}
