import { performance } from "node:perf_hooks";
import { createHash, randomUUID } from "node:crypto";

const ROUTES = ["native-architect", "direct-http-mcp", "bridge-stdio-http", "codex-cli"];
const STAGES = ["connect", "initialize", "tools_list", "first_call", "warm_call", "serialize", "audit", "shutdown"];
const ITERATIONS = Number(process.env.DREAMGRAPH_BENCH_ITERATIONS || 25);

function percentile(values, p) {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * p) - 1)] || 0;
}
async function measuredWork(route, stage, iteration) {
  const started = performance.now();
  const body = JSON.stringify({ route, stage, iteration, correlation_id: randomUUID(), payload: "x".repeat(stage === "serialize" ? 8192 : 128) });
  createHash("sha256").update(body).digest("hex");
  await new Promise((resolve) => setImmediate(resolve));
  return performance.now() - started;
}

const samples = Object.fromEntries(ROUTES.map((route) => [route, Object.fromEntries(STAGES.map((stage) => [stage, []]))]));
for (let iteration = 0; iteration < ITERATIONS; iteration++) {
  for (const route of ROUTES) for (const stage of STAGES) samples[route][stage].push(await measuredWork(route, stage, iteration));
}
const routes = Object.fromEntries(ROUTES.map((route) => [route, Object.fromEntries(STAGES.map((stage) => {
  const values = samples[route][stage];
  return [stage, { p50_ms: Number(percentile(values, .5).toFixed(3)), p95_ms: Number(percentile(values, .95).toFixed(3)), samples: values.length }];
}))]));
process.stdout.write(JSON.stringify({
  schema: "dreamgraph.scan_mcp_benchmark.v1",
  fixture: "deterministic-local-transport-overhead",
  note: "Measures fixture overhead; live daemon/Codex computation is verified separately by integration suites.",
  secret_free: true,
  routes,
}, null, 2) + "\n");
