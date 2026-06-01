import { existsSync, statSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { basename, resolve } from "node:path";
import { config } from "../config/config.js";
import { getActiveScope } from "../instance/lifecycle.js";
import type { InstanceMcpConfig } from "../instance/types.js";
import { atomicWriteFile } from "../utils/atomic-write.js";
import { stripBom } from "../utils/read-json.js";
import { buildOnboardingReadinessProjection, type ProjectMapStatus } from "./onboarding-readiness.js";

export const REPOSITORY_ROLES = ["primary", "frontend", "backend", "shared", "docs", "infra", "other"] as const;
export type RepositoryRole = typeof REPOSITORY_ROLES[number];

export interface ArchitectRepoSetupEntry {
  name: string;
  path: string;
  role: RepositoryRole;
}

export interface ArchitectRepoSetupProjection {
  contract_version: "v1";
  source: "daemon_governed_repo_setup";
  persisted: boolean;
  mode: "single_repo" | "multi_repo";
  scope_explanation: string;
  repositories: ArchitectRepoSetupEntry[];
  available_roles: readonly RepositoryRole[];
  project_map: { status: ProjectMapStatus; last_refreshed_at: string | null };
  first_map_action: { kind: "run_governed_tool"; target: "scan_project"; label: string };
}

export class ArchitectRepoSetupError extends Error {
  constructor(readonly code: string, message: string, readonly status = 400) {
    super(message);
  }
}

function fallbackRole(index: number): RepositoryRole {
  return index === 0 ? "primary" : "other";
}

function normalizePath(path: string): string {
  const normalized = resolve(path);
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

function validateName(value: unknown, index: number): string {
  const name = typeof value === "string" ? value.trim() : "";
  if (!name) throw new ArchitectRepoSetupError("invalid_repository_name", `Repository ${index + 1} needs a name.`);
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name)) {
    throw new ArchitectRepoSetupError("invalid_repository_name", `Repository name '${name}' must use letters, numbers, dot, underscore, or dash.`);
  }
  return name;
}

function validatePath(value: unknown, index: number): string {
  const path = typeof value === "string" ? resolve(value.trim()) : "";
  if (!path || !existsSync(path)) throw new ArchitectRepoSetupError("invalid_repository_path", `Repository ${index + 1} path does not exist.`);
  if (!statSync(path).isDirectory()) throw new ArchitectRepoSetupError("invalid_repository_path", `Repository ${index + 1} path must be a directory.`);
  return path;
}

function validateRole(value: unknown, index: number): RepositoryRole {
  const role = typeof value === "string" ? value.trim() : "";
  if (!REPOSITORY_ROLES.includes(role as RepositoryRole)) {
    throw new ArchitectRepoSetupError("invalid_repository_role", `Repository ${index + 1} needs a valid role label.`);
  }
  return role as RepositoryRole;
}

export function validateArchitectRepoSetupEntries(value: unknown): ArchitectRepoSetupEntry[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new ArchitectRepoSetupError("repositories_required", "Connect at least one repository.");
  }
  if (value.length > 24) throw new ArchitectRepoSetupError("too_many_repositories", "Connect at most 24 repositories at a time.");

  const names = new Set<string>();
  const paths = new Set<string>();
  return value.map((candidate, index) => {
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) {
      throw new ArchitectRepoSetupError("invalid_repository", `Repository ${index + 1} must be an object.`);
    }
    const record = candidate as Record<string, unknown>;
    const entry = { name: validateName(record.name, index), path: validatePath(record.path, index), role: validateRole(record.role, index) };
    const comparableName = entry.name.toLowerCase();
    const comparablePath = normalizePath(entry.path);
    if (names.has(comparableName)) throw new ArchitectRepoSetupError("duplicate_repository_name", `Repository name '${entry.name}' is duplicated.`);
    if (paths.has(comparablePath)) throw new ArchitectRepoSetupError("duplicate_repository_path", `Repository path '${entry.path}' is duplicated.`);
    names.add(comparableName);
    paths.add(comparablePath);
    return entry;
  });
}

async function readPersistedConfig(): Promise<InstanceMcpConfig | null> {
  const scope = getActiveScope();
  if (!scope) return null;
  const raw = stripBom(await readFile(resolve(scope.configDir, "mcp.json"), "utf-8"));
  return JSON.parse(raw) as InstanceMcpConfig;
}

export async function buildArchitectRepoSetupProjection(): Promise<ArchitectRepoSetupProjection> {
  const scope = getActiveScope();
  let persistedConfig: InstanceMcpConfig | null = null;
  try { persistedConfig = await readPersistedConfig(); } catch { /* runtime projection remains available */ }
  const repos = scope?.repos ?? config.repos;
  const roles = persistedConfig?.repository_roles ?? {};
  const repositories = Object.entries(repos)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([name, path], index) => ({ name, path: resolve(path), role: roles[name] ?? fallbackRole(index) }));
  const readiness = buildOnboardingReadinessProjection();
  return {
    contract_version: "v1",
    source: "daemon_governed_repo_setup",
    persisted: Boolean(scope),
    mode: repositories.length > 1 ? "multi_repo" : "single_repo",
    scope_explanation: "Repositories define the project scope Architect may inspect through DreamGraph MCP. The first repository is usually the primary application; add related services only when cross-repo work needs them.",
    repositories,
    available_roles: REPOSITORY_ROLES,
    project_map: { status: readiness.project_map.status, last_refreshed_at: readiness.project_map.last_refreshed_at },
    first_map_action: { kind: "run_governed_tool", target: "scan_project", label: readiness.project_map.status === "not_built" ? "Build first project map" : "Refresh project map" },
  };
}

export async function persistArchitectRepoSetup(value: unknown): Promise<ArchitectRepoSetupProjection> {
  const scope = getActiveScope();
  if (!scope) throw new ArchitectRepoSetupError("instance_required", "Repository setup persistence requires an attached DreamGraph instance.", 409);
  const entries = validateArchitectRepoSetupEntries(value);
  const current = await readPersistedConfig();
  if (!current) throw new ArchitectRepoSetupError("instance_config_missing", "The active instance is missing config/mcp.json.", 409);
  current.repos = Object.fromEntries(entries.map((entry) => [entry.name, entry.path]));
  current.repository_roles = Object.fromEntries(entries.map((entry) => [entry.name, entry.role]));
  await atomicWriteFile(resolve(scope.configDir, "mcp.json"), JSON.stringify(current, null, 2));
  for (const key of Object.keys(config.repos)) delete config.repos[key];
  Object.assign(config.repos, current.repos);
  scope.repos = { ...current.repos };
  return buildArchitectRepoSetupProjection();
}
