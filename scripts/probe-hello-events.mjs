import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
const t = new StreamableHTTPClientTransport(new URL("http://127.0.0.1:8010/mcp"));
const c = new Client({ name: "probe", version: "0.0.1" }, { capabilities: {} });
await c.connect(t);
const tools = await c.listTools();
const greet = tools.tools.find(x => x.name === "examples.hello-events.greet");
console.log("greet tool present:", !!greet);
if (greet) console.log(JSON.stringify(greet, null, 2));
const res = await c.listResources();
const man = res.resources.find(x => x.uri === "plugin://examples.hello-events/manifest");
console.log("manifest resource present:", !!man);
if (greet) {
  const out = await c.callTool({ name: "examples.hello-events.greet", arguments: { who: "world" } });
  console.log("call result:", JSON.stringify(out, null, 2));
}
if (man) {
  const out = await c.readResource({ uri: "plugin://examples.hello-events/manifest" });
  console.log("resource read:", JSON.stringify(out, null, 2));
}
await c.close();
