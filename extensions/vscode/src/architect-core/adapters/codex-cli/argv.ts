// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Codex CLI adapter - pure argv builder (Slice 1).

import type {
  CodexArgvInput,
  CodexArgvPlan,
  CodexConfigOverride,
} from "./types.js";

const FORBIDDEN_CONFIG_KEY_RE = /(?:^|\.)(?:sandbox|sandbox_mode|approval|approval_mode|ask_for_approval|dangerously_bypass_approvals_and_sandbox|yolo|full_auto)(?:$|\.)/i;
const DREAMGRAPH_MCP_APPROVAL_KEY_RE =
  /^mcp_servers\.dreamgraph\.(?:default_tools_approval_mode|tools\.[A-Za-z0-9_-]+\.approval_mode)$/;
const DREAMGRAPH_MCP_APPROVAL_MODE_RE = /^(?:"approve"|approve)$/;
const MODEL_REASONING_EFFORT_CONFIG_KEY = "model_reasoning_effort";
type DefaultReasoningEffort = "high" | "xhigh";

function requireFlag(available: boolean, flag: string): void {
  if (!available) {
    throw new Error(`buildCodexArgv: help surface does not advertise ${flag}`);
  }
}

function serializeConfigValue(value: string | number | boolean): string {
  if (typeof value === "string") {
    return value;
  }
  return JSON.stringify(value);
}

function configOverrideArg(override: CodexConfigOverride): string {
  const key = override.key.trim();
  if (key.length === 0) {
    throw new Error("buildCodexArgv: config override key is required");
  }
  const value = serializeConfigValue(override.value);
  if (DREAMGRAPH_MCP_APPROVAL_KEY_RE.test(key) && !isDreamGraphMcpApprovalValue(value)) {
    throw new Error(
      `buildCodexArgv: config override cannot weaken authoritative sandbox/approval policy: ${key}`,
    );
  }
  if (FORBIDDEN_CONFIG_KEY_RE.test(key) && !isDreamGraphMcpApprovalOverride(key, value)) {
    throw new Error(
      `buildCodexArgv: config override cannot weaken authoritative sandbox/approval policy: ${key}`,
    );
  }
  return `${key}=${value}`;
}

function isDreamGraphMcpApprovalOverride(key: string, value: string): boolean {
  if (!DREAMGRAPH_MCP_APPROVAL_KEY_RE.test(key)) return false;
  return isDreamGraphMcpApprovalValue(value);
}

function isDreamGraphMcpApprovalValue(value: string): boolean {
  return DREAMGRAPH_MCP_APPROVAL_MODE_RE.test(value.trim());
}

function hasConfigOverride(
  overrides: readonly CodexConfigOverride[] | undefined,
  key: string,
): boolean {
  return (overrides ?? []).some((override) => override.key.trim().toLowerCase() === key);
}

function defaultReasoningEffortForModel(model: string | undefined): DefaultReasoningEffort | undefined {
  const normalized = model?.trim().toLowerCase();
  if (!normalized) return undefined;
  if (normalized.startsWith("gpt-5.6")) return "xhigh";
  if (normalized.startsWith("gpt-5.5")) return "xhigh";
  if (normalized.startsWith("gpt-5.4")) return "high";
  return undefined;
}

export function buildCodexArgv(input: CodexArgvInput): CodexArgvPlan {
  if (!input.workspace) {
    throw new Error("buildCodexArgv: workspace is required");
  }

  const exec = input.helpSurface.exec;
  requireFlag(exec.json, "--json");
  requireFlag(exec.cd, "--cd");
  requireFlag(exec.sandbox, "--sandbox");
  requireFlag(exec.positionalStdinPrompt, "positional stdin prompt '-' argument");

  const args: string[] = [];
  const approvalMode = input.helpSurface.root.askForApproval || exec.askForApproval
    ? "never"
    : "not-advertised";
  if (input.helpSurface.root.askForApproval) {
    args.push("--ask-for-approval", "never");
  }

  args.push(
    "exec",
    "--json",
    "--cd",
    input.workspace,
    "--sandbox",
    "read-only",
  );

  if (!input.helpSurface.root.askForApproval && exec.askForApproval) {
    args.push("--ask-for-approval", "never");
  }

  if (input.model) {
    requireFlag(exec.model, "--model");
    args.push("--model", input.model);
  }

  if (input.profile) {
    requireFlag(exec.profile, "--profile");
    args.push("--profile", input.profile);
  }

  if (input.outputLastMessagePath) {
    requireFlag(exec.outputLastMessage, "--output-last-message");
    args.push("--output-last-message", input.outputLastMessagePath);
  }

  if (input.outputSchemaPath) {
    requireFlag(exec.outputSchema, "--output-schema");
    args.push("--output-schema", input.outputSchemaPath);
  }

  const configOverrides: string[] = [];
  const defaultReasoningEffort = defaultReasoningEffortForModel(input.model);
  if (
    defaultReasoningEffort &&
    !hasConfigOverride(input.configOverrides, MODEL_REASONING_EFFORT_CONFIG_KEY)
  ) {
    requireFlag(exec.config, "--config");
    const arg = configOverrideArg({
      key: MODEL_REASONING_EFFORT_CONFIG_KEY,
      value: JSON.stringify(defaultReasoningEffort),
    });
    args.push("-c", arg);
    configOverrides.push(arg);
  }

  for (const override of input.configOverrides ?? []) {
    requireFlag(exec.config, "--config");
    const arg = configOverrideArg(override);
    args.push("-c", arg);
    configOverrides.push(arg);
  }

  const addedDirs: string[] = [];
  for (const dir of input.addDirs ?? []) {
    if (typeof dir !== "string" || dir.length === 0) continue;
    requireFlag(exec.addDir, "--add-dir");
    args.push("--add-dir", dir);
    addedDirs.push(dir);
  }

  if (input.skipGitRepoCheck) {
    requireFlag(exec.skipGitRepoCheck, "--skip-git-repo-check");
    args.push("--skip-git-repo-check");
  }

  if (input.ignoreUserConfig) {
    requireFlag(exec.ignoreUserConfig, "--ignore-user-config");
    args.push("--ignore-user-config");
  }

  if (input.ignoreRules) {
    requireFlag(exec.ignoreRules, "--ignore-rules");
    args.push("--ignore-rules");
  }

  if (input.ephemeral) {
    requireFlag(exec.ephemeral, "--ephemeral");
    args.push("--ephemeral");
  }

  args.push("-");

  return {
    args: Object.freeze(args),
    policy: {
      sandboxMode: "read-only",
      approvalMode,
      promptSource: "stdin-positional-dash",
      jsonEventsEnabled: true,
      userConfigIgnored: input.ignoreUserConfig === true,
      rulesIgnored: input.ignoreRules === true,
      ephemeral: input.ephemeral === true,
      gitRepoCheckSkipped: input.skipGitRepoCheck === true,
      addedDirs: Object.freeze(addedDirs),
      configOverrides: Object.freeze(configOverrides),
    },
  };
}
