import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import type { PluginManifest } from "../../packages/sdk/src/manifest.js";
import { _resetArchitectContributionsForTest, registerArchitectTab } from "../../src/plugins/architect-contributions.js";
import { handleArchitectRoute } from "../../src/architect/routes.js";

const manifest = {
  id: "examples.action-checklist", version: "1.0.0", displayName: "Action Checklist", engine: { dreamgraph: ">=10.0.0" }, main: "index.js", intent: "test",
  capabilities: ["architect:register_tab", "architect:read_plan", "architect:write_plan_state", "architect:register_sidebar_summary"],
  expectedEffects: ["render_architect_tab", "read_architect_plan_projection", "write_architect_plan_state", "render_architect_sidebar_summary"], forbiddenEffects: [],
  architectTabs: [{ id: "examples.action-checklist.checklist", renderer: "checklist", planConnectivity: "required" }], tools: [], resources: [], ui: [], policies: [], archetypeProviders: [], markdownFences: [], policy: { phasePermissions: [], writableFiles: [] },
} satisfies PluginManifest;

async function withServer(run: (baseUrl: string) => Promise<void>) {
  const server: Server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    if (!await handleArchitectRoute(req, res, url.pathname)) { res.statusCode = 404; res.end(); }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try { await run(`http://127.0.0.1:${(server.address() as AddressInfo).port}`); }
  finally { await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())); }
}

afterEach(() => _resetArchitectContributionsForTest());

describe("Architect plugin tab routes", () => {
  it("projects descriptors, explicit-plan snapshots, and schema-validated actions", async () => {
    registerArchitectTab(manifest, {
      id: "examples.action-checklist.checklist", title: "Action Checklist", renderer: "checklist", planConnectivity: "required", stateSchema: { type: "object" },
      actions: [{ id: "toggle", inputSchema: { type: "object", required: ["type", "itemId"], properties: { type: { type: "string" }, itemId: { type: "string" } } } }],
      loadState: ({ planId }) => ({ planId, items: [] }), handleAction: (action) => ({ action }),
    });
    await withServer(async (baseUrl) => {
      const index = await (await fetch(`${baseUrl}/api/architect/v1/plugin-tabs`)).json();
      expect(index.tabs).toEqual([expect.objectContaining({ title: "Action Checklist" })]);
      expect(JSON.stringify(index)).not.toMatch(/state-store|architect_plugin_plan_state|\\\\|[A-Z]:\\/);
      expect((await fetch(`${baseUrl}/api/architect/v1/plugin-tabs/examples.action-checklist.checklist/snapshot`)).status).toBe(400);
      expect((await fetch(`${baseUrl}/api/architect/v1/plugin-tabs/examples.action-checklist.checklist/snapshot?planId=living-dreamgraph`)).status).toBe(200);
      expect((await fetch(`${baseUrl}/api/architect/v1/plugin-tabs/examples.action-checklist.checklist/actions`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ planId: "living-dreamgraph", action: { type: "toggle" } }) })).status).toBe(400);
      expect((await fetch(`${baseUrl}/api/architect/v1/plugin-tabs/examples.action-checklist.checklist/actions`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ planId: "living-dreamgraph", action: { type: "toggle", itemId: "slice-d" } }) })).status).toBe(200);
    });
  });
});
