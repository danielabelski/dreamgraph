#!/usr/bin/env node
// Generic MCP tool invoker against the daemon's /mcp endpoint with a long
// timeout, so long-running tool calls (dream_cycle, etc.) complete reliably
// without depending on the chat UI transport.
//
// Usage:
//   node scripts/mcp-call.mjs <tool_name> '<json_args>'
//   node scripts/mcp-call.mjs dream_cycle '{"max_dreams":50}'
//   node scripts/mcp-call.mjs cognitive_status '{}'
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const toolName = process.argv[2];
const argsJson = process.argv[3] ?? "{}";
if (!toolName) {
  console.error("usage: node scripts/mcp-call.mjs <tool_name> '<json_args>'");
  process.exit(2);
}
let args;
try { args = JSON.parse(argsJson); } catch (e) {
  console.error(`bad json args: ${e.message}`); process.exit(2);
}

const baseUrl = process.env.DREAMGRAPH_URL ?? "http://localhost:8010";
const transport = new StreamableHTTPClientTransport(new URL(`${baseUrl}/mcp`));
const client = new Client({ name: "mcp-call-cli", version: "1.0.0" }, { capabilities: {} });
await client.connect(transport);
console.log(`[cli] connected to ${baseUrl}/mcp`);
console.log(`[cli] calling ${toolName} ${JSON.stringify(args)}`);

const t0 = Date.now();
const result = await client.callTool(
  { name: toolName, arguments: args },
  undefined,
  { timeout: 30 * 60 * 1000 },
);
const dt = ((Date.now() - t0) / 1000).toFixed(1);
console.log(`[cli] completed in ${dt}s`);

const text = result?.content?.[0]?.text;
if (text) {
  try { console.log(JSON.stringify(JSON.parse(text), null, 2)); }
  catch { console.log(text); }
} else {
  console.log(JSON.stringify(result, null, 2));
}
await client.close();
process.exit(0);
