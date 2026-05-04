#!/usr/bin/env node
// Create stub feature entries for the dangling dream-edge targets surfaced by
// scripts/audit-orphans.mjs. Stubs allow incoming references to resolve until
// real entities are extracted/promoted.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const stubs = [
  ["feature_tool_registry", "Tool Registry", "MCP tool registration subsystem.", ["tools"]],
  ["feature_docs_export", "Docs Export", "Documentation export tooling.", ["docs"]],
  ["feature_federation", "Federation", "Multi-instance federation.", ["federation"]],
  ["feature_data_protection", "Data Protection", "Data-at-rest protection.", ["security"]],
  ["feature_discipline_system", "Discipline System", "Discipline planning/verification subsystem.", ["discipline"]],
  ["feature_dream_cycle", "Dream Cycle", "Cognitive dream cycle engine.", ["cognitive"]],
];

const entries = stubs.map(([id, name, desc, extraTags]) => ({
  id,
  name,
  description: `Stub created from dangling dream-edge reference. ${desc}`,
  tags: ["stub", ...extraTags],
  links: [],
}));

const baseUrl = process.env.DREAMGRAPH_URL ?? "http://localhost:8010";
const transport = new StreamableHTTPClientTransport(new URL(`${baseUrl}/mcp`));
const client = new Client({ name: "stub-cli", version: "1.0.0" }, { capabilities: {} });
await client.connect(transport);
console.log(`[cli] enriching ${entries.length} stub features`);
const result = await client.callTool(
  { name: "enrich_seed_data", arguments: { target: "features", mode: "merge", entries } },
  undefined,
  { timeout: 60_000 },
);
const text = result?.content?.[0]?.text;
console.log(text ?? JSON.stringify(result));
await client.close();
process.exit(0);
