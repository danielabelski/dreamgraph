#!/usr/bin/env node
// Drain remaining orphan entities through the daemon's MCP /mcp endpoint
// without relying on the chat UI's transport (which appears to drop long
// responses). Uses the MCP SDK client with a generous request timeout.
//
// Usage:
//   node scripts/wire-links-cli.mjs [scope] [limit]
//   node scripts/wire-links-cli.mjs feature 100
//   node scripts/wire-links-cli.mjs workflow 100
//   node scripts/wire-links-cli.mjs data_model 100
//   node scripts/wire-links-cli.mjs all 200
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const scopeArg = process.argv[2] ?? "all";
const limit = Number(process.argv[3] ?? "100");
const baseUrl = process.env.DREAMGRAPH_URL ?? "http://localhost:8010";

const scope =
  scopeArg === "all"
    ? ["feature", "workflow", "data_model", "capability"]
    : [scopeArg];

const transport = new StreamableHTTPClientTransport(new URL(`${baseUrl}/mcp`));
const client = new Client({ name: "wire-links-cli", version: "1.0.0" }, { capabilities: {} });

await client.connect(transport);
console.log(`[cli] connected to ${baseUrl}/mcp`);
console.log(`[cli] calling wire_links scope=[${scope.join(",")}] limit=${limit}`);

const t0 = Date.now();
const result = await client.callTool(
  { name: "wire_links", arguments: { scope, limit, candidate_top_k: 30, dry_run: false } },
  undefined,
  { timeout: 30 * 60 * 1000 }, // 30 min
);
const dt = ((Date.now() - t0) / 1000).toFixed(1);
console.log(`[cli] completed in ${dt}s`);

const text = result?.content?.[0]?.text;
if (text) {
  try {
    console.log(JSON.stringify(JSON.parse(text), null, 2));
  } catch {
    console.log(text);
  }
} else {
  console.log(JSON.stringify(result, null, 2));
}

await client.close();
process.exit(0);
