import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { Script } from "node:vm";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

import { config } from "../src/config/config.js";
import {
  createArchitectCliBridgeSpawnPlan,
  createArchitectCodexConfigToml,
  createArchitectCopilotPromptFileDirective,
  resolveArchitectCliBridgeExecutablePath,
  resolveArchitectCliBridgeToolNames,
} from "../src/architect/cli-bridge.js";
import {
  formatArchitectPlanListPayload,
  formatArchitectPlanNextPayload,
  formatArchitectPlanStatusPayload,
  formatArchitectPluginInspectPayload,
  formatArchitectPluginListPayload,
  formatArchitectStatusPayload,
  buildArchitectProviderReadiness,
  handleArchitectRoute,
} from "../src/architect/routes.js";
import * as lifecycle from "../src/instance/lifecycle.js";

async function withArchitectServer<T>(run: (baseUrl: string) => Promise<T>): Promise<T> {
  let server: Server | undefined;
  server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    const handled = await handleArchitectRoute(req, res, url.pathname);
    if (!handled) {
      res.statusCode = 404;
      res.end("not found");
    }
  });

  await new Promise<void>((resolve) => {
    server!.listen(0, "127.0.0.1", resolve);
  });

  try {
    const address = server.address() as AddressInfo;
    return await run(`http://127.0.0.1:${address.port}`);
  } finally {
    await new Promise<void>((resolve, reject) => {
      server!.close((error) => error ? reject(error) : resolve());
    });
  }
}

async function expectJsonOk(response: Response): Promise<Record<string, unknown>> {
  expect(response.status).toBe(200);
  return await response.json() as Record<string, unknown>;
}

describe("standalone Architect route hardening", () => {
  it("advertises bridge-local run_command during CLI MCP preflight", () => {
    expect(resolveArchitectCliBridgeToolNames(["query_resource", "read_source_code", "search_source_code"])).toEqual([
      "query_resource",
      "read_source_code",
      "search_source_code",
      "run_command",
    ]);
    expect(resolveArchitectCliBridgeToolNames(["query_resource", "run_command"])).toEqual([
      "query_resource",
      "run_command",
    ]);
  });

  it("serializes Codex MCP config with TOML-safe dynamic keys", () => {
    const content = createArchitectCodexConfigToml({
      bridgeCommand: "node",
      bridgeArgs: ["./cli-mcp-bridge.js"],
      env: {
        "=C:": "C:\\Users\\Mika",
        "CommonProgramFiles(x86)": "C:\\Program Files (x86)\\Common Files",
        DREAMGRAPH_RUN_ID: "run-1",
      },
      tools: ["run_command", "query.resource"],
    });

    expect(content).toContain('"=C:" = "C:\\\\Users\\\\Mika"');
    expect(content).toContain('"CommonProgramFiles(x86)" = "C:\\\\Program Files (x86)\\\\Common Files"');
    expect(content).toContain("[mcp_servers.dreamgraph.tools.run_command]");
    expect(content).toContain('[mcp_servers.dreamgraph.tools."query.resource"]');
  });

  it("builds a single-line Copilot prompt-file directive for Windows command shims", () => {
    const directive = createArchitectCopilotPromptFileDirective("C:\\Temp\\dreamgraph-architect-copilot-cli\\prompt.md");

    expect(directive).toContain("prompt.md");
    expect(directive).toContain("DreamGraph MCP");
    expect(directive).not.toMatch(/[\r\n]/);
  });

  it("resolves Windows CLI shims and wraps them before spawning", async () => {
    if (process.platform !== "win32") {
      expect(createArchitectCliBridgeSpawnPlan("/usr/local/bin/codex", ["--version"])).toEqual({
        command: "/usr/local/bin/codex",
        args: ["--version"],
      });
      return;
    }

    const tempRoot = await mkdtemp(join(tmpdir(), "dreamgraph-architect-cli-shim-"));
    try {
      await writeFile(join(tempRoot, "codex"), "");
      await writeFile(join(tempRoot, "codex.cmd"), "@echo off\r\n");
      const env = {
        ...process.env,
        PATH: tempRoot,
        Path: tempRoot,
        PATHEXT: ".COM;.EXE;.BAT;.CMD",
      };

      const resolved = await resolveArchitectCliBridgeExecutablePath("codex", env);
      expect(resolved?.toLowerCase()).toBe(join(tempRoot, "codex.cmd").toLowerCase());

      const spawnPlan = createArchitectCliBridgeSpawnPlan(resolved!, ["exec", "--json", "-"]);
      expect(spawnPlan.command).toBe("cmd.exe");
      expect(spawnPlan.windowsVerbatimArguments).toBe(true);
      expect(spawnPlan.args.slice(0, 3)).toEqual(["/d", "/s", "/c"]);
      expect(spawnPlan.args[3]).toContain("codex.cmd");
      expect(spawnPlan.args[3]).toContain("--json");
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  it("serves an executable browser bootstrap script for runtime binding", async () => {
    await withArchitectServer(async (baseUrl) => {
      const response = await fetch(`${baseUrl}/architect`);
      expect(response.status).toBe(200);
      const html = await response.text();
      const script = html.match(/<script>([\s\S]*?)<\/script>/)?.[1];

      expect(script).toBeTruthy();
      expect(() => new Script(script!, { filename: "architect-shell.js" })).not.toThrow();
      expect(script).toContain("function collapseWhitespace");
      expect(script).toContain("function isArchitectWhitespace");
      expect(script).toContain("function splitArchitectWords");
      expect(script).toContain("function describeStructuredToolResult");
      expect(script).toContain("lines.join(String.fromCharCode(10))");
      expect(script).not.toContain("replace(/s+/g");
      expect(script).not.toContain("JSON.stringify(parsed.value, null, 2)");
      expect(html).toContain("Project scope loading...");
      expect(html).toContain("id=\"architect-pulse-strip\"");
      expect(html).toContain("architect.pulse");
      expect(html).toContain("id=\"living-plan-summary\"");
      expect(html).toContain("id=\"living-plan-question-list\"");
      expect(html).toContain("id=\"living-plan-nervous-point-list\"");
      expect(html).toContain("Projected from the selected plan's Open Questions section.");
      expect(html).toContain("renderList(livingPlanQuestionListEl, livingState.open_questions || []");
      expect(html).toContain("renderList(livingPlanNervousPointListEl, livingState.nervous_points || []");
      expect(html).toContain("Living Plan");
      expect(html).not.toContain("Plan Organ" + "ism");
      expect(html).not.toContain("Instance binding loading...");
      expect(html).not.toContain("<h1>Architect</h1>");
      expect(html).not.toContain(">Architect Chat<");
      expect(html).toContain("height: 100vh;");
      expect(html).toContain("overflow: hidden;");
      expect(html).toContain("Connect repositories");
      expect(html).toContain("Add related repo");
      expect(html).toContain("Save repositories");
      expect(html).toContain("Build first project map");
      expect(html).toContain("How should Architect answer?");
      expect(html).toContain("Advanced runtime controls");
      expect(html).toContain("Test setup");
      expect(html).toContain('id="architect-provider-dismiss"');
      expect(html).toContain('id="architect-provider-suppress"');
      expect(html).toContain("Do not show this setup box again");
      expect(html).toContain('id="architect-provider-show"');
      expect(html).toContain("grid-template-rows: auto auto auto auto minmax(0, 1fr);");
      expect(html).toContain("grid-row: -2 / -1;");
      expect(html).toContain("grid-template-rows: minmax(0, 1fr) minmax(0, auto) auto;");
      expect(html).toContain("max-height: min(58vh, 520px);");
      expect(script).toContain("function appendArchitectRepoRow");
      expect(script).toContain("function isArchitectProviderSetupSuppressed");
      expect(script).toContain("function setArchitectProviderSetupVisible");
      expect(script).toContain("if (readiness.ready) setArchitectProviderSetupVisible(false, true);");
      expect(script).toContain("architect.provider.setup.suppressed.v1");
      expect(script).toContain("function testArchitectProviderReadiness");
      expect(script).toContain("function renderArchitectRecipes");
      expect(script).toContain("function recordArchitectOnboardingEvent");
      expect(script).toContain("second_session_return");
      expect(html).toContain("Start from a recipe");
      expect(html).toContain('href="/architect-guide"');
      expect(html).toContain("Artifact: ");
      expect(html).toContain("Verify: ");
      expect(script).toContain("Prototype or small app");
      expect(script).toContain("Multi-repo system");
      expect(script).toContain("/api/architect/v1/repo-setup");
    });
  });

  it("serves the Architect pulse projection contract", async () => {
    await withArchitectServer(async (baseUrl) => {
      const contract = await expectJsonOk(await fetch(`${baseUrl}/api/architect/v1`));
      const routes = contract.routes as Record<string, string>;
      expect(routes.pulse).toBe("GET /api/architect/v1/pulse");
      expect(routes.desires).toBe("GET /api/architect/v1/desires");
      expect(routes.dream_playback).toBe("GET /api/architect/v1/dreams/recent/playback");
      expect(routes.tension_clusters).toBe("GET /api/architect/v1/tensions/clusters");

      const payload = await expectJsonOk(await fetch(`${baseUrl}/api/architect/v1/pulse`));
      const pulse = payload.pulse as Record<string, unknown>;
      expect(typeof pulse.pulse_hash).toBe("string");
      expect(pulse.authority_boundary).toMatchObject({
        repository_authority: "dreamgraph_mcp",
        mutation_mode: "governed_tools_only",
        direct_filesystem_claims: false,
      });
      expect(pulse.weather).toHaveProperty("kind");
      expect(pulse.cognitive).toHaveProperty("unresolved_tensions");

      const desires = await expectJsonOk(await fetch(`${baseUrl}/api/architect/v1/desires`));
      expect(desires.ledger).toMatchObject({ source: "daemon_governed_projection", mutation_controls_enabled: false });

      const playback = await expectJsonOk(await fetch(`${baseUrl}/api/architect/v1/dreams/recent/playback`));
      expect(playback.playback).toHaveProperty("source", "existing_cognitive_store_projection");

      const clusters = await expectJsonOk(await fetch(`${baseUrl}/api/architect/v1/tensions/clusters`));
      expect(Array.isArray(clusters.clusters)).toBe(true);
    });
  });

  it("stores temporary Architect image attachments under the bound instance runtime directory", async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), "dreamgraph-architect-attachment-"));
    const projectRoot = join(tempRoot, "project");
    const runtimeDir = join(tempRoot, "instance", "runtime");
    const scopeSpy = vi.spyOn(lifecycle, "getActiveScope").mockReturnValue({
      uuid: "standalone-architect-attachment-test",
      projectRoot,
      runtimeDir,
    } as never);

    try {
      await mkdir(projectRoot, { recursive: true });
      await withArchitectServer(async (baseUrl) => {
        const response = await fetch(`${baseUrl}/api/architect/v1/attachments`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            name: "clipboard.png",
            mimeType: "image/png",
            dataBase64: "aW1hZ2UtYnl0ZXM=",
          }),
        });
        expect(response.status).toBe(201);
        const payload = await response.json() as { attachment: { file_path: string } };
        expect(payload.attachment.file_path.startsWith(join(runtimeDir, "temp"))).toBe(true);
        await expect(readFile(payload.attachment.file_path, "utf8")).resolves.toBe("image-bytes");
        await expect(stat(join(projectRoot, ".dreamgraph"))).rejects.toThrow();
      });
    } finally {
      scopeSpy.mockRestore();
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  it("requires explicit approval before acquiring the pinned Doom shareware bundle", async () => {
    const previousDoom = process.env.DREAMGRAPH_ENABLE_DOOM;
    process.env.DREAMGRAPH_ENABLE_DOOM = "true";
    const tempRoot = await mkdtemp(join(tmpdir(), "dreamgraph-architect-doom-spike-"));
    const projectRoot = join(tempRoot, "project");
    const runtimeDir = join(tempRoot, "instance", "runtime");
    const scopeSpy = vi.spyOn(lifecycle, "getActiveScope").mockReturnValue({
      uuid: "standalone-architect-doom-spike-test",
      projectRoot,
      runtimeDir,
    } as never);

    try {
      await mkdir(projectRoot, { recursive: true });
      await withArchitectServer(async (baseUrl) => {
        const contract = await expectJsonOk(await fetch(`${baseUrl}/api/architect/v1`));
        const routes = contract.routes as Record<string, string>;
        expect(routes.doom_spike_harness).toBe("/architect/doom-spike");
        expect(routes.doom_spike_bundle_status).toBe("GET /api/architect/v1/doom/spike-bundle/status");
        expect(routes.doom_spike_bundle_acquire).toBe("POST /api/architect/v1/doom/spike-bundle/acquire");
        expect(routes.doom_spike_bundle).toBe("GET /api/architect/v1/doom/spike-bundle");

        const harness = await fetch(`${baseUrl}/architect/doom-spike`);
        expect(harness.status).toBe(200);
        const harnessHtml = await harness.text();
        expect(harnessHtml).toContain("Approve Doom Shareware Download");
        expect(harnessHtml).toContain("/api/architect/v1/assets/js-dos/js-dos.js");
        expect(harnessHtml).toContain("/api/architect/v1/doom/spike-bundle?sha256=40d74b90f3527480d2256c75ef443777bd5bebde95133cfe3ba01b2390516712");
        expect(harnessHtml).toContain("pathPrefix: '/api/architect/v1/assets/js-dos/emulators/'");
        expect(harnessHtml).toContain("props.setPaused(true)");
        expect(harnessHtml).toContain("await active.stop()");
        expect(harnessHtml).toContain("setStatus(error.message || String(error));");
        expect(harnessHtml).toContain("runtimePromise = null;");
        expect(harnessHtml).not.toContain("https://v8.js-dos.com/latest");

        const jsDosAsset = await fetch(`${baseUrl}/api/architect/v1/assets/js-dos/js-dos.js`);
        expect(jsDosAsset.status).toBe(200);
        expect(jsDosAsset.headers.get("content-type")).toContain("application/javascript");
        const emulatorsAsset = await fetch(`${baseUrl}/api/architect/v1/assets/js-dos/emulators/emulators.js`);
        expect(emulatorsAsset.status).toBe(200);
        expect(emulatorsAsset.headers.get("content-type")).toContain("application/javascript");
        const wasmAsset = await fetch(`${baseUrl}/api/architect/v1/assets/js-dos/emulators/wdosbox.wasm`);
        expect(wasmAsset.status).toBe(200);
        expect(wasmAsset.headers.get("content-type")).toContain("application/wasm");
        const traversal = await fetch(`${baseUrl}/api/architect/v1/assets/js-dos/%2e%2e/package.json`);
        expect(traversal.status).toBe(404);

        const status = await expectJsonOk(await fetch(`${baseUrl}/api/architect/v1/doom/spike-bundle/status`));
        expect(status.bundle).toMatchObject({
          acquired: false,
          approval_required: true,
          source_kind: "js_dos_hosted_doom_shareware_bundle",
          source_url: "https://v8.js-dos.com/bundles/doom.jsdos",
          local_bundle_url: null,
        });

        const localRead = await fetch(`${baseUrl}/api/architect/v1/doom/spike-bundle`);
        expect(localRead.status).toBe(404);
        await expect(localRead.json()).resolves.toMatchObject({ error: "bundle_not_acquired" });

        const acquire = await fetch(`${baseUrl}/api/architect/v1/doom/spike-bundle/acquire`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ approved: false }),
        });
        expect(acquire.status).toBe(400);
        await expect(acquire.json()).resolves.toMatchObject({ error: "approval_required" });
        await expect(stat(join(projectRoot, ".dreamgraph"))).rejects.toThrow();
        await expect(stat(join(runtimeDir, "cache", "architect-doom", "doom-shareware.jsdos"))).rejects.toThrow();
      });
    } finally {
      if (previousDoom === undefined) delete process.env.DREAMGRAPH_ENABLE_DOOM;
      else process.env.DREAMGRAPH_ENABLE_DOOM = previousDoom;
      scopeSpy.mockRestore();
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  it("serves daemon-governed editor repo, tree, and file-read payloads", async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), "dreamgraph-architect-editor-api-"));
    const previousRepos = { ...config.repos };

    try {
      await mkdir(join(tempRoot, "src"), { recursive: true });
      await mkdir(join(tempRoot, "node_modules"), { recursive: true });
      await writeFile(join(tempRoot, "src", "sample.ts"), "export const sample = 1;\n", "utf-8");
      config.repos.editorTest = tempRoot;

      await withArchitectServer(async (baseUrl) => {
        const contract = await expectJsonOk(await fetch(`${baseUrl}/api/architect/v1`));
        const routes = contract.routes as Record<string, string>;
        expect(routes.editor_repos).toBe("GET /api/architect/v1/editor/repos");
        expect(routes.editor_tree).toBe("POST /api/architect/v1/editor/tree");
        expect(routes.editor_file_load).toBe("POST /api/architect/v1/editor/file/load");

        const reposPayload = await expectJsonOk(await fetch(`${baseUrl}/api/architect/v1/editor/repos`));
        const repos = reposPayload.repos as Array<Record<string, unknown>>;
        const repo = repos.find((candidate) => candidate.id === "editorTest");
        expect(repo).toBeTruthy();
        expect(repo?.direct_browser_filesystem_access).toBe(false);
        expect(repo).not.toHaveProperty("root");

        const treePayload = await expectJsonOk(await fetch(`${baseUrl}/api/architect/v1/editor/tree`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ repo: "editorTest", path: "" }),
        }));
        const tree = treePayload.tree as Record<string, unknown>;
        const children = tree.children as Array<Record<string, unknown>>;
        expect(tree.repo).toBe("editorTest");
        expect(tree.direct_browser_filesystem_access).toBe(false);
        expect(children.some((node) => node.path === "src" && node.kind === "directory")).toBe(true);
        expect(children.some((node) => node.path === "node_modules")).toBe(false);

        const filePayload = await expectJsonOk(await fetch(`${baseUrl}/api/architect/v1/editor/file/load`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ repo: "editorTest", file_path: "src/sample.ts" }),
        }));
        const file = filePayload.file as Record<string, unknown>;
        expect(file.repo).toBe("editorTest");
        expect(file.file_path).toBe("src/sample.ts");
        expect(file.language).toBe("typescript");
        expect(file.content).toBe("export const sample = 1;\n");
        expect(typeof file.revision).toBe("string");
        expect(file.direct_browser_filesystem_access).toBe(false);

        const savePayload = await expectJsonOk(await fetch(`${baseUrl}/api/architect/v1/editor/file/save`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ repo: "editorTest", file_path: "src/sample.ts", content: "export const sample = 2;\n", revision: file.revision }),
        }));
        const saveResult = savePayload.result as Record<string, unknown>;
        expect(saveResult.saved).toBe(true);
        expect(typeof saveResult.revision).toBe("string");
        const graphSync = saveResult.graph_sync as Record<string, unknown>;
        const scanEvent = graphSync.event as Record<string, unknown>;
        expect(["graph.file_scanned", "graph.file_scan_failed"]).toContain(scanEvent.type);
        expect(scanEvent.repoId).toBe("editorTest");
        expect(scanEvent.filePath).toBe("src/sample.ts");
        expect(typeof scanEvent.durationMs).toBe("number");
        expect(typeof scanEvent.nodesUpdated).toBe("number");
        expect(typeof scanEvent.relationshipsUpdated).toBe("number");
        expect(scanEvent.direct_browser_filesystem_access).toBe(false);
        expect(await readFile(join(tempRoot, "src", "sample.ts"), "utf-8")).toBe("export const sample = 2;\n");

        await writeFile(join(tempRoot, "src", "sample.ts"), "export const sample = 3;\n", "utf-8");
        const staleSave = await fetch(`${baseUrl}/api/architect/v1/editor/file/save`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ repo: "editorTest", file_path: "src/sample.ts", content: "export const sample = 4;\n", revision: saveResult.revision }),
        });
        expect(staleSave.status).toBe(409);
        const stalePayload = await staleSave.json() as Record<string, unknown>;
        expect(stalePayload.error).toBe("revision_conflict");
        expect((stalePayload.conflict as Record<string, unknown>).resolution).toBe("reload_required");
        expect(await readFile(join(tempRoot, "src", "sample.ts"), "utf-8")).toBe("export const sample = 3;\n");

        const escaped = await fetch(`${baseUrl}/api/architect/v1/editor/tree`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ repo: "editorTest", path: "../outside" }),
        });
        expect(escaped.status).toBe(400);
        const escapedPayload = await escaped.json() as Record<string, unknown>;
        expect(escapedPayload.ok).toBe(false);
      });
    } finally {
      for (const key of Object.keys(config.repos)) delete config.repos[key];
      Object.assign(config.repos, previousRepos);
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  it("advertises Phase 6 and Phase 7 contracts from the daemon boundary", async () => {
    await withArchitectServer(async (baseUrl) => {
      const payload = await expectJsonOk(await fetch(`${baseUrl}/api/architect/v1`));
      const routes = payload.routes as Record<string, string>;
      const future = payload.adaptive_future_projection as Record<string, unknown>;
      const interop = payload.vscode_interop as Record<string, unknown>;

      expect(routes.config).toBe("POST /api/architect/v1/config");
      expect(routes.provider_readiness).toBe("POST /api/architect/v1/provider-readiness");
      expect(routes.repo_setup).toBe("GET|POST /api/architect/v1/repo-setup");
      expect(routes.onboarding_events).toBe("GET|POST /api/architect/v1/onboarding-events");
      expect(routes.selection).toBe("POST /api/architect/v1/selection");
      expect(routes.future_review).toBe("/api/architect/v1/plans/{planId}/future-review");
      expect(routes.schedules).toBe("/api/architect/v1/schedules");
      expect(routes.schedule_actions).toBe("/api/architect/v1/schedules/{scheduleId}/actions");
      expect(routes.commands).toBe("POST /api/architect/v1/commands");
      expect(((payload.architect_llm as Record<string, unknown>).capabilities as Record<string, unknown>).textAttachments).toBeTypeOf("boolean");
      expect(((payload.architect_llm as Record<string, unknown>).capabilities as Record<string, unknown>).imageAttachments).toBeTypeOf("boolean");
      expect(future.advisory).toBe(true);
      expect(future.fallback_visible).toBe(true);
      expect(interop.companion_surface).toBe(true);
      expect(interop.cutover_requires_superseding_adr).toBe(true);
    });
  });

  it("projects VS Code escape hatch links with plan detail snapshots", async () => {
    await withArchitectServer(async (baseUrl) => {
      const payload = await expectJsonOk(await fetch(`${baseUrl}/api/architect/v1/plans/STANDALONE_ARCHITECT_MIGRATION_PLAN`));
      const plan = payload.plan as Record<string, unknown>;
      const links = plan.vscode_links as Record<string, string>;

      expect(links.plan_markdown).toMatch(/^vscode:\/\/file\//);
      expect(links.plan_markdown).toContain("STANDALONE_ARCHITECT_MIGRATION_PLAN.md");
      expect(links.implementation_log).toMatch(/^vscode:\/\/file\//);
      expect(links.implementation_log).toContain("STANDALONE_ARCHITECT_MIGRATION_PLAN.implementation-log.md");
    });
  });

  it("serves daemon-governed ADR previews without browser filesystem authority", async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), "dreamgraph-architect-adr-preview-"));
    const dataDir = join(tempRoot, "data");
    const scopeSpy = vi.spyOn(lifecycle, "getActiveScope").mockReturnValue({
      uuid: "standalone-architect-adr-preview-test",
      projectRoot: tempRoot,
      dataDir,
    } as never);

    try {
      await mkdir(dataDir, { recursive: true });
      await writeFile(join(dataDir, "adr_log.json"), JSON.stringify({
        metadata: { description: "test ADRs", schema_version: "1.0.0", total_decisions: 1, last_updated: "2026-05-28T00:00:00.000Z" },
        decisions: [{
          id: "ADR-206",
          title: "Standalone Architect migration is plan-centered and daemon-authoritative",
          date: "2026-05-27T18:56:26.775Z",
          decided_by: "collaborative",
          status: "accepted",
          context: { problem: "Standalone Architect needs a daemon-authoritative plan workflow.", constraints: [], affected_entities: ["standalone-architect"] },
          decision: { chosen: "Keep standalone Architect plan-centered and daemon-governed.", alternatives: [] },
          consequences: { expected: [], risks: [] },
          guard_rails: ["Do not implement standalone browser filesystem writes."],
          tags: ["standalone-architect"],
        }],
      }), "utf-8");

      await withArchitectServer(async (baseUrl) => {
        const contract = await expectJsonOk(await fetch(`${baseUrl}/api/architect/v1`));
      const routes = contract.routes as Record<string, string>;
      expect(routes.adrs).toBe("/api/architect/v1/adrs");
      expect(routes.adr_preview).toBe("/api/architect/v1/adrs/{adrId}");

      const indexPayload = await expectJsonOk(await fetch(`${baseUrl}/api/architect/v1/adrs`));
      const surface = indexPayload.adr_surface as Record<string, unknown>;
      const adrs = indexPayload.adrs as Array<Record<string, unknown>>;
      expect(surface.read_only).toBe(true);
      expect(surface.direct_browser_filesystem_access).toBe(false);
      expect(adrs.length).toBeGreaterThan(0);

      const previewPayload = await expectJsonOk(await fetch(`${baseUrl}/api/architect/v1/adrs/ADR-206`));
      const adr = previewPayload.adr as Record<string, unknown>;
      const fullContent = previewPayload.full_content as Record<string, unknown>;
      const advisory = adr.advisory_metadata as Record<string, unknown>;
      expect(adr.id).toBe("ADR-206");
      expect(adr.title).toContain("Standalone Architect");
      expect(adr.status).toBe("accepted");
      expect(typeof adr.decision_summary).toBe("string");
      expect(Array.isArray(adr.guard_rails)).toBe(true);
      expect(advisory.read_model).toBe("daemon_governed_preview");
      expect(advisory.hard_enforcement).toBe(false);
      expect(fullContent.id).toBe("ADR-206");

        const missing = await fetch(`${baseUrl}/api/architect/v1/adrs/ADR-999999`);
        expect(missing.status).toBe(404);
      });
    } finally {
      scopeSpy.mockRestore();
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  it("records ADR edit proposals through a selected plan audit without direct ADR file mutation", async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), "dreamgraph-architect-adr-edit-"));
    const dataDir = join(tempRoot, "data");
    const scopeSpy = vi.spyOn(lifecycle, "getActiveScope").mockReturnValue({
      uuid: "standalone-architect-adr-edit-test",
      projectRoot: tempRoot,
      dataDir,
    } as never);

    try {
      await mkdir(dataDir, { recursive: true });
      const adrLog = {
        metadata: { description: "test ADRs", schema_version: "1.0.0", total_decisions: 1, last_updated: "2026-05-28T00:00:00.000Z" },
        decisions: [{
          id: "ADR-206",
          title: "Standalone Architect migration is plan-centered and daemon-authoritative",
          date: "2026-05-27T18:56:26.775Z",
          decided_by: "collaborative",
          status: "accepted",
          context: { problem: "Standalone Architect needs a daemon-authoritative plan workflow.", constraints: [], affected_entities: ["standalone-architect"] },
          decision: { chosen: "Keep standalone Architect plan-centered and daemon-governed.", alternatives: [] },
          consequences: { expected: [], risks: [] },
          guard_rails: ["Do not implement standalone browser filesystem writes."],
          tags: ["standalone-architect"],
        }],
      };
      await writeFile(join(dataDir, "adr_log.json"), JSON.stringify(adrLog), "utf-8");

      await withArchitectServer(async (baseUrl) => {
        const createdResponse = await fetch(`${baseUrl}/api/architect/v1/plans`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ title: "ADR Edit Proposal Plan" }),
        });
        expect(createdResponse.status).toBe(201);
        const created = await createdResponse.json() as Record<string, unknown>;
        const planId = String((created.result as Record<string, unknown>).plan_id);

        const proposalResponse = await fetch(`${baseUrl}/api/architect/v1/adrs/ADR-206/edits`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            plan_id: planId,
            title: "Standalone Architect remains daemon-authoritative",
            decision_summary: "Keep standalone Architect plan-centered, daemon-governed, and review-audited.",
            problem_summary: "Standalone Architect needs a daemon-authoritative plan workflow.",
            guard_rails: ["Do not implement standalone browser filesystem writes."],
            tags: ["standalone-architect", "browser-ui"],
          }),
        });
        expect(proposalResponse.status).toBe(202);
        const proposal = await proposalResponse.json() as Record<string, unknown>;
        const result = proposal.result as Record<string, unknown>;
        expect(result.status).toBe("proposal_recorded");
        expect(result.changed).toBe(false);
        expect(result.audit_scope).toBe("daemon_governed_adr_edit_proposal");
        expect(result.changed_fields).toEqual(expect.arrayContaining(["title", "decision_summary", "tags"]));
        expect(String((result.editor_contract as Record<string, unknown>).mutation_authority)).toBe("daemon_governed_plan_log");

        const persistedAdrLog = JSON.parse(await readFile(join(dataDir, "adr_log.json"), "utf-8")) as typeof adrLog;
        expect(persistedAdrLog.decisions[0].title).toBe(adrLog.decisions[0].title);
        const implementationLog = await readFile(join(tempRoot, "plans", `${planId}.implementation-log.md`), "utf-8");
        expect(implementationLog).toContain("adr_edit_proposal");
        expect(implementationLog).toContain("ADR ADR-206");
      });
    } finally {
      scopeSpy.mockRestore();
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  it("projects advisory future review without turning AFE into enforcement", async () => {
    await withArchitectServer(async (baseUrl) => {
      const payload = await expectJsonOk(await fetch(`${baseUrl}/api/architect/v1/plans/STANDALONE_ARCHITECT_MIGRATION_PLAN/future-review`));
      const review = payload.future_review as Record<string, unknown>;
      const model = review.model_provenance as Record<string, unknown>;
      const candidates = review.candidates as Array<Record<string, unknown>>;
      const selectedCandidate = candidates.find((candidate) => candidate.selected === true) ?? {};

      expect(review.advisory).toBe(true);
      expect(review.hard_enforcement).toBe(false);
      expect(model.fallback).toBe("deterministic_fallback");
      expect(candidates.length).toBeGreaterThan(0);
      expect(String(selectedCandidate.id)).toContain("standalone_architect_migration_plan");
      expect(typeof selectedCandidate.label).toBe("string");
      expect(review.review_decisions).toEqual(expect.arrayContaining([
        expect.objectContaining({ id: "accept" }),
        expect.objectContaining({ id: "reject" }),
        expect.objectContaining({ id: "defer" }),
        expect.objectContaining({ id: "supersede" }),
      ]));

      const otherPayload = await expectJsonOk(await fetch(`${baseUrl}/api/architect/v1/plans/ARCHITECT_REWRITE_FOUNDATION_PLAN/future-review`));
      const otherReview = otherPayload.future_review as Record<string, unknown>;
      const otherCandidates = otherReview.candidates as Array<Record<string, unknown>>;
      const otherSelectedCandidate = otherCandidates.find((candidate) => candidate.selected === true) ?? {};

      expect(otherReview.selected_candidate_id).not.toBe(review.selected_candidate_id);
      expect(String(otherSelectedCandidate.id)).toContain("architect_rewrite_foundation_plan");
      expect(otherSelectedCandidate.label).not.toBe(selectedCandidate.label);
    });
  });

  it("mirrors task-first Architect recipes into the beginner guide", async () => {
    const guide = await readFile(join(process.cwd(), "guide", "architect-for-dummies.md"), "utf8");
    expect(guide).toContain("## Recipe Library");
    expect(guide).toContain("Explain this app before I change it");
    expect(guide).toContain("Create a coordinated implementation plan");
    expect(guide).toContain("## Slash Commands");
    expect(guide).toContain("## Code Editor Tab");
    expect(guide).toContain("## Terminal Tab");
    expect(guide).toContain("DreamGraph MCP-authoritative");
  });

  it("validates provider wizard routes without weakening MCP authority", () => {
    const previousKey = process.env.DREAMGRAPH_LLM_API_KEY;
    try {
      delete process.env.DREAMGRAPH_LLM_API_KEY;
      expect(buildArchitectProviderReadiness({ adapter: "codex-cli", provider: "openai", model: "gpt-5" })).toMatchObject({ ready: true, provider: "none", authority: "dreamgraph_mcp", kind: "cli_subscription" });
      expect(buildArchitectProviderReadiness({ adapter: "deterministic_fallback" })).toMatchObject({ ready: true, provider: "none", authority: "dreamgraph_mcp", kind: "deterministic" });
      expect(buildArchitectProviderReadiness({ adapter: "native_api_tool_loop", provider: "openai", model: "gpt-5" })).toMatchObject({ ready: false, detail: "Set DREAMGRAPH_LLM_API_KEY for openai." });
      expect(buildArchitectProviderReadiness({ adapter: "native_api_tool_loop", provider: "ollama", model: "qwen3:8b" })).toMatchObject({ ready: true, kind: "local" });
    } finally {
      if (previousKey === undefined) delete process.env.DREAMGRAPH_LLM_API_KEY;
      else process.env.DREAMGRAPH_LLM_API_KEY = previousKey;
    }
  });

  it("replaces a stale local model when codex-cli is selected", async () => {
    const previousAdapter = process.env.DREAMGRAPH_LLM_ARCHITECT_ADAPTER;
    const previousProvider = process.env.DREAMGRAPH_LLM_ARCHITECT_PROVIDER;
    const previousModel = process.env.DREAMGRAPH_LLM_ARCHITECT_MODEL;
    try {
      await withArchitectServer(async (baseUrl) => {
        const configured = await expectJsonOk(await fetch(`${baseUrl}/api/architect/v1/config`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ adapter: "codex-cli", provider: "none", model: "qwen3:8b" }),
        }));
        const runtime = configured.runtime as Record<string, unknown>;
        expect(runtime.adapter).toBe("codex-cli");
        expect(runtime.provider).toBe("none");
        expect(runtime.model).toBe("auto");
      });
    } finally {
      if (previousAdapter == null) delete process.env.DREAMGRAPH_LLM_ARCHITECT_ADAPTER; else process.env.DREAMGRAPH_LLM_ARCHITECT_ADAPTER = previousAdapter;
      if (previousProvider == null) delete process.env.DREAMGRAPH_LLM_ARCHITECT_PROVIDER; else process.env.DREAMGRAPH_LLM_ARCHITECT_PROVIDER = previousProvider;
      if (previousModel == null) delete process.env.DREAMGRAPH_LLM_ARCHITECT_MODEL; else process.env.DREAMGRAPH_LLM_ARCHITECT_MODEL = previousModel;
    }
  });

  it("exposes one active session runtime across config and chat payloads", async () => {
    const previousAdapter = process.env.DREAMGRAPH_LLM_ARCHITECT_ADAPTER;
    const previousProvider = process.env.DREAMGRAPH_LLM_ARCHITECT_PROVIDER;
    const previousModel = process.env.DREAMGRAPH_LLM_ARCHITECT_MODEL;
    const previousAutonomy = process.env.DREAMGRAPH_ARCHITECT_AUTONOMY_MODE;
    try {
      await withArchitectServer(async (baseUrl) => {
        const configured = await expectJsonOk(await fetch(`${baseUrl}/api/architect/v1/config`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            adapter: "native_api_tool_loop",
            provider: "openai",
            model: "gpt-5.4",
            mode: "manual",
          }),
        }));
        const configuredRuntime = configured.runtime as Record<string, unknown>;

        expect(configuredRuntime.adapter).toBe("native_api_tool_loop");
        expect(configuredRuntime.provider).toBe("openai");
        expect(configuredRuntime.model).toBe("gpt-5.4");
        expect(configuredRuntime.autonomy_mode).toBe("manual");
        expect(configuredRuntime.execution_route).toBe("native_api_tool_loop");
        expect(typeof configuredRuntime.session_id).toBe("string");
        expect(configuredRuntime.provenance_authority).toBe("dreamgraph_mcp");

        const contract = await expectJsonOk(await fetch(`${baseUrl}/api/architect/v1`));
        const contractRuntime = contract.runtime as Record<string, unknown>;
        expect(contractRuntime.model).toBe("gpt-5.4");
        expect(contractRuntime.autonomy_mode).toBe("manual");
        expect((contract.architect_llm as Record<string, unknown>).session_id).toBe(configuredRuntime.session_id);

        const chat = await expectJsonOk(await fetch(`${baseUrl}/api/architect/v1/chat`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            message: "what model are you running?",
            adapter: "deterministic_fallback",
            provider: "none",
            model: "gpt-5.4",
            mode: "manual",
          }),
        }));
        const result = chat.result as Record<string, unknown>;
        const resultRuntime = result.runtime as Record<string, unknown>;
        expect(resultRuntime.model).toBe("gpt-5.4");
        expect(resultRuntime.autonomy_mode).toBe("manual");
        expect(result.content).toContain("Current execution runtime:");
        expect(result.content).toContain("Model: gpt-5.4");
        expect((result.provenance as Record<string, unknown>).runtime).toEqual(resultRuntime);
      });
    } finally {
      if (previousAdapter == null) delete process.env.DREAMGRAPH_LLM_ARCHITECT_ADAPTER; else process.env.DREAMGRAPH_LLM_ARCHITECT_ADAPTER = previousAdapter;
      if (previousProvider == null) delete process.env.DREAMGRAPH_LLM_ARCHITECT_PROVIDER; else process.env.DREAMGRAPH_LLM_ARCHITECT_PROVIDER = previousProvider;
      if (previousModel == null) delete process.env.DREAMGRAPH_LLM_ARCHITECT_MODEL; else process.env.DREAMGRAPH_LLM_ARCHITECT_MODEL = previousModel;
      if (previousAutonomy == null) delete process.env.DREAMGRAPH_ARCHITECT_AUTONOMY_MODE; else process.env.DREAMGRAPH_ARCHITECT_AUTONOMY_MODE = previousAutonomy;
    }
  });

  it("persists selected standalone plan in engine.env and exposes it for restart restore", async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), "dreamgraph-architect-selected-plan-"));
    const engineEnvPath = join(tempRoot, "config", "engine.env");
    const previousSelectedPlan = process.env.DREAMGRAPH_ARCHITECT_SELECTED_PLAN_ID;
    const scopeSpy = vi.spyOn(lifecycle, "getActiveScope").mockReturnValue({
      uuid: "standalone-architect-selected-plan-test",
      projectRoot: tempRoot,
      engineEnvPath,
    } as never);

    try {
      await withArchitectServer(async (baseUrl) => {
        const createdResponse = await fetch(`${baseUrl}/api/architect/v1/plans`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ title: "Browser Architect UI Level 2" }),
        });
        expect(createdResponse.status).toBe(201);
        const created = await createdResponse.json() as Record<string, unknown>;
        const createdResult = created.result as Record<string, unknown>;
        const planId = String(createdResult.plan_id);

        const selected = await expectJsonOk(await fetch(`${baseUrl}/api/architect/v1/selection`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ selected_plan_id: planId }),
        }));
        const selectedResult = selected.result as Record<string, unknown>;
        expect(selectedResult.persisted).toBe(true);
        expect(selectedResult.selected_plan_id).toBe(planId);
        expect(selectedResult.env_key).toBe("DREAMGRAPH_ARCHITECT_SELECTED_PLAN_ID");
        expect(selected.selected_plan_id).toBe(planId);

        const env = await readFile(engineEnvPath, "utf-8");
        expect(env).toContain(`DREAMGRAPH_ARCHITECT_SELECTED_PLAN_ID=${planId}`);

        const plans = await expectJsonOk(await fetch(`${baseUrl}/api/architect/v1/plans`));
        expect(plans.selected_plan_id).toBe(planId);
        expect((plans.architect_selection as Record<string, unknown>).selected_plan_id).toBe(planId);

        const cleared = await expectJsonOk(await fetch(`${baseUrl}/api/architect/v1/selection`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ selected_plan_id: null }),
        }));
        const clearedResult = cleared.result as Record<string, unknown>;
        expect(clearedResult.persisted).toBe(true);
        expect(clearedResult.selected_plan_id).toBeNull();
        const clearedEnv = await readFile(engineEnvPath, "utf-8");
        expect(clearedEnv).toContain("# DREAMGRAPH_ARCHITECT_SELECTED_PLAN_ID=");

        const clearedPlans = await expectJsonOk(await fetch(`${baseUrl}/api/architect/v1/plans`));
        expect(clearedPlans.selected_plan_id).toBeNull();
        expect((clearedPlans.architect_selection as Record<string, unknown>).selected_plan_id).toBeNull();
      });
    } finally {
      if (previousSelectedPlan == null) delete process.env.DREAMGRAPH_ARCHITECT_SELECTED_PLAN_ID; else process.env.DREAMGRAPH_ARCHITECT_SELECTED_PLAN_ID = previousSelectedPlan;
      scopeSpy.mockRestore();
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  it("separates project-scope chat from selected plan logs and honors slash overrides", async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), "dreamgraph-architect-chat-scope-"));
    const scopeSpy = vi.spyOn(lifecycle, "getActiveScope").mockReturnValue({
      uuid: "standalone-architect-chat-scope-test",
      projectRoot: tempRoot,
    } as never);

    try {
      await withArchitectServer(async (baseUrl) => {
        const createdResponse = await fetch(`${baseUrl}/api/architect/v1/plans`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ title: "Chat Scope Separation Plan" }),
        });
        expect(createdResponse.status).toBe(201);
        const created = await createdResponse.json() as Record<string, unknown>;
        const planId = String((created.result as Record<string, unknown>).plan_id);

        const globalChat = await expectJsonOk(await fetch(`${baseUrl}/api/architect/v1/chat`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            message: "/global this plan should add graph health notes",
            scope: "plan",
            planId,
            adapter: "deterministic_fallback",
            provider: "none",
            model: "gpt-5.4",
            mode: "manual",
          }),
        }));
        const globalResult = globalChat.result as Record<string, unknown>;
        expect(globalResult.chat_scope).toBe("project");
        expect(globalResult.plan_id).toBeNull();
        expect(globalResult.plan_update).toBeNull();

        const logAfterGlobal = await readFile(join(tempRoot, "plans", `${planId}.implementation-log.md`), "utf-8");
        expect(logAfterGlobal).not.toContain("chat_plan_update");
        expect(logAfterGlobal).not.toContain("graph health notes");

        const planChat = await expectJsonOk(await fetch(`${baseUrl}/api/architect/v1/chat`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            message: "/plan this plan should add Slice 2 continuation notes",
            scope: "project",
            planId,
            adapter: "deterministic_fallback",
            provider: "none",
            model: "gpt-5.4",
            mode: "manual",
          }),
        }));
        const planResult = planChat.result as Record<string, unknown>;
        const planUpdate = planResult.plan_update as Record<string, unknown>;
        expect(planResult.chat_scope).toBe("plan");
        expect(planResult.plan_id).toBe(planId);
        expect(planUpdate.changed).toBe(true);

        const logAfterPlan = await readFile(join(tempRoot, "plans", `${planId}.implementation-log.md`), "utf-8");
        expect(logAfterPlan).toContain("chat_plan_update");
        expect(logAfterPlan).toContain("Slice 2 continuation notes");
      });
    } finally {
      scopeSpy.mockRestore();
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  it("applies selected-plan chat additions through daemon fallback when CLI adapter is metadata-only", async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), "dreamgraph-architect-chat-plan-"));
    const scopeSpy = vi.spyOn(lifecycle, "getActiveScope").mockReturnValue({
      uuid: "standalone-architect-chat-plan-test",
      projectRoot: tempRoot,
    } as never);

    try {
      await withArchitectServer(async (baseUrl) => {
        const createdResponse = await fetch(`${baseUrl}/api/architect/v1/plans`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ title: "Browser Architect UI Level 2" }),
        });
        expect(createdResponse.status).toBe(201);
        const created = await createdResponse.json() as Record<string, unknown>;
        const createdResult = created.result as Record<string, unknown>;
        const planId = String(createdResult.plan_id);

        const update = await expectJsonOk(await fetch(`${baseUrl}/api/architect/v1/chat`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            message: [
              "this plan should design the next level features of the browser based standalone architect:",
              "",
              "- Plan tree hierarchy",
              "- ADR editor dedicated and inline",
              "- Filters for the left side plan view",
            ].join("\n"),
            planId,
            adapter: "codex-cli",
            provider: "none",
            model: "gpt-5.4",
            mode: "autonomous",
          }),
        }));
        const result = update.result as Record<string, unknown>;
        const planUpdate = result.plan_update as Record<string, unknown>;

        expect(result.content).toContain("Updated Browser Architect UI Level 2");
        expect(planUpdate.changed).toBe(true);
        expect(planUpdate.update_mode).toBe("replace_goal_placeholder");
        expect(String((result.route as Record<string, unknown>).fallback_reason)).toContain("architect_provider_failed");
        expect(String((result.route as Record<string, unknown>).fallback_reason)).not.toContain("metadata_only");

        const markdown = await readFile(join(tempRoot, "plans", `${planId}.md`), "utf-8");
        const log = await readFile(join(tempRoot, "plans", `${planId}.implementation-log.md`), "utf-8");
        expect(markdown).toContain("Plan tree hierarchy");
        expect(markdown).not.toContain("Describe the goal for this Architect plan.");
        expect(log).toContain("chat_plan_update");
        expect(log).toContain("selected plan markdown was updated by the daemon");
      });
    } finally {
      scopeSpy.mockRestore();
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  it("rejects GET chat prompts and supports POST SSE chat responses", async () => {
    await withArchitectServer(async (baseUrl) => {
      const rejected = await fetch(`${baseUrl}/api/architect/v1/chat?message=must-not-travel-in-url`);
      expect(rejected.status).toBe(405);
      expect(rejected.headers.get("allow")).toBe("POST");

      const response = await fetch(`${baseUrl}/api/architect/v1/chat`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "text/event-stream",
        },
        body: JSON.stringify({
          message: "hello what is the project?",
          planId: "STANDALONE_ARCHITECT_MIGRATION_PLAN",
          continuationToken: "test-continuation",
          mode: "autonomous",
          responseTransport: "sse",
        }),
      });

      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toContain("text/event-stream");
      const text = await response.text();
      expect(text).toContain("event: architect.chat.status");
      expect(text).toContain("event: architect.chat.result");
      expect(text).toContain("\"transport\":\"sse\"");
    });
  });

  it("projects implementation-log lifecycle and next-slice status", async () => {
    await withArchitectServer(async (baseUrl) => {
      const response = await fetch(`${baseUrl}/api/architect/v1/plans/browser-architect-ui-level-2`);
      const payload = await expectJsonOk(response);
      const plan = payload.plan as { operational_state?: Record<string, unknown> };
      const operational = plan.operational_state ?? {};
      const lastCompleted = operational.last_completed_slice as { title?: string } | null;
      const nextSlice = operational.next_slice as { title?: string } | null;

      expect(operational.plan_lifecycle).toBe("implementing");
      expect(operational.execution_state).toBe("idle");
      expect(String(lastCompleted?.title ?? lastCompleted?.id ?? "")).toContain("Slice 6");
      expect(String(nextSlice?.title ?? nextSlice?.id ?? "")).toBe("");
      expect(String(operational.current_slice_id ?? "")).not.toContain("standalone-architect-chat-plan-update");
    });
  });

  it("projects living plan state from markdown and implementation-log evidence", async () => {
    await withArchitectServer(async (baseUrl) => {
      const payload = await expectJsonOk(await fetch(`${baseUrl}/api/architect/v1/plans/living-dreamgraph`));
      const plan = payload.plan as { living_state?: Record<string, unknown> };
      const living = plan.living_state ?? {};
      const currentSlice = living.current_slice as { title?: string } | null;
      const questions = living.open_questions as string[];
      const nervousPoints = living.nervous_points as string[];
      const branches = living.branches as Array<{ title?: string; status?: string }>;
      const anchors = living.evidence_anchors as Array<{ id?: string }>;

      expect(living.source).toBe("markdown_log_projection");
      expect(living.confidence).toBe("medium");
      expect(living.review_state).toBe("implementation_ready");
      expect(String(currentSlice?.title ?? "")).toContain("Slice E");
      expect(questions.length).toBeGreaterThan(0);
      expect(nervousPoints.length).toBeGreaterThan(0);
      expect(branches.every((branch) => branch.status === "conceptual_candidate")).toBe(true);
      expect(branches.some((branch) => String(branch.title).includes("Slice A"))).toBe(false);
      expect(anchors.some((anchor) => anchor.id === "ADR-218")).toBe(true);
      expect(String(living.last_changed_because ?? "")).toContain("Slice E");
      expect(String(living.pulse ?? "")).toContain("questions=");
    });
  });

  it("omits resolved nervous points from the living plan projection", async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), "dreamgraph-architect-resolved-nervous-points-"));
    const dataDir = join(tempRoot, "data");
    const plansDir = join(tempRoot, "plans");
    const scopeSpy = vi.spyOn(lifecycle, "getActiveScope").mockReturnValue({
      uuid: "standalone-architect-resolved-nervous-points-test",
      projectRoot: tempRoot,
      dataDir,
    } as never);

    try {
      await mkdir(plansDir, { recursive: true });
      await writeFile(join(plansDir, "resolved-nervous-points.md"), [
        "# Resolved Nervous Points",
        "",
        "Status: Draft",
        "",
        "## Nervous Points",
        "",
        "- Active migration risk still needs review",
        "- [x] Legacy sidebar race was addressed",
        "- Addressed: stale route count was fixed",
        "- Solved - old plan selection issue",
        "",
        "## Design Guardrails",
        "",
        "- Resolved: daemon authority gap",
        "- Guard command mutations behind governed tools",
        "",
      ].join("\n"), "utf-8");

      await withArchitectServer(async (baseUrl) => {
        const payload = await expectJsonOk(await fetch(`${baseUrl}/api/architect/v1/plans/resolved-nervous-points`));
        const plan = payload.plan as { living_state?: Record<string, unknown> };
        const living = plan.living_state ?? {};
        const nervousPoints = living.nervous_points as string[];

        expect(nervousPoints).toEqual([
          "Active migration risk still needs review",
          "Guard command mutations behind governed tools",
        ]);
      });
    } finally {
      scopeSpy.mockRestore();
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  it("treats implemented slice checkpoints as complete and advances to the next slice", async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), "dreamgraph-architect-slice-projection-"));
    const dataDir = join(tempRoot, "data");
    const plansDir = join(tempRoot, "plans");
    const scopeSpy = vi.spyOn(lifecycle, "getActiveScope").mockReturnValue({
      uuid: "standalone-architect-slice-projection-test",
      projectRoot: tempRoot,
      dataDir,
    } as never);

    try {
      await mkdir(plansDir, { recursive: true });
      await writeFile(join(plansDir, "slice-projection.md"), [
        "# Slice Projection",
        "",
        "Status: Draft",
        "",
        "### Slice 1 - Foundation",
        "",
        "### Slice 2 - Status",
        "",
        "### Slice 3 - Plugins",
        "",
      ].join("\n"), "utf-8");
      await writeFile(join(plansDir, "slice-projection.implementation-log.md"), [
        "# Slice Projection Implementation Log",
        "",
        "### 2026-05-29T12:09:00.000Z - slice: Slice 2 - Status - status: completed",
        "",
        "- Verification: complete",
        "",
        "### 2026-05-29T12:08:00.000Z - slice: Slice 1 - Foundation - status: implemented",
        "",
        "- Verification: complete",
        "",
      ].join("\n"), "utf-8");

      await withArchitectServer(async (baseUrl) => {
        const response = await fetch(`${baseUrl}/api/architect/v1/plans/slice-projection`);
        const payload = await expectJsonOk(response);
        const plan = payload.plan as { operational_state?: Record<string, unknown> };
        const operational = plan.operational_state ?? {};
        const lastCompleted = operational.last_completed_slice as { title?: string } | null;
        const nextSlice = operational.next_slice as { title?: string } | null;

        expect(String(lastCompleted?.title ?? lastCompleted?.id ?? "")).toContain("Slice 2");
        expect(String(nextSlice?.title ?? nextSlice?.id ?? "")).toContain("Slice 3");
        expect(String(operational.current_slice_title ?? "")).toContain("Slice 3");
      });
    } finally {
      scopeSpy.mockRestore();
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  it("does not project stale resume notes as next slice after all slices complete", async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), "dreamgraph-architect-completed-slice-projection-"));
    const dataDir = join(tempRoot, "data");
    const plansDir = join(tempRoot, "plans");
    const scopeSpy = vi.spyOn(lifecycle, "getActiveScope").mockReturnValue({
      uuid: "standalone-architect-completed-slice-projection-test",
      projectRoot: tempRoot,
      dataDir,
    } as never);

    try {
      await mkdir(plansDir, { recursive: true });
      await writeFile(join(plansDir, "completed-slice-projection.md"), [
        "# Completed Slice Projection",
        "",
        "Status: Draft",
        "",
        "### Slice 1 - Foundation",
        "",
        "### Slice 2 - Layout",
        "",
        "### Slice 3 - Tests",
        "",
      ].join("\n"), "utf-8");
      await writeFile(join(plansDir, "completed-slice-projection.implementation-log.md"), [
        "# Completed Slice Projection Implementation Log",
        "",
        "### 2026-05-29T12:00:00.000Z - slice: 1 - status: completed",
        "",
        "- Verification: complete",
        "",
        "### 2026-05-29T12:10:00.000Z - slice: 2 - status: completed",
        "",
        "- Resume note: continue with Slice 2 - Layout",
        "",
        "### 2026-05-29T12:20:00.000Z - slice: 3 - status: completed",
        "",
        "- Verification: complete",
        "",
        "### 2026-05-29T12:30:00.000Z - slice: plan-completion - status: completed",
        "",
        "- Verification: complete",
        "",
      ].join("\n"), "utf-8");

      await withArchitectServer(async (baseUrl) => {
        const response = await fetch(`${baseUrl}/api/architect/v1/plans/completed-slice-projection`);
        const payload = await expectJsonOk(response);
        const plan = payload.plan as { status?: string | null; operational_state?: Record<string, unknown> };
        const operational = plan.operational_state ?? {};
        const activeSlice = operational.active_slice as { title?: string } | null;
        const lastCompleted = operational.last_completed_slice as { title?: string } | null;

        expect(plan.status).toBe("completed");
        expect(operational.plan_lifecycle).toBe("completed");
        expect(operational.execution_state).toBe("complete");
        expect(operational.next_slice).toBeNull();
        expect(activeSlice).toBeNull();
        expect(String(lastCompleted?.title ?? lastCompleted?.id ?? "")).toContain("Slice 3");
        expect(operational.current_slice_id).toBeNull();
        expect(operational.current_slice_title).toBeNull();
        expect(String(operational.resume_hint ?? "")).toContain("completed after Slice 3");
        expect(String(operational.resume_hint ?? "")).not.toContain("continue with Slice 2");

        const listResponse = await fetch(`${baseUrl}/api/architect/v1/plans`);
        const listPayload = await expectJsonOk(listResponse);
        const plans = listPayload.plans as Array<{ id?: string; status?: string; operational_state?: Record<string, unknown> }>;
        const filters = listPayload.plan_filters as { status_options?: string[] };
        expect(plans.find((entry) => entry.id === "completed-slice-projection")?.status).toBe("completed");
        expect(filters.status_options).toContain("completed");
        expect(filters.status_options).not.toContain("Draft");
      });
    } finally {
      scopeSpy.mockRestore();
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  it("formats status command JSON into chat-safe status text", () => {
    const rendered = formatArchitectStatusPayload({
      identity: { uuid: "instance-1", name: "Architect", status: "active", mode: "standalone", policy: "local" },
      project: { root: "C:/repo" },
      daemon: { running: true, pid: 1234, port: 8765, uptime_ms: 65000, crashed: false },
      cognitive: { graph_nodes: 10, graph_edges: 20, candidate_edges: 30, validated_edges: 5, tensions: 4, adr_decisions: 3, ui_elements: 6, dream_cycles: 2, tool_calls: 7 },
    }, "fallback-instance");

    expect(rendered).toContain("DreamGraph status");
    expect(rendered).toContain("Instance: Architect (instance-1)");
    expect(rendered).toContain("Daemon: running, pid 1234, port 8765, uptime 65s");
    expect(rendered).toContain("Cognitive: 10 nodes, 20 edges, 30 candidate edges, 5 validated edges, 4 tensions, 3 ADR decisions, 6 UI elements");
    expect(rendered).not.toContain("dg status");
  });

  it("formats plugin command JSON into chat-safe plugin summaries", () => {
    const list = formatArchitectPluginListPayload([
      { id: "examples.hello-events", version: "0.1.0", enabled: true, trusted: false, capabilities: ["tools", "resources"] },
    ]);
    expect(list).toContain("Discovered 1 plugin");
    expect(list).toContain("examples.hello-events@0.1.0 (enabled, untrusted)");
    expect(list).toContain("Capabilities: tools, resources");
    expect(list).not.toContain("manifest_source");

    const inspect = formatArchitectPluginInspectPayload({
      id: "examples.hello-events",
      version: "0.1.0",
      enabled: false,
      trusted: true,
      manifest_source: "C:/instance/plugins/examples.hello-events/plugin.json",
      manifest: { description: "Example plugin", capabilities: ["ui"] },
    }, "fallback.plugin");
    expect(inspect).toContain("Plugin examples.hello-events@0.1.0");
    expect(inspect).toContain("State: disabled, trusted");
    expect(inspect).toContain("Description: Example plugin");
    expect(inspect).not.toContain("{\n");
  });

  it("validates plugin slash command arguments before invoking CLI output", async () => {
    const scopeSpy = vi.spyOn(lifecycle, "getActiveScope").mockReturnValue({
      uuid: "standalone-architect-plugin-validation-test",
      projectRoot: tmpdir(),
      dataDir: join(tmpdir(), "data"),
    } as never);

    try {
      await withArchitectServer(async (baseUrl) => {
        const response = await fetch(`${baseUrl}/api/architect/v1/commands`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ command: "plugin", args: ["inspect"] }),
        });
        const payload = await response.json() as Record<string, unknown>;
        expect(response.status).toBe(400);
        expect(String(payload.message)).toBe("Usage: /plugin inspect <plugin-id>");
        expect(String(payload.message)).not.toContain("dg plugin");
      });
    } finally {
      scopeSpy.mockRestore();
    }
  });

  it("formats plan command payloads into chat-safe plan summaries", () => {
    const plan = {
      id: "architect-level-3",
      title: "Architect Level 3",
      path: "plans/architect-level-3.md",
      log_path: "plans/architect-level-3.implementation-log.md",
      status: "Draft",
      active_phase: "Phase 1",
      updated_at: "2026-05-29T00:00:00.000Z",
      adr_bindings: ["ADR-209", "ADR-218"],
      graph_binding_count: 0,
      slice_count: 8,
      checkpoint_count: 3,
      operational_state: {
        plan_lifecycle: "implementing",
        execution_state: "idle",
        active_phase: "Phase 1 / Level 3",
        current_slice_title: "Slice 4 - Plan Management Slash Commands",
        last_completed_slice: { id: "slice-3", title: "Slice 3 - Plugin Slash Commands", status: "completed" },
        next_slice: { id: "slice-5", title: "Slice 5 - Task Execution Control Architecture", status: null },
      },
    } as never;

    const list = formatArchitectPlanListPayload([plan], "architect-level-3");
    expect(list).toContain("Architect plans (1); selected: architect-level-3");
    expect(list).toContain("* architect-level-3 - Architect Level 3");
    expect(list).not.toContain("dg ");

    const detail = {
      ...plan,
      markdown: "# Architect Level 3",
      headings: [],
      resume_state: { last_log_heading: "Slice 3", last_resume_note: "continue", log_excerpt: "done" },
      registry: {} as never,
    } as never;
    const status = formatArchitectPlanStatusPayload(detail, "architect-level-3");
    expect(status).toContain("Plan Architect Level 3 (architect-level-3)");
    expect(status).toContain("Active slice: Slice 4 - Plan Management Slash Commands");
    expect(status).toContain("ADR bindings: ADR-209, ADR-218");
    expect(formatArchitectPlanNextPayload(detail)).toContain("Slice 5 - Task Execution Control Architecture");
  });

  it("handles plan slash commands through daemon-owned plan and selection state", async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), "dreamgraph-architect-plan-command-"));
    const dataDir = join(tempRoot, "data");
    const scopeSpy = vi.spyOn(lifecycle, "getActiveScope").mockReturnValue({
      uuid: "standalone-architect-plan-command-test",
      projectRoot: tempRoot,
      dataDir,
    } as never);

    try {
      await mkdir(join(tempRoot, "plans"), { recursive: true });
      await withArchitectServer(async (baseUrl) => {
        const createdResponse = await fetch(`${baseUrl}/api/architect/v1/commands`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ command: "plan", args: ["new", "Slash Managed Plan"] }),
        });
        const created = await expectJsonOk(createdResponse);
        const createdResult = created.result as Record<string, unknown>;
        const createdStructured = createdResult.structured as Record<string, unknown>;
        expect(String(createdResult.content)).toContain("Created and selected plan Slash Managed Plan");
        expect(createdStructured.selected_plan_id).toBe("slash-managed-plan");
        expect(created.selected_plan_id).toBe("slash-managed-plan");

        const status = await expectJsonOk(await fetch(`${baseUrl}/api/architect/v1/commands`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ command: "plan", args: ["status"] }),
        }));
        expect(String((status.result as Record<string, unknown>).content)).toContain("Plan Slash Managed Plan (slash-managed-plan)");

        const cleared = await expectJsonOk(await fetch(`${baseUrl}/api/architect/v1/commands`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ command: "plan", args: ["clear"] }),
        }));
        expect(cleared.selected_plan_id).toBeNull();
        expect(String((cleared.result as Record<string, unknown>).content)).toContain("Project Scope");

        const missingArchive = await fetch(`${baseUrl}/api/architect/v1/commands`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ command: "plan", args: ["archive"] }),
        });
        const missingPayload = await missingArchive.json() as Record<string, unknown>;
        expect(missingArchive.status).toBe(400);
        expect(String(missingPayload.message)).toContain("No Architect plan is selected");
      });
    } finally {
      scopeSpy.mockRestore();
      delete process.env.DREAMGRAPH_ARCHITECT_SELECTED_PLAN_ID;
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  it("handles execution control slash commands through normalized daemon state", async () => {
    const previousAdapter = process.env.DREAMGRAPH_LLM_ARCHITECT_ADAPTER;
    process.env.DREAMGRAPH_LLM_ARCHITECT_ADAPTER = "codex-cli";
    try {
      await withArchitectServer(async (baseUrl) => {
      const contract = await expectJsonOk(await fetch(`${baseUrl}/api/architect/v1`));
      const routes = contract.routes as Record<string, string>;
      const control = contract.execution_control as Record<string, unknown>;
      const capabilities = control.capabilities as Record<string, unknown>;
      expect(routes.execution_controls).toBe("POST /api/architect/v1/commands stop|pause|resume");
      expect(capabilities.stop).toBeTypeOf("boolean");
      expect(capabilities.pause).toBeTypeOf("boolean");
      expect(capabilities.resume).toBeTypeOf("boolean");
      expect(capabilities.steering).toBeTypeOf("boolean");

      const stopped = await expectJsonOk(await fetch(`${baseUrl}/api/architect/v1/commands`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ command: "stop", args: [] }),
      }));
      const result = stopped.result as Record<string, unknown>;
      expect(String(result.content)).toContain("No Architect task is currently running");
      expect(String(result.formatted_payload)).not.toContain("dg ");
      expect((result.structured as Record<string, unknown>).execution_control).toBeTruthy();

      const paused = await fetch(`${baseUrl}/api/architect/v1/commands`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ command: "pause", args: [] }),
      });
      expect(paused.status).toBe(400);
      const pausePayload = await paused.json() as Record<string, unknown>;
      expect(String(pausePayload.message)).toContain("/pause is not supported");
      });
    } finally {
      if (previousAdapter === undefined) {
        delete process.env.DREAMGRAPH_LLM_ARCHITECT_ADAPTER;
      } else {
        process.env.DREAMGRAPH_LLM_ARCHITECT_ADAPTER = previousAdapter;
      }
    }
  });

  it("serves daemon-owned terminal contract routes", async () => {
    await withArchitectServer(async (baseUrl) => {
      const response = await fetch(`${baseUrl}/api/architect`);
      const payload = await expectJsonOk(response);
      const routes = payload.routes as Record<string, string>;

      expect(routes.terminals).toBe("POST /api/architect/v1/terminals");
      expect(routes.terminal_input).toBe("POST /api/architect/v1/terminals/{terminalId}/input");
      expect(routes.terminal_rename).toBe("POST /api/architect/v1/terminals/{terminalId}/rename");
      expect(routes.terminal_close).toBe("POST /api/architect/v1/terminals/{terminalId}/close");
      expect(routes.terminal_events).toBe("GET /api/architect/v1/terminals/{terminalId}/events");
    });
  });

  it("serves repaired standalone UI affordances directly in the shell", async () => {
    await withArchitectServer(async (baseUrl) => {
      const response = await fetch(`${baseUrl}/architect`);
      expect(response.status).toBe(200);
      const html = await response.text();

      expect(html).toContain("data-architect-collapse=\"left\"");
      expect(html).toContain("data-architect-collapse=\"right\"");
      expect(html).toContain("data-architect-resize-handle=\"left\"");
      expect(html).toContain("data-architect-resize-handle=\"right\"");
      expect(html).toContain("class=\"architect-right-accordion\"");
      expect(html).toContain("id=\"architect-adapter-select\"");
      expect(html).toContain("value=\"codex-cli\"");
      expect(html).toContain("value=\"copilot-cli\"");
      expect(html).toContain("id=\"architect-provider-select\"");
      expect(html).toContain(".control-field option");
      expect(html).toContain("id=\"architect-model-input\"");
      expect(html).toContain("architectModelOptionsByProvider");
      expect(html).toContain("function renderArchitectModelOptions");
      expect(html).toContain("function persistArchitectControls");
      expect(html).toContain("function persistSelectedPlan");
      expect(html).toContain("function clearSelectedPlan");
      expect(html).toContain("function parseChatSlashOverride");
      expect(html).toContain("function parseArchitectSlashCommand");
      expect(html).toContain("function splitArchitectWords");
      expect(html).toContain("const tokens = splitArchitectWords(text.slice(1));");
      expect(html).toContain("function tryHandleSlashCommand");
      expect(html).toContain("class=\"prompt-surface\"");
      expect(html).toContain("class=\"prompt-surface-header\"");
      expect(html).toContain("class=\"scope-pill architect-welcome-reopen\"");
      expect(html).toContain("id=\"architect-welcome\"");
      expect(html).toContain("What do you want to do with this project?");
      expect(html).toContain("First artifact: ");
      expect(html).toContain("function renderArchitectWelcome");
      expect(html).toContain("function launchArchitectMission");
      expect(html).toContain("function ensureDaemonPlanForMission");
      expect(html).toContain("Run the governed ' + check.action.target + ' action");
      expect(html).toContain("id=\"architect-welcome-reopen\"");
      expect(html).toContain("id=\"chat-scope-pill\"");
      expect(html).toContain("id=\"chat-attachment-button\"");
      expect(html).toContain("id=\"chat-attachment-input\"");
      expect((html.match(/chatInputEl\.addEventListener\('paste'/g) || []).length).toBe(1);
      expect(html).toContain("const files = Array.from((event.clipboardData && event.clipboardData.files) || []).filter(function(file) {");
      expect(html).toContain("🌍 Project");
      expect(html).toContain("Messages will use project-wide context");
      expect(html).toContain("📍 Plan: ");
      expect(html).toContain("Messages are bound to selected plan");
      expect(html).toContain("chat_scope: dispatchScope");
      expect(html).toContain("Plan scope active");
      expect(html).toContain("DREAMGRAPH_ARCHITECT_SELECTED_PLAN_ID");
      expect(html).toContain("/api/architect/v1/selection");
      expect(html).toContain("function updateActiveArchitectRuntime");
      expect(html).toContain("architectRuntimeLabel(runtime)");
      expect(html).toContain("/api/architect/v1/config");
      expect(html).toContain("engine.env updated");
      expect(html).toContain("id=\"architect-autonomy-mode-select\"");
      expect(html).toContain("function renderChatContent");
      expect(html).toContain("function appendTextWithAdrPreviews");
      expect(html).toContain("function loadAdrPreview");
      expect(html).toContain("createAdrEditIconButton");
      expect(html).toContain("/api/architect/v1/adrs/");
      expect(html).toContain("/api/architect/v1/commands");
      expect(html).toContain("id=\"adr-editor\"");
      expect(html).toContain("ADR Editor");
      expect(html).toContain("class=\"architect-center-tabs\"");
      expect(html).toContain("id=\"architect-tab-add\"");
      expect(html).toContain("id=\"architect-tab-menu\"");
      expect(html).toContain("function registerArchitectTabType");
      expect(html).toContain("function createBuiltInArchitectTab");
      expect(html).toContain("function renderArchitectCenterTabs");
      expect(html).toContain("function createTerminalArchitectTab");
      expect(html).toContain("New Terminal");
      expect(html).toContain("function renderTerminalArchitectTabPanel");
      expect(html).toContain("/api/architect/v1/terminals");
      expect(html).toContain("function suspendArchitectDoomTab() {}");
      expect(html).toContain("function resumeArchitectDoomTab() {}");
      expect(html).not.toContain("function createDoomArchitectTab");
      expect(html).not.toContain("function renderDoomArchitectTabPanel");
      expect(html).not.toContain("New Doom Session");
      expect(html).not.toContain("Doom Shareware");
      expect(html).not.toContain(".doom-first-run-card");
      expect(html).not.toContain("/api/architect/v1/assets/js-dos/");
      expect(html).toContain("Terminal output is local convenience output, not daemon payload authority.");
      expect(html).toContain("terminal-console");
      expect(html).toContain("const activePanel = architectCenterPanelContainer.querySelector('[data-architect-tab-panel]:not([hidden])');");
      expect(html).toContain("const activeTabId = activePanel ? activePanel.dataset.architectTabPanel : tab.id;");
      expect(html).not.toContain("commandHistory");
      expect(html).not.toContain("send.textContent = 'Send'");
      expect(html).toContain("data-architect-tab-panel=\"chat\"");
      expect(html).toContain("data-architect-tab-panel=\"plan\"");
      expect(html).toContain("data-architect-tab-panel=\"adr\"");
      expect(html).toContain("function resolveArchitectCenterTab");
      expect(html).toContain("return architectCenterTabs.some");
      expect(html).toContain("/status - Show the status of the current instance");
      expect(html).toContain("/stop - Stop a running Architect task when supported");
      expect(html).toContain("id=\"chat-pause\"");
      expect(html).toContain("id=\"chat-stop\"");
      expect(html).toContain("function activeExecutionCapabilities");
      expect(html).toContain("Current runtime does not support steering while running.");
      expect(html).toContain("architect.execution_control");
      expect(html).toContain("formatted_payload");
      expect(html).toContain("Slash command validation failed.");
      expect(html).toContain("title=\"Collapse context sidebar\">></button>");
      expect(html).toContain("function hydrateArchitectCenterTabs");
      expect(html).toContain("center-plan-body");
      expect(html).not.toContain("Dedicated editor is available in the center ADR Editor tab.");
      expect(html).toContain("function openAdrEditor");
      expect(html).toContain("function submitAdrEditProposal");
      expect(html).toContain("proposal_only");
      expect(html).toContain("adr-preview-trigger");
      expect(html).toContain("daemon-governed ADR preview on hover or focus");
      expect(html).toContain("function appendToolTraceMessage");
      expect(html).toContain("function renderToolTraceRow");
      expect(html).toContain("architect.tool_result");
      expect(html).toContain("semanticToolArgSummary");
      expect(html).toContain("tool-trace-panel");
      expect(html).not.toContain("appendEventLine('[tool-trace]");
      expect(html).toContain("Lifecycle");
      expect(html).toContain("Next slice");
      expect(html).toContain("function renderEventLine");
      expect(html).toContain("activePlanLoadToken");
      expect(html).toContain("const label = String(candidate.label || candidate.id || 'candidate');");
      expect(html).toContain("No plan selected. Project-scope chat remains available.");
      expect(html).toContain("if (activePlanId === plan.id)");
      expect(html).not.toContain("await loadPlan(firstPlanId, firstButton)");
      expect(html).toContain("button.plan-item {\n      display: flex;");
      expect(html).toContain("flex-direction: column;");
      expect(html).toContain("align-items: stretch;");
      expect(html).toContain("min-height: unset;");
      expect(html).toContain("button.plan-item .plan-title");
      expect(html).toContain("-webkit-line-clamp: 2;");
      expect(html).toContain("button.plan-item .plan-meta");
      expect(html).toContain("font-size: 0.62rem;");
      expect(html).toContain("meta.className = 'plan-meta'");
      expect(html).toContain("title.className = 'plan-title'");
    });
  });

  it("keeps Doom routes and assets absent unless explicitly configured", async () => {
    const previous = process.env.DREAMGRAPH_ENABLE_DOOM;
    delete process.env.DREAMGRAPH_ENABLE_DOOM;
    try {
      await withArchitectServer(async (baseUrl) => {
        const contract = await expectJsonOk(await fetch(`${baseUrl}/api/architect/v1`));
        const routes = contract.routes as Record<string, string>;
        expect(routes.doom_spike_harness).toBeUndefined();
        expect(routes.doom_spike_bundle_status).toBeUndefined();
        expect(routes.doom_spike_bundle_acquire).toBeUndefined();
        expect(routes.doom_spike_bundle).toBeUndefined();
        expect((await fetch(`${baseUrl}/architect/doom-spike`)).status).toBe(404);
        expect((await fetch(`${baseUrl}/api/architect/v1/assets/js-dos/js-dos.js`)).status).toBe(404);
        expect((await fetch(`${baseUrl}/api/architect/v1/doom/spike-bundle/status`)).status).toBe(404);
      });
    } finally {
      if (previous === undefined) delete process.env.DREAMGRAPH_ENABLE_DOOM;
      else process.env.DREAMGRAPH_ENABLE_DOOM = previous;
    }
  });

  it("enables Doom tab registration only when explicitly configured", async () => {
    const previous = process.env.DREAMGRAPH_ENABLE_DOOM;
    process.env.DREAMGRAPH_ENABLE_DOOM = "true";
    try {
      await withArchitectServer(async (baseUrl) => {
        const response = await fetch(`${baseUrl}/architect`);
        expect(response.status).toBe(200);
        const html = await response.text();
        expect(html).toContain("function createDoomArchitectTab");
        expect(html).toContain("function renderDoomArchitectTabPanel");
        expect(html).toContain("registerArchitectTabType({ type: 'doom', title: 'New Doom Session', create: createDoomArchitectTab });");
        expect(html).toContain("pathPrefix: '/api/architect/v1/assets/js-dos/emulators/'");
      });
    } finally {
      if (previous === undefined) delete process.env.DREAMGRAPH_ENABLE_DOOM;
      else process.env.DREAMGRAPH_ENABLE_DOOM = previous;
    }
  });
});
