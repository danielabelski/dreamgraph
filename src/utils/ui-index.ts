/**
 * DreamGraph — UI registry indexing helper.
 *
 * Slice 1 (first-class UI graph citizenship). The resource index
 * (`index.json`) admits UI elements on the same terms as features /
 * workflows / data_model entries: only when they carry source provenance.
 *
 * Provenance gate: `source_repo` must be a non-empty string. Manual or
 * unscoped registry entries (no `source_repo`) remain in the UI registry
 * but are NOT canonical graph citizens — they are intentionally excluded
 * from the index so unevidenced UI nodes cannot impersonate facts.
 *
 * `source_kind` is descriptive (how the element entered the registry) and
 * does NOT gate indexing; `source_repo` does.
 */

import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";

import { dataPath } from "./paths.js";
import { logger } from "./logger.js";

export interface IndexableUIElement {
  id: string;
  name: string;
  source_repo: string;
}

/**
 * Load the UI registry and return the subset of elements that qualify
 * for inclusion in `index.json`. Tolerates a missing or unparseable
 * registry file by returning an empty array.
 */
export async function loadIndexableUIElements(): Promise<IndexableUIElement[]> {
  const file = dataPath("ui_registry.json");
  if (!existsSync(file)) return [];

  let raw: string;
  try {
    raw = await readFile(file, "utf-8");
  } catch (err) {
    logger.warn(
      `ui-index: failed to read ui_registry.json: ${err instanceof Error ? err.message : err}`,
    );
    return [];
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    logger.warn(
      `ui-index: ui_registry.json is not valid JSON: ${err instanceof Error ? err.message : err}`,
    );
    return [];
  }

  const elements = (parsed as { elements?: unknown }).elements;
  if (!Array.isArray(elements)) return [];

  const out: IndexableUIElement[] = [];
  for (const el of elements) {
    if (!el || typeof el !== "object") continue;
    const rec = el as Record<string, unknown>;
    const id = typeof rec.id === "string" ? rec.id : "";
    const name = typeof rec.name === "string" ? rec.name : "";
    const sourceRepo = typeof rec.source_repo === "string" ? rec.source_repo.trim() : "";
    if (!id || !name || !sourceRepo) continue;
    out.push({ id, name, source_repo: sourceRepo });
  }
  return out;
}
