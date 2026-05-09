/**
 * §4.8 — Archetypes provider seam.
 *
 * Plugins register a *provider* — either an inline static payload or a
 * `fetch(): Promise<ArchetypePayload>` callable the host can invoke to
 * pull the current bundle. The seam intentionally avoids polling
 * scheduling: the host triggers fetches via existing federation flows.
 */

/** A single archetype as carried over the federation contract. */
export interface ArchetypeRecord {
  id: string;
  name: string;
  summary: string;
  /** Free-form tags used by the federation matcher. */
  tags?: string[];
  /** Provider-specific payload; opaque to the host. */
  payload?: unknown;
}

/** The bundle a provider returns at fetch time. */
export interface ArchetypePayload {
  source: string;
  version: string;
  archetypes: ArchetypeRecord[];
}

export interface ArchetypeProviderDefinition {
  /** Stable id within the plugin's namespace. The host prefixes the
   * stored provider with `<plugin-id>:` for global uniqueness. */
  id: string;
  /** Display label. */
  name: string;
  /** Optional remote URL the host MAY poll instead of calling `fetch()`. */
  url?: string;
  /** Optional polling interval hint, in seconds. Host may ignore. */
  poll_interval_s?: number;
  /** Inline payload. If provided, the host consumes it once at register
   * time and `fetch` is optional. */
  inline?: ArchetypePayload;
  /**
   * Lazy callable. Invoked by the host when it needs a fresh bundle
   * (e.g. on a federation export). Required if `url` and `inline` are
   * both omitted.
   */
  fetch?: () => Promise<ArchetypePayload>;
}

/** Identity helper for IDE inference. */
export function defineArchetypeProvider(
  definition: ArchetypeProviderDefinition,
): ArchetypeProviderDefinition {
  return definition;
}
