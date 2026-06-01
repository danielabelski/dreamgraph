import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { buildOnboardingReadinessProjection } from "../src/architect/onboarding-readiness.js";
import { buildArchitectRepoSetupProjection, persistArchitectRepoSetup, validateArchitectRepoSetupEntries } from "../src/architect/repo-setup.js";
import { sanitizeOnboardingTelemetryEvent } from "../src/architect/onboarding-telemetry.js";
import { handleArchitectRoute } from "../src/architect/routes.js";
import { config } from "../src/config/config.js";
import { handleDashboardRoute } from "../src/server/dashboard.js";
import * as lifecycle from "../src/instance/lifecycle.js";

const tempRoots: string[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function makeScope(graph?: { nodes: unknown[]; edges: unknown[] }) {
  const root = await mkdtemp(join(tmpdir(), "dreamgraph-onboarding-readiness-"));
  tempRoots.push(root);
  const dataDir = join(root, "data");
  const projectRoot = join(root, "project");
  await mkdir(dataDir, { recursive: true });
  await mkdir(projectRoot, { recursive: true });
  if (graph) await writeFile(join(dataDir, "dream_graph.json"), JSON.stringify(graph));
  return { uuid: "readiness-instance", name: "Readiness Test", dataDir, projectRoot, repos: { app: projectRoot } };
}

async function withServer(run: (baseUrl: string) => Promise<void>): Promise<void> {
  const server: Server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    if (await handleArchitectRoute(req, res, url.pathname)) return;
    if (await handleDashboardRoute(req, res, url.pathname)) return;
    res.statusCode = 404;
    res.end("not found");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address() as AddressInfo;
    await run(`http://127.0.0.1:${address.port}`);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
}

describe("daemon onboarding readiness projection", () => {
  it("keeps required checks separate from optional follow-up work", async () => {
    const scope = await makeScope();
    vi.spyOn(lifecycle, "getActiveScope").mockReturnValue(scope as never);

    const projection = buildOnboardingReadinessProjection({ adapter: "deterministic_fallback", provider: "none", model: "" });

    expect(projection.project_map.status).toBe("not_built");
    expect(projection.required_to_start.map((check) => check.id)).toContain("project_map");
    expect(projection.useful_later).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "recurring_review", status: "useful_later" }),
    ]));
    expect(projection.suggested_next_action).toMatchObject({ id: "build_project_map", kind: "run_governed_tool", target: "scan_project" });
  });

  it("reports a ready map and an Architect next action after required setup is complete", async () => {
    const scope = await makeScope({ nodes: [{ id: "feature" }], edges: [] });
    vi.spyOn(lifecycle, "getActiveScope").mockReturnValue(scope as never);

    const projection = buildOnboardingReadinessProjection({ adapter: "deterministic_fallback", provider: "none", model: "" });

    expect(projection.project_map.status).toBe("ready");
    expect(projection.required_to_start.every((check) => check.status === "ready")).toBe(true);
    expect(projection.suggested_next_action).toMatchObject({ id: "open_architect", target: "/architect" });
  });

  it("renders a plain-language Dashboard Start Here card with governed repair paths", async () => {
    const scope = await makeScope();
    vi.spyOn(lifecycle, "getActiveScope").mockReturnValue(scope as never);

    await withServer(async (baseUrl) => {
      const response = await fetch(`${baseUrl}/`);
      const html = await response.text();

      expect(response.status).toBe(200);
      expect(html).toContain("Start Here");
      expect(html).toContain("Recommended next action:");
      expect(html).toContain("Build project map");
      expect(html).toContain('href="/architect"');
      expect(html).toContain('href="/architect-guide"');
      expect(html).toContain('href="#setup-details"');
      expect(html).toContain("Required to start");
      expect(html).toContain("Useful later");
      for (const route of ["/status", "/schedules", "/config", "/docs", "/health"]) {
        expect(html).toContain(`href="${route}"`);
      }
      const guideResponse = await fetch(`${baseUrl}/architect-guide`);
      const guide = await guideResponse.text();
      expect(guideResponse.status).toBe(200);
      expect(guide).toContain("Architect For Dummies");
      expect(guide).toContain("Slash Commands");
      expect(guide).toContain("Code Editor Tab");
      expect(guide).toContain("Terminal Tab");
      expect(guide).toContain("DreamGraph MCP-authoritative");
    });
  });

  it("exposes the same readiness facts through Dashboard and Architect daemon routes", async () => {
    const scope = await makeScope({ nodes: [{ id: "feature" }], edges: [] });
    vi.spyOn(lifecycle, "getActiveScope").mockReturnValue(scope as never);

    await withServer(async (baseUrl) => {
      const dashboardResponse = await fetch(`${baseUrl}/health`, { headers: { Accept: "application/json" } });
      const architectResponse = await fetch(`${baseUrl}/api/architect/v1`);
      const dashboard = await dashboardResponse.json() as Record<string, unknown>;
      const architect = await architectResponse.json() as Record<string, unknown>;
      const dashboardReadiness = dashboard.onboarding_readiness as Record<string, unknown>;
      const architectReadiness = architect.onboarding_readiness as Record<string, unknown>;

      expect(dashboardReadiness.source).toBe("daemon_onboarding_readiness_projection");
      expect(architectReadiness).toMatchObject({
        project: dashboardReadiness.project,
        repositories: dashboardReadiness.repositories,
        project_map: dashboardReadiness.project_map,
        required_to_start: dashboardReadiness.required_to_start,
        useful_later: dashboardReadiness.useful_later,
        suggested_next_action: dashboardReadiness.suggested_next_action,
      });
    });
  });

  it("sanitizes local onboarding telemetry without retaining sensitive payload fields", () => {
    expect(sanitizeOnboardingTelemetryEvent({ event: "mission_completed", mission_id: "plan-feature", duration_ms: 42, prompt: "secret", source_content: "code", credential: "token", terminal_output: "raw" })).toEqual(expect.objectContaining({ event: "mission_completed", mission_id: "plan-feature", duration_ms: 42 }));
    const serialized = JSON.stringify(sanitizeOnboardingTelemetryEvent({ event: "provider_tested", category: "api_failure", prompt: "secret" }));
    expect(serialized).not.toContain("secret");
    expect(serialized).not.toContain("prompt");
  });

  it("rejects duplicate repository paths before guided setup persistence", async () => {
    const root = await mkdtemp(join(tmpdir(), "dreamgraph-repo-setup-duplicate-"));
    tempRoots.push(root);
    expect(() => validateArchitectRepoSetupEntries([
      { name: "app", path: root, role: "primary" },
      { name: "api", path: root, role: "backend" },
    ])).toThrow("duplicated");
  });

  it("persists a validated multi-repo setup and projects it into onboarding readiness", async () => {
    const root = await mkdtemp(join(tmpdir(), "dreamgraph-repo-setup-persist-"));
    tempRoots.push(root);
    const dataDir = join(root, "data");
    const configDir = join(root, "config");
    const appRoot = join(root, "app");
    const apiRoot = join(root, "api");
    await Promise.all([dataDir, configDir, appRoot, apiRoot].map((path) => mkdir(path, { recursive: true })));
    await writeFile(join(configDir, "mcp.json"), JSON.stringify({
      instance_uuid: "repo-setup-instance",
      server: { name: "dreamgraph", version: "test" },
      transport: "stdio",
      tools: { enabled: [], disabled: [], overrides: {} },
      discipline: { enabled: true, policy_profile: "strict", requires_ground_truth: true },
      data_dir: "./data",
      repos: { app: appRoot },
    }));
    const scope = { uuid: "repo-setup-instance", name: "Repo Setup", dataDir, configDir, projectRoot: appRoot, repos: { app: appRoot } };
    vi.spyOn(lifecycle, "getActiveScope").mockReturnValue(scope as never);
    const previousRepos = { ...config.repos };
    try {
      const projection = await persistArchitectRepoSetup([
        { name: "app", path: appRoot, role: "primary" },
        { name: "api", path: apiRoot, role: "backend" },
      ]);
      const persisted = JSON.parse(await readFile(join(configDir, "mcp.json"), "utf8")) as Record<string, unknown>;
      const readiness = buildOnboardingReadinessProjection({ adapter: "deterministic_fallback", provider: "none", model: "" });
      expect(projection).toMatchObject({ mode: "multi_repo", persisted: true, project_map: { status: "not_built" } });
      expect(projection.repositories).toEqual(expect.arrayContaining([
        expect.objectContaining({ name: "app", role: "primary" }),
        expect.objectContaining({ name: "api", role: "backend" }),
      ]));
      expect(persisted).toMatchObject({ repos: { app: appRoot, api: apiRoot }, repository_roles: { app: "primary", api: "backend" } });
      expect(scope.repos).toEqual({ app: appRoot, api: apiRoot });
      expect(readiness.repositories.names).toEqual(["api", "app"]);
      expect((await buildArchitectRepoSetupProjection()).first_map_action).toMatchObject({ target: "scan_project" });
    } finally {
      for (const key of Object.keys(config.repos)) delete config.repos[key];
      Object.assign(config.repos, previousRepos);
    }
  });
});
