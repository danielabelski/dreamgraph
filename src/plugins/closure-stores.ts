/**
 * M6 closure — host-side stores for the policies / archetypes /
 * markdown_fences seams (§§4.6, 4.8, 4.9).
 *
 * Policies are journaled to disk because they participate in the
 * eventual discipline-manifest merge model. Archetypes and markdown
 * fences are kept in process memory: they are reconstituted from plugin
 * activations and discarded on plugin unload, so on-disk state would
 * only encode stale provenance.
 */
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import type {
  ArchetypeProviderDefinition,
  MarkdownFenceDefinition,
  PolicyProposal,
} from "@dreamgraph/sdk";
import { atomicWriteFile } from "../utils/atomic-write.js";
import { withFileLock } from "../utils/mutex.js";
import { dataPath } from "../utils/paths.js";
import { logger } from "../utils/logger.js";

/* ------------------------------------------------------------------ */
/*  §4.6 — plugin policy proposals (journal)                          */
/* ------------------------------------------------------------------ */

export interface StoredPolicyProposal extends PolicyProposal {
  /** Globally unique id: `<plugin-id>:<proposal.id>`. */
  proposal_id: string;
  source: string;
  proposed_at: string;
  status: "proposed" | "merged" | "withdrawn";
}

export interface PolicyProposalsFile {
  proposals: StoredPolicyProposal[];
}

const policyPath = () => dataPath("plugin_policy_proposals.json");

async function loadPolicies(): Promise<PolicyProposalsFile> {
  if (!existsSync(policyPath())) return { proposals: [] };
  try {
    const raw = await readFile(policyPath(), "utf-8");
    const parsed = JSON.parse(raw);
    return {
      proposals: Array.isArray(parsed.proposals) ? parsed.proposals : [],
    };
  } catch {
    return { proposals: [] };
  }
}

async function savePolicies(file: PolicyProposalsFile): Promise<void> {
  await atomicWriteFile(policyPath(), JSON.stringify(file, null, 2));
}

/**
 * Append or update a plugin policy proposal. Uniqueness is by
 * `proposal_id = "<plugin-id>:<proposal.id>"`.
 */
export async function applyPluginPolicyProposal(
  pluginId: string,
  proposal: PolicyProposal,
): Promise<{ stored: StoredPolicyProposal; replaced: boolean }> {
  const proposal_id = `${pluginId}:${proposal.id}`;
  const stored: StoredPolicyProposal = {
    ...proposal,
    proposal_id,
    source: `plugin:${pluginId}`,
    proposed_at: new Date().toISOString(),
    status: "proposed",
  };
  return withFileLock("plugin_policy_proposals.json", async () => {
    const file = await loadPolicies();
    const idx = file.proposals.findIndex((p) => p.proposal_id === proposal_id);
    let replaced = false;
    if (idx >= 0) {
      file.proposals[idx] = stored;
      replaced = true;
    } else {
      file.proposals.push(stored);
    }
    await savePolicies(file);
    return { stored, replaced };
  });
}

/** Remove all proposals owned by a plugin. Used on unload. */
export async function removePluginPolicyProposals(
  pluginId: string,
): Promise<{ removed: number }> {
  const source = `plugin:${pluginId}`;
  return withFileLock("plugin_policy_proposals.json", async () => {
    const file = await loadPolicies();
    const before = file.proposals.length;
    file.proposals = file.proposals.filter((p) => p.source !== source);
    const removed = before - file.proposals.length;
    if (removed > 0) await savePolicies(file);
    return { removed };
  });
}

/* ------------------------------------------------------------------ */
/*  §4.8 — archetype providers (in-memory)                            */
/* ------------------------------------------------------------------ */

export interface RegisteredArchetypeProvider {
  plugin_id: string;
  /** `<plugin-id>:<definition.id>` */
  provider_id: string;
  definition: ArchetypeProviderDefinition;
  registered_at: string;
}

const _archetypeProviders = new Map<string, RegisteredArchetypeProvider>();

export function applyPluginArchetypeProvider(
  pluginId: string,
  definition: ArchetypeProviderDefinition,
): { provider_id: string; replaced: boolean } {
  const provider_id = `${pluginId}:${definition.id}`;
  const replaced = _archetypeProviders.has(provider_id);
  _archetypeProviders.set(provider_id, {
    plugin_id: pluginId,
    provider_id,
    definition,
    registered_at: new Date().toISOString(),
  });
  return { provider_id, replaced };
}

export function removePluginArchetypeProviders(pluginId: string): { removed: number } {
  let removed = 0;
  for (const [key, p] of _archetypeProviders) {
    if (p.plugin_id === pluginId) {
      _archetypeProviders.delete(key);
      removed += 1;
    }
  }
  return { removed };
}

export function listArchetypeProviders(): readonly RegisteredArchetypeProvider[] {
  return Array.from(_archetypeProviders.values());
}

/* ------------------------------------------------------------------ */
/*  §4.9 — markdown fences (in-memory, manifest-only stub)            */
/* ------------------------------------------------------------------ */

export interface RegisteredMarkdownFence {
  plugin_id: string;
  language: string;
  definition: MarkdownFenceDefinition;
  registered_at: string;
}

const _markdownFences = new Map<string, RegisteredMarkdownFence>();

export type ApplyMarkdownFenceResult =
  | { ok: true; replaced: boolean }
  | { ok: false; reason: "language_collision"; owner: string };

export function applyPluginMarkdownFence(
  pluginId: string,
  definition: MarkdownFenceDefinition,
): ApplyMarkdownFenceResult {
  const existing = _markdownFences.get(definition.language);
  if (existing && existing.plugin_id !== pluginId) {
    return { ok: false, reason: "language_collision", owner: existing.plugin_id };
  }
  const replaced = !!existing;
  _markdownFences.set(definition.language, {
    plugin_id: pluginId,
    language: definition.language,
    definition,
    registered_at: new Date().toISOString(),
  });
  return { ok: true, replaced };
}

export function removePluginMarkdownFences(pluginId: string): { removed: number } {
  let removed = 0;
  for (const [lang, f] of _markdownFences) {
    if (f.plugin_id === pluginId) {
      _markdownFences.delete(lang);
      removed += 1;
    }
  }
  return { removed };
}

export function listMarkdownFences(): readonly RegisteredMarkdownFence[] {
  return Array.from(_markdownFences.values());
}

/* ------------------------------------------------------------------ */
/*  Test helper                                                        */
/* ------------------------------------------------------------------ */

/** @internal — clears in-memory archetype + fence registries. */
export function _resetClosureStoresForTest(): void {
  _archetypeProviders.clear();
  _markdownFences.clear();
  void logger; // keep import in case future logging is added
}
