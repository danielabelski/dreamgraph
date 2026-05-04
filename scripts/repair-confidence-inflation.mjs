/**
 * repair-confidence-inflation.mjs
 *
 * One-shot data migration to clean up edges/nodes whose confidence was
 * inflated by the pre-fix reinforcement loop.
 *
 * Background: prior to the fix in src/cognitive/engine.ts:
 *   - deduplicateAndAppendEdges reinforced *every* matching candidate by
 *     +0.3 * confidence, including edges already marked status="rejected".
 *   - Deterministic strategies (symmetry_completion, gap_detection, etc.)
 *     re-derived the same edges every cycle, so confidence saturated at
 *     1.0 even for rejected hypotheses.
 *
 * This script:
 *   - Re-clamps every edge with status="rejected" to
 *       confidence = min(0.4, current * 0.5)
 *     and divides reinforcement_count by 4 (rounded down).
 *   - Applies the same treatment to nodes.
 *   - Leaves validated / latent / candidate edges untouched.
 *   - Writes a backup beside the file before saving.
 *
 * Usage:
 *   node scripts/repair-confidence-inflation.mjs <path-to-instance-data-dir>
 *
 * Example:
 *   node scripts/repair-confidence-inflation.mjs "$env:USERPROFILE/.dreamgraph/<uuid>/data"
 *
 * Pass --dry-run to preview without writing.
 */

import { readFileSync, writeFileSync, existsSync, copyFileSync } from "fs";
import { join } from "path";

const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
const dataDir = args.find(a => !a.startsWith("--"));

if (!dataDir) {
  console.error("Usage: node scripts/repair-confidence-inflation.mjs <data-dir> [--dry-run]");
  process.exit(2);
}

const graphPath = join(dataDir, "dream_graph.json");
if (!existsSync(graphPath)) {
  console.error(`dream_graph.json not found at: ${graphPath}`);
  process.exit(2);
}

const raw = readFileSync(graphPath, "utf-8");
const graph = JSON.parse(raw);

let edgeRepaired = 0;
let nodeRepaired = 0;
const round2 = (n) => Math.round(n * 100) / 100;

for (const edge of graph.edges ?? []) {
  if (edge.status !== "rejected") continue;
  const before = { conf: edge.confidence, reinf: edge.reinforcement_count ?? 0 };
  edge.confidence = round2(Math.min(0.4, (edge.confidence ?? 0) * 0.5));
  edge.reinforcement_count = Math.floor((edge.reinforcement_count ?? 0) / 4);
  // Pull TTL down so the next decay pass can drop hopeless edges quickly.
  if (typeof edge.ttl === "number") {
    edge.ttl = Math.min(edge.ttl, 4);
  }
  edgeRepaired++;
  if (edgeRepaired <= 5) {
    console.log(`  edge ${edge.id}: conf ${before.conf} -> ${edge.confidence}, reinf ${before.reinf} -> ${edge.reinforcement_count}`);
  }
}

for (const node of graph.nodes ?? []) {
  if (node.status !== "rejected") continue;
  node.confidence = round2(Math.min(0.4, (node.confidence ?? 0) * 0.5));
  node.reinforcement_count = Math.floor((node.reinforcement_count ?? 0) / 4);
  if (typeof node.ttl === "number") node.ttl = Math.min(node.ttl, 4);
  nodeRepaired++;
}

console.log(`\nRepaired: ${edgeRepaired} edges, ${nodeRepaired} nodes (rejected only).`);

if (dryRun) {
  console.log("--dry-run: not writing.");
  process.exit(0);
}

const backup = graphPath + `.bak-${Date.now()}`;
copyFileSync(graphPath, backup);
writeFileSync(graphPath, JSON.stringify(graph, null, 2), "utf-8");
console.log(`Wrote: ${graphPath}`);
console.log(`Backup: ${backup}`);
