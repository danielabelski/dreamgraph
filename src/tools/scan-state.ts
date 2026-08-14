import { createHash, randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

import ignore, { type Ignore } from "ignore";

import { atomicWriteFile } from "../utils/atomic-write.js";
import { dataPath, getDataDir } from "../utils/paths.js";
import { shouldSkipScanDirectory } from "./scanner-artifact-policy.js";

const execFileAsync = promisify(execFile);

export const SCAN_STATE_SCHEMA = "dreamgraph.scan_state.v1" as const;
export const SCAN_STATE_SCHEMA_VERSION = "1.0.0" as const;
export const SCANNER_CONTRACT_VERSION = "1.0.0" as const;
export const SCAN_STATE_FILE = "scan_state.json";

export type ScanOperation = "full" | "incremental";
export type ScanDepth = "shallow" | "deep";
export type ScanTarget = "features" | "workflows" | "data_model" | "ui";

export interface ScanFileEvidence {
  path: string;
  size: number;
  content_hash: string;
}

export interface ScanGitBasis {
  available: boolean;
  head: string | null;
  branch: string | null;
  dirty: boolean;
  staged: number;
  unstaged: number;
  untracked: number;
}

export interface RepositoryScanSnapshot {
  repo_name: string;
  root_fingerprint: string;
  ignore_rules_fingerprint: string;
  git: ScanGitBasis;
  files: Record<string, ScanFileEvidence>;
}

export interface ScanState {
  schema: typeof SCAN_STATE_SCHEMA;
  schema_version: typeof SCAN_STATE_SCHEMA_VERSION;
  scanner_contract_version: typeof SCANNER_CONTRACT_VERSION;
  ontology_version: "1";
  instance_id: string;
  repository_set_fingerprint: string;
  committed_revision: string;
  committed_at: string;
  previous_revision: string | null;
  operation: ScanOperation;
  depth: ScanDepth;
  targets_covered: ScanTarget[];
  repos: Record<string, RepositoryScanSnapshot>;
  transaction_id: string;
  status: "committed";
  /** Stable source-structural claims captured by the committed scan. */
  evidence_ledger?: StructuralEvidenceLedger;
}

export type EvidenceTarget = "features" | "workflows" | "data_model" | "ui" | "auxiliary";
export type EvidenceLifecycle = "active" | "stale_candidate" | "deprecated" | "orphaned" | "purge_eligible";

export interface StructuralEvidenceSupport {
  repo: string;
  path: string;
  content_hash: string;
}

export interface StructuralEvidenceClaim {
  claim_id: string;
  semantic_key: string;
  legacy_entity_id: string;
  target: EvidenceTarget;
  kind: string;
  structural_fingerprint: string;
  materiality_fingerprint: string;
  supports: StructuralEvidenceSupport[];
  lifecycle: EvidenceLifecycle;
}

export interface StructuralEvidenceLedger {
  schema: "dreamgraph.structural_evidence.v1";
  revision: string;
  claims: Record<string, StructuralEvidenceClaim>;
}

export type BaselineStatus = "compatible" | "missing" | "corrupt" | "incompatible";

export interface FileRename {
  from: string;
  to: string;
  content_hash: string;
}

export interface RepositoryDelta {
  repo_name: string;
  added: string[];
  modified: string[];
  deleted: string[];
  renamed: FileRename[];
  unchanged: string[];
  ignore_rules_changed: boolean;
  git_basis_changed: boolean;
}

export interface ScanDeltaPreview {
  schema: "dreamgraph.scan_delta.v1";
  mode: "incremental";
  dry_run: true;
  baseline_status: BaselineStatus;
  baseline_revision: string | null;
  full_scan_required: boolean;
  reason?: string;
  repositories: RepositoryDelta[];
  metrics: {
    repositories_considered: number;
    files_discovered: number;
    files_added: number;
    files_modified: number;
    files_deleted: number;
    files_renamed: number;
    files_unchanged: number;
    parser_invocations: 0;
    graph_writes: 0;
  };
}

async function loadIgnoreMatcher(repoRoot: string): Promise<{ matcher: Ignore | null; fingerprint: string }> {
  const ruleFiles: Array<{ rel: string; content: string }> = [];
  async function collect(dir: string): Promise<void> {
    let entries: import("node:fs").Dirent[];
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const abs = path.join(dir, entry.name);
      const rel = path.relative(repoRoot, abs).replace(/\\/g, "/");
      if (entry.isDirectory()) {
        if (!shouldSkipScanDirectory({ repoRoot, absDir: abs, entryName: entry.name })) await collect(abs);
      } else if (entry.isFile() && entry.name === ".gitignore") {
        try { ruleFiles.push({ rel, content: await fs.readFile(abs, "utf-8") }); } catch { /* unreadable rules are ignored */ }
      }
    }
  }
  await collect(repoRoot);
  ruleFiles.sort((a, b) => a.rel.localeCompare(b.rel));
  const fingerprint = hash(ruleFiles.map((entry) => `${entry.rel}\0${entry.content}`).join("\0"));
  if (ruleFiles.length === 0) return { matcher: null, fingerprint };
  const matcher = ignore();
  for (const ruleFile of ruleFiles) {
    const base = path.posix.dirname(ruleFile.rel);
    const prefix = base === "." ? "" : `${base}/`;
    matcher.add(ruleFile.content.split(/\r?\n/).map((line) => {
      if (!line || line.startsWith("#")) return line;
      const negated = line.startsWith("!");
      const rule = negated ? line.slice(1) : line;
      const rooted = rule.startsWith("/") ? rule.slice(1) : rule;
      return `${negated ? "!" : ""}${prefix}${rooted}`;
    }));
  }
  return { matcher, fingerprint };
}

function hash(value: string | Buffer): string {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

async function captureGitBasis(repoRoot: string): Promise<ScanGitBasis> {
  try {
    const [{ stdout: headOut }, { stdout: branchOut }, { stdout: statusOut }] = await Promise.all([
      execFileAsync("git", ["-C", repoRoot, "rev-parse", "HEAD"], { timeout: 5_000, windowsHide: true }),
      execFileAsync("git", ["-C", repoRoot, "branch", "--show-current"], { timeout: 5_000, windowsHide: true }),
      execFileAsync("git", ["-C", repoRoot, "status", "--porcelain=v1", "--untracked-files=all"], { timeout: 10_000, windowsHide: true }),
    ]);
    const lines = statusOut.split(/\r?\n/).filter(Boolean);
    return {
      available: true,
      head: headOut.trim() || null,
      branch: branchOut.trim() || null,
      dirty: lines.length > 0,
      staged: lines.filter((line) => line[0] !== " " && line[0] !== "?").length,
      unstaged: lines.filter((line) => line[1] !== " " && line[1] !== "?").length,
      untracked: lines.filter((line) => line.startsWith("??")).length,
    };
  } catch {
    return { available: false, head: null, branch: null, dirty: false, staged: 0, unstaged: 0, untracked: 0 };
  }
}

export async function captureRepositorySnapshot(repoName: string, repoRoot: string, depth: ScanDepth): Promise<RepositoryScanSnapshot> {
  const resolvedRoot = path.resolve(repoRoot);
  const maxDepth = depth === "shallow" ? 3 : 10;
  const { matcher, fingerprint } = await loadIgnoreMatcher(resolvedRoot);
  const files: Record<string, ScanFileEvidence> = {};

  async function walk(dir: string, currentDepth: number): Promise<void> {
    if (currentDepth > maxDepth) return;
    let entries: import("node:fs").Dirent[];
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      const abs = path.join(dir, entry.name);
      const rel = path.relative(resolvedRoot, abs).replace(/\\/g, "/");
      if (entry.isDirectory()) {
        if (matcher?.ignores(`${rel}/`) || shouldSkipScanDirectory({ repoRoot: resolvedRoot, absDir: abs, entryName: entry.name })) continue;
        await walk(abs, currentDepth + 1);
      } else if (entry.isFile()) {
        if (matcher?.ignores(rel)) continue;
        try {
          const content = await fs.readFile(abs);
          files[rel] = { path: rel, size: content.byteLength, content_hash: hash(content) };
        } catch { /* files may disappear during preview; next preview will reconcile */ }
      }
    }
  }

  await walk(resolvedRoot, 0);
  return {
    repo_name: repoName,
    root_fingerprint: hash(resolvedRoot.replace(/\\/g, "/").toLowerCase()),
    ignore_rules_fingerprint: fingerprint,
    git: await captureGitBasis(resolvedRoot),
    files,
  };
}

export async function buildScanState(input: {
  repos: Record<string, string>;
  depth: ScanDepth;
  targets: ScanTarget[];
  operation: ScanOperation;
  previous?: ScanState | null;
}): Promise<ScanState> {
  const names = Object.keys(input.repos).sort();
  const snapshots = await Promise.all(names.map((name) => captureRepositorySnapshot(name, input.repos[name], input.depth)));
  const repos = Object.fromEntries(snapshots.map((snapshot) => [snapshot.repo_name, snapshot]));
  const revisionMaterial = JSON.stringify({ depth: input.depth, targets: [...input.targets].sort(), repos });
  return {
    schema: SCAN_STATE_SCHEMA,
    schema_version: SCAN_STATE_SCHEMA_VERSION,
    scanner_contract_version: SCANNER_CONTRACT_VERSION,
    ontology_version: "1",
    instance_id: path.basename(getDataDir()),
    repository_set_fingerprint: hash(names.map((name) => `${name}\0${repos[name].root_fingerprint}`).join("\0")),
    committed_revision: hash(revisionMaterial),
    committed_at: new Date().toISOString(),
    previous_revision: input.previous?.committed_revision ?? null,
    operation: input.operation,
    depth: input.depth,
    targets_covered: [...input.targets],
    repos,
    transaction_id: randomUUID(),
    status: "committed",
  };
}

export async function loadScanState(): Promise<{ status: BaselineStatus; state: ScanState | null; reason?: string }> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(await fs.readFile(dataPath(SCAN_STATE_FILE), "utf-8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { status: "missing", state: null, reason: "No committed scan-state baseline exists." };
    return { status: "corrupt", state: null, reason: "The scan-state baseline is unreadable or invalid JSON." };
  }
  if (!parsed || typeof parsed !== "object") return { status: "corrupt", state: null, reason: "The scan-state baseline is not an object." };
  const candidate = parsed as Partial<ScanState>;
  if (candidate.schema !== SCAN_STATE_SCHEMA || candidate.schema_version !== SCAN_STATE_SCHEMA_VERSION || candidate.scanner_contract_version !== SCANNER_CONTRACT_VERSION) {
    return { status: "incompatible", state: null, reason: "The scan-state schema or scanner contract version is incompatible." };
  }
  return { status: "compatible", state: candidate as ScanState };
}

export async function commitScanState(state: ScanState): Promise<void> {
  await atomicWriteFile(dataPath(SCAN_STATE_FILE), JSON.stringify(state, null, 2));
}

function classifyRepository(previous: RepositoryScanSnapshot, current: RepositoryScanSnapshot): RepositoryDelta {
  const added = Object.keys(current.files).filter((file) => !previous.files[file]).sort();
  const deleted = Object.keys(previous.files).filter((file) => !current.files[file]).sort();
  const modified = Object.keys(current.files).filter((file) => previous.files[file] && previous.files[file].content_hash !== current.files[file].content_hash).sort();
  const unchanged = Object.keys(current.files).filter((file) => previous.files[file]?.content_hash === current.files[file].content_hash).sort();
  const renamed: FileRename[] = [];
  const addedByHash = new Map<string, string[]>();
  const deletedByHash = new Map<string, string[]>();
  for (const file of added) {
    const list = addedByHash.get(current.files[file].content_hash) ?? [];
    list.push(file);
    addedByHash.set(current.files[file].content_hash, list);
  }
  for (const file of deleted) {
    const list = deletedByHash.get(previous.files[file].content_hash) ?? [];
    list.push(file);
    deletedByHash.set(previous.files[file].content_hash, list);
  }
  for (const from of [...deleted]) {
    const contentHash = previous.files[from].content_hash;
    const candidates = addedByHash.get(contentHash) ?? [];
    const sources = deletedByHash.get(contentHash) ?? [];
    // Continuity is safe only for a one-to-one content match. Any duplicate
    // source or destination makes identity path-sensitive and therefore
    // remains an explicit add/delete pair for conservative reconciliation.
    if (candidates.length !== 1 || sources.length !== 1) continue;
    const to = candidates[0];
    renamed.push({ from, to, content_hash: contentHash });
    added.splice(added.indexOf(to), 1);
    deleted.splice(deleted.indexOf(from), 1);
  }
  return {
    repo_name: current.repo_name,
    added,
    modified,
    deleted,
    renamed: renamed.sort((a, b) => a.from.localeCompare(b.from)),
    unchanged,
    ignore_rules_changed: previous.ignore_rules_fingerprint !== current.ignore_rules_fingerprint,
    git_basis_changed: previous.git.head !== current.git.head || previous.git.branch !== current.git.branch || previous.git.dirty !== current.git.dirty,
  };
}

export async function previewIncrementalScan(input: {
  repos: Record<string, string>;
  depth: ScanDepth;
  targets: ScanTarget[];
  baseline?: ScanState;
}): Promise<ScanDeltaPreview> {
  const baseline = input.baseline
    ? { status: "compatible" as const, state: input.baseline }
    : await loadScanState();
  if (baseline.status !== "compatible" || !baseline.state) {
    return {
      schema: "dreamgraph.scan_delta.v1", mode: "incremental", dry_run: true,
      baseline_status: baseline.status, baseline_revision: null, full_scan_required: true, reason: baseline.reason,
      repositories: [],
      metrics: { repositories_considered: Object.keys(input.repos).length, files_discovered: 0, files_added: 0, files_modified: 0, files_deleted: 0, files_renamed: 0, files_unchanged: 0, parser_invocations: 0, graph_writes: 0 },
    };
  }
  const current = await buildScanState({ ...input, operation: "incremental", previous: baseline.state });
  const incompatibleReason =
    baseline.state.depth !== input.depth ? "Requested scan depth differs from the committed baseline." :
    input.targets.some((target) => !baseline.state!.targets_covered.includes(target)) ? "Requested targets are not covered by the committed baseline." :
    current.repository_set_fingerprint !== baseline.state.repository_set_fingerprint ? "Configured repository set differs from the committed baseline." :
    undefined;
  if (incompatibleReason) {
    return {
      schema: "dreamgraph.scan_delta.v1", mode: "incremental", dry_run: true,
      baseline_status: "incompatible", baseline_revision: baseline.state.committed_revision, full_scan_required: true, reason: incompatibleReason,
      repositories: [],
      metrics: { repositories_considered: Object.keys(input.repos).length, files_discovered: 0, files_added: 0, files_modified: 0, files_deleted: 0, files_renamed: 0, files_unchanged: 0, parser_invocations: 0, graph_writes: 0 },
    };
  }
  const repositories = Object.keys(current.repos).sort().map((name) => classifyRepository(baseline.state!.repos[name], current.repos[name]));
  return {
    schema: "dreamgraph.scan_delta.v1", mode: "incremental", dry_run: true,
    baseline_status: "compatible", baseline_revision: baseline.state.committed_revision, full_scan_required: false,
    repositories,
    metrics: {
      repositories_considered: repositories.length,
      files_discovered: repositories.reduce((sum, repo) => sum + repo.added.length + repo.modified.length + repo.renamed.length + repo.unchanged.length, 0),
      files_added: repositories.reduce((sum, repo) => sum + repo.added.length, 0),
      files_modified: repositories.reduce((sum, repo) => sum + repo.modified.length, 0),
      files_deleted: repositories.reduce((sum, repo) => sum + repo.deleted.length, 0),
      files_renamed: repositories.reduce((sum, repo) => sum + repo.renamed.length, 0),
      files_unchanged: repositories.reduce((sum, repo) => sum + repo.unchanged.length, 0),
      parser_invocations: 0,
      graph_writes: 0,
    },
  };
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    const obj = value as Record<string, unknown>;
    return `{${Object.keys(obj).sort().map((key) => `${JSON.stringify(key)}:${stableJson(obj[key])}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "undefined";
}

export function normalizeSemanticKey(input: { repo: string; target: EvidenceTarget; kind: string; name: string }): string {
  const normalizedName = input.name.normalize("NFKC").trim().toLowerCase()
    .replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
  return `${input.repo.toLowerCase()}:${input.target}:${input.kind.toLowerCase()}:${normalizedName}`;
}

export function buildStructuralClaim(input: {
  repo: string;
  target: EvidenceTarget;
  kind: string;
  name: string;
  legacy_entity_id: string;
  structural: unknown;
  material: unknown;
  supports: StructuralEvidenceSupport[];
}): StructuralEvidenceClaim {
  const semantic_key = normalizeSemanticKey(input);
  const supports = [...input.supports].sort((a, b) => `${a.repo}:${a.path}`.localeCompare(`${b.repo}:${b.path}`));
  return {
    claim_id: hash(`${semantic_key}\0${input.legacy_entity_id}`),
    semantic_key,
    legacy_entity_id: input.legacy_entity_id,
    target: input.target,
    kind: input.kind,
    structural_fingerprint: hash(stableJson(input.structural)),
    materiality_fingerprint: hash(stableJson(input.material)),
    supports,
    lifecycle: supports.length > 0 ? "active" : "orphaned",
  };
}

export function reconcileStructuralLedger(
  previous: StructuralEvidenceLedger | undefined,
  incoming: StructuralEvidenceClaim[],
  revision: string,
): StructuralEvidenceLedger {
  const claims: Record<string, StructuralEvidenceClaim> = {};
  for (const claim of incoming) {
    const existing = claims[claim.claim_id];
    if (!existing) claims[claim.claim_id] = claim;
    else {
      const supports = new Map(
        [...existing.supports, ...claim.supports]
          .map((support) => [`${support.repo}:${support.path}:${support.content_hash}`, support]),
      );
      claims[claim.claim_id] = {
        ...claim,
        supports: [...supports.values()].sort((a, b) => a.path.localeCompare(b.path)),
        lifecycle: "active",
      };
    }
  }
  for (const old of Object.values(previous?.claims ?? {})) {
    if (claims[old.claim_id]) continue;
    claims[old.claim_id] = { ...old, supports: [], lifecycle: "orphaned" };
  }
  return { schema: "dreamgraph.structural_evidence.v1", revision, claims };
}
