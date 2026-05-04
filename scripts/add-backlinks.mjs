#!/usr/bin/env node
// Add bidirectional backlinks to fact-graph entities.
// For every entity X with a link to Y where Y has no reciprocal link to X,
// append a backlink entry on Y pointing to X.
//
// Reads live data dir, computes diff in memory, then submits per-target-type
// batches to enrich_seed_data (merge mode). Because merge replaces by id, we
// resubmit the full entity with augmented links array.
//
// Usage: node scripts/add-backlinks.mjs <dataDir>
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const dataDir = process.argv[2];
if (!dataDir) { console.error("usage: node add-backlinks.mjs <dataDir>"); process.exit(2); }

function loadJson(name, fallback) {
  try { return JSON.parse(readFileSync(join(dataDir, name), "utf8")); } catch { return fallback; }
}

const TYPE_BY_FILE = {
  feature: "features",
  workflow: "workflows",
  data_model: "data_model",
  capability: "capabilities",
};

const collections = {
  feature: loadJson("features.json", []),
  workflow: loadJson("workflows.json", []),
  data_model: loadJson("data_model.json", []),
  capability: loadJson("capabilities.json", []),
};

// Build id -> {type, entity}
const byId = new Map();
for (const [type, list] of Object.entries(collections)) {
  for (const e of list) if (e?.id) byId.set(e.id, { type, entity: e });
}

// Existing edge set "from|to"
const edges = new Set();
for (const [, list] of Object.entries(collections)) {
  for (const e of list) for (const l of e?.links ?? []) {
    if (l?.target) edges.add(`${e.id}|${l.target}`);
  }
}

// Compute backlinks needed
const additions = new Map(); // targetId -> array of {sourceId, relationship}
let considered = 0, skippedExternal = 0;
for (const [, list] of Object.entries(collections)) {
  for (const e of list) {
    if (!e?.id) continue;
    for (const l of e?.links ?? []) {
      if (!l?.target) continue;
      considered++;
      const targetEntry = byId.get(l.target);
      if (!targetEntry) { skippedExternal++; continue; } // dangling or dream node — skip
      const reciprocal = `${l.target}|${e.id}`;
      if (edges.has(reciprocal)) continue; // already bidirectional
      if (!additions.has(l.target)) additions.set(l.target, []);
      additions.get(l.target).push({
        sourceId: e.id,
        relationship: invertRelationship(l.relationship ?? "relates_to"),
      });
      // Mark so we don't double-add when processing the reverse pair later
      edges.add(reciprocal);
    }
  }
}

function invertRelationship(rel) {
  const map = {
    depends_on: "supports",
    supports: "depends_on",
    implements: "implemented_by",
    implemented_by: "implements",
    contains: "part_of",
    part_of: "contains",
    produces: "produced_by",
    produced_by: "produces",
    consumes: "consumed_by",
    consumed_by: "consumes",
    triggers: "triggered_by",
    triggered_by: "triggers",
  };
  return map[rel] ?? "related_to";
}

console.log(`considered ${considered} forward links, skipped ${skippedExternal} (external/dangling targets)`);
console.log(`entities needing backlinks: ${additions.size}`);

if (additions.size === 0) {
  console.log("nothing to do");
  process.exit(0);
}

// Group updates by target type and build augmented entries
const batches = { feature: [], workflow: [], data_model: [], capability: [] };
for (const [targetId, news] of additions) {
  const meta = byId.get(targetId);
  if (!meta) continue;
  const updated = JSON.parse(JSON.stringify(meta.entity));
  if (!Array.isArray(updated.links)) updated.links = [];
  for (const n of news) {
    updated.links.push({
      target: n.sourceId,
      relationship: n.relationship,
      description: "auto-backlink",
      strength: "moderate",
    });
  }
  batches[meta.type].push(updated);
}

const baseUrl = process.env.DREAMGRAPH_URL ?? "http://localhost:8010";
const transport = new StreamableHTTPClientTransport(new URL(`${baseUrl}/mcp`));
const client = new Client({ name: "backlink-cli", version: "1.0.0" }, { capabilities: {} });
await client.connect(transport);
console.log(`[cli] connected to ${baseUrl}/mcp`);

for (const [type, entries] of Object.entries(batches)) {
  if (entries.length === 0) continue;
  const target = TYPE_BY_FILE[type];
  console.log(`[cli] enriching ${entries.length} ${target} entries with backlinks`);
  const result = await client.callTool(
    { name: "enrich_seed_data", arguments: { target, mode: "merge", entries } },
    undefined,
    { timeout: 5 * 60_000 },
  );
  const text = result?.content?.[0]?.text;
  console.log(text ?? JSON.stringify(result));
}

await client.close();
process.exit(0);
