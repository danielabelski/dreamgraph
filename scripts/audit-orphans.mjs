#!/usr/bin/env node
// Audit orphan rate per entity type in the live data dir.
// Usage: node scripts/audit-orphans.mjs <dataDir>
import { readFileSync } from "node:fs";
import { join } from "node:path";

const dataDir = process.argv[2];
if (!dataDir) {
  console.error("usage: node audit-orphans.mjs <dataDir>");
  process.exit(2);
}

function loadJson(name, fallback) {
  try {
    return JSON.parse(readFileSync(join(dataDir, name), "utf8"));
  } catch {
    return fallback;
  }
}

const features = loadJson("features.json", []);
const workflows = loadJson("workflows.json", []);
const dataModel = loadJson("data_model.json", []);
const capabilities = loadJson("capabilities.json", []);
const datastores = loadJson("datastores.json", []);
const dreamGraph = loadJson("dream_graph.json", { nodes: [], edges: [] });
const validatedRaw = loadJson("validated_edges.json", { edges: [] });
const validated = validatedRaw.edges ?? validatedRaw ?? [];
const candidatesRaw = loadJson("candidate_edges.json", { results: [] });
const candidates = candidatesRaw.results ?? candidatesRaw ?? [];
const tensions = loadJson("tension_log.json", { signals: [] });

// Build full id set + per-entity outgoing-link map
const allIds = new Set();
const incoming = new Map();
const outgoing = new Map();

function addNode(id) {
  if (!id) return;
  allIds.add(id);
  if (!incoming.has(id)) incoming.set(id, 0);
  if (!outgoing.has(id)) outgoing.set(id, 0);
}
function addEdge(s, t) {
  if (!s || !t) return;
  outgoing.set(s, (outgoing.get(s) ?? 0) + 1);
  incoming.set(t, (incoming.get(t) ?? 0) + 1);
}

const groups = [
  ["feature", features],
  ["workflow", workflows],
  ["data_model", dataModel],
  ["capability", capabilities],
  ["datastore", datastores ?? []],
];

for (const [, list] of groups) for (const e of list) addNode(e?.id);
for (const dn of dreamGraph.nodes ?? []) addNode(dn?.id);
for (const sig of tensions.signals ?? []) addNode(sig?.id);

// Fact-graph internal links
for (const [, list] of groups) {
  for (const e of list) {
    if (!e?.id) continue;
    for (const link of e.links ?? []) {
      if (link?.target) addEdge(e.id, link.target);
    }
  }
}
// Dream graph edges
for (const de of dreamGraph.edges ?? []) addEdge(de?.from, de?.to);
// Validated/candidate edges
for (const e of validated) addEdge(e?.from, e?.to);
for (const c of candidates) {
  const r = c?.refines_edge ?? c;
  addEdge(r?.from, r?.to);
}
// Tension implicit edges
for (const sig of tensions.signals ?? []) {
  for (const ent of sig?.entities ?? []) addEdge(sig.id, ent);
}

console.log(`total nodes registered: ${allIds.size}`);
console.log(`fact-graph entities loaded: features=${features.length} workflows=${workflows.length} data_model=${dataModel.length} capabilities=${capabilities.length} datastores=${(datastores ?? []).length}`);
console.log(`dream nodes: ${(dreamGraph.nodes ?? []).length}`);
console.log(`tension signals: ${(tensions.signals ?? []).length}`);
console.log("");

for (const [type, list] of groups) {
  const total = list.length;
  let orphan = 0, sourceOnly = 0, sinkOnly = 0, hasLinksField = 0, emptyLinks = 0;
  const examples = [];
  for (const e of list) {
    if (!e?.id) continue;
    const inn = incoming.get(e.id) ?? 0;
    const out = outgoing.get(e.id) ?? 0;
    if (Array.isArray(e.links)) hasLinksField++;
    if (Array.isArray(e.links) && e.links.length === 0) emptyLinks++;
    if (inn === 0 && out === 0) {
      orphan++;
      if (examples.length < 5) examples.push({ id: e.id, name: e.name, links: e.links?.length ?? "no field" });
    } else if (out > 0 && inn === 0) sourceOnly++;
    else if (inn > 0 && out === 0) sinkOnly++;
  }
  console.log(`[${type}] total=${total} orphan(0,0)=${orphan} source-only(out,0)=${sourceOnly} sink-only(0,in)=${sinkOnly}`);
  console.log(`   has 'links' field: ${hasLinksField}/${total}, empty links: ${emptyLinks}`);
  if (examples.length) {
    console.log("   orphan examples:");
    for (const ex of examples) console.log(`     - ${ex.id} "${ex.name}" links=${ex.links}`);
  }
  console.log("");
}

// Inbound-only check: do other entities link TO these orphans?
console.log("--- targets referenced by links but not present as nodes ---");
const referenced = new Set();
for (const [, list] of groups) {
  for (const e of list) for (const l of e?.links ?? []) if (l?.target) referenced.add(l.target);
}
for (const de of dreamGraph.edges ?? []) { if (de?.from) referenced.add(de.from); if (de?.to) referenced.add(de.to); }
let dangling = 0;
const danglingExamples = [];
for (const t of referenced) {
  if (!allIds.has(t)) { dangling++; if (danglingExamples.length < 10) danglingExamples.push(t); }
}
console.log(`dangling link targets (referenced but no node): ${dangling}`);
for (const d of danglingExamples) console.log(`   - ${d}`);
