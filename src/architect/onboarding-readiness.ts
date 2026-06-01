import { existsSync, readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { getArchitectLlmConfig } from "../cognitive/llm.js";
import { config } from "../config/config.js";
import { getActiveScope } from "../instance/lifecycle.js";

const STALE_GRAPH_AFTER_MS = 24 * 60 * 60 * 1_000;

export type OnboardingReadinessStatus = "ready" | "needs_attention" | "useful_later";
export type ProjectMapStatus = "not_built" | "learning" | "ready" | "stale";

export interface OnboardingReadinessCheck {
  id: string;
  label: string;
  status: OnboardingReadinessStatus;
  detail: string;
  action: OnboardingReadinessAction | null;
}

export interface OnboardingReadinessAction {
  id: string;
  label: string;
  kind: "open_route" | "run_governed_tool";
  target: string;
}

export interface ArchitectReadinessRuntime {
  adapter: string;
  provider: string;
  model: string;
}

export interface OnboardingReadinessProjection {
  contract_version: "v1";
  source: "daemon_onboarding_readiness_projection";
  service: { status: "ready" };
  project: { status: "attached" | "choose_project"; instance_id: string | null; instance_name: string | null; project_root: string | null };
  repositories: { count: number; names: string[] };
  project_map: { status: ProjectMapStatus; last_refreshed_at: string | null; node_count: number; edge_count: number };
  architect_runtime: { status: "ready" | "choose_runtime"; adapter: string; provider: string; model: string };
  required_to_start: OnboardingReadinessCheck[];
  useful_later: OnboardingReadinessCheck[];
  suggested_next_action: OnboardingReadinessAction;
}

function action(id: string, label: string, kind: OnboardingReadinessAction["kind"], target: string): OnboardingReadinessAction {
  return { id, label, kind, target };
}

function readProjectMap(dataDir: string): OnboardingReadinessProjection["project_map"] {
  const graphPath = resolve(dataDir, "dream_graph.json");
  if (!existsSync(graphPath)) {
    return { status: "not_built", last_refreshed_at: null, node_count: 0, edge_count: 0 };
  }

  try {
    const graph = JSON.parse(readFileSync(graphPath, "utf8")) as { nodes?: unknown[]; edges?: unknown[] };
    const graphStat = statSync(graphPath);
    const nodeCount = Array.isArray(graph.nodes) ? graph.nodes.length : 0;
    const edgeCount = Array.isArray(graph.edges) ? graph.edges.length : 0;
    const status: ProjectMapStatus = nodeCount + edgeCount === 0
      ? "learning"
      : Date.now() - graphStat.mtimeMs > STALE_GRAPH_AFTER_MS
        ? "stale"
        : "ready";
    return { status, last_refreshed_at: graphStat.mtime.toISOString(), node_count: nodeCount, edge_count: edgeCount };
  } catch {
    return { status: "not_built", last_refreshed_at: null, node_count: 0, edge_count: 0 };
  }
}

function configuredArchitectRuntime(): ArchitectReadinessRuntime {
  const architect = getArchitectLlmConfig();
  return {
    adapter: process.env.DREAMGRAPH_LLM_ARCHITECT_ADAPTER || "native_api_tool_loop",
    provider: architect.provider,
    model: architect.model,
  };
}

function isArchitectRuntimeReady(runtime: ArchitectReadinessRuntime): boolean {
  if (runtime.adapter === "deterministic_fallback") return true;
  if (runtime.adapter === "codex-cli" || runtime.adapter === "copilot-cli") return true;
  return runtime.provider !== "none" && runtime.model.trim().length > 0;
}

export function buildOnboardingReadinessProjection(runtime: ArchitectReadinessRuntime = configuredArchitectRuntime()): OnboardingReadinessProjection {
  const scope = getActiveScope();
  const repos = scope?.repos ?? config.repos;
  const repositoryNames = Object.keys(repos).sort();
  const map = readProjectMap(scope?.dataDir ?? config.dataDir);
  const projectAttached = Boolean(scope?.projectRoot);
  const repositoriesConnected = repositoryNames.length > 0;
  const runtimeReady = isArchitectRuntimeReady(runtime);
  const mapExists = map.status !== "not_built";

  const requiredToStart: OnboardingReadinessCheck[] = [
    { id: "service", label: "DreamGraph is running", status: "ready", detail: "The daemon is serving this readiness contract.", action: null },
    { id: "project", label: "A project is attached", status: projectAttached ? "ready" : "needs_attention", detail: projectAttached ? "The active instance has a project root." : "Choose a project before Architect starts project work.", action: projectAttached ? null : action("choose_project", "Choose a project", "open_route", "/config") },
    { id: "project_map", label: "The project map exists", status: mapExists ? "ready" : "needs_attention", detail: mapExists ? `Project map status: ${map.status}.` : "Build the first project map so Architect has repository context.", action: mapExists ? null : action("build_project_map", "Build project map", "run_governed_tool", "scan_project") },
    { id: "architect_runtime", label: "Architect can answer", status: runtimeReady ? "ready" : "needs_attention", detail: runtimeReady ? `Architect runtime: ${runtime.adapter}.` : "Choose how Architect should run.", action: runtimeReady ? null : action("choose_architect_runtime", "Choose how Architect runs", "open_route", "/config") },
    { id: "repositories", label: "Repositories are connected", status: repositoriesConnected ? "ready" : "needs_attention", detail: repositoriesConnected ? `${repositoryNames.length} repository connection(s) available.` : "Connect at least one repository for project work.", action: repositoriesConnected ? null : action("connect_repository", "Connect a repository", "open_route", "/config") },
  ];

  const usefulLater: OnboardingReadinessCheck[] = [
    { id: "recurring_review", label: "Optional recurring review", status: "useful_later", detail: "Set up a weekly review after the first useful result.", action: action("setup_weekly_review", "Set up weekly review", "open_route", "/schedules") },
  ];

  const suggestedNextAction = requiredToStart.find((check) => check.status === "needs_attention")?.action
    ?? action("open_architect", "Open Architect", "open_route", "/architect");

  return {
    contract_version: "v1",
    source: "daemon_onboarding_readiness_projection",
    service: { status: "ready" },
    project: { status: projectAttached ? "attached" : "choose_project", instance_id: scope?.uuid ?? null, instance_name: scope?.name ?? null, project_root: scope?.projectRoot ?? null },
    repositories: { count: repositoryNames.length, names: repositoryNames },
    project_map: map,
    architect_runtime: { status: runtimeReady ? "ready" : "choose_runtime", ...runtime },
    required_to_start: requiredToStart,
    useful_later: usefulLater,
    suggested_next_action: suggestedNextAction,
  };
}
