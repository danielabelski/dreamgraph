/**
 * DreamGraph — scan-project shared types.
 *
 * Extracted from scan-project.ts so that helper modules
 * (sanitize-entity, structural-generators) can consume the scan shape
 * without importing the orchestrator file.
 */

export interface ScannedFile {
  abs: string;
  rel: string;
  name: string;
  ext: string;
  dirParts: string[];
  size: number;
}

/**
 * Auxiliary entity buckets discovered during the file-system scan
 * (Phase 5 #9). All buckets are mutually exclusive and disjoint from
 * `files` / `uiFiles` is NOT guaranteed — a file can simultaneously be
 * counted as a code file and as an auxiliary entity (e.g. an MCP-tool
 * source file).
 */
export interface AuxiliaryFiles {
  test_suite: ScannedFile[];
  configuration: ScannedFile[];
  automation_script: ScannedFile[];
  mcp_tool: ScannedFile[];
}

export interface ProjectScan {
  repoName: string;
  repoRoot: string;
  technology: string;
  files: ScannedFile[];
  manifestContent: Record<string, string>;
  uiFiles: ScannedFile[];
  topLevelDirs: string[];
  /** Files classified as auxiliary entities (Phase 5 #9). */
  auxiliaryFiles: AuxiliaryFiles;
}
