import type { IncomingMessage } from "node:http";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { constants as FS, existsSync } from "node:fs";
import { access, copyFile, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { delimiter, isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { LlmMessage } from "../cognitive/llm.js";
import { mcpListTools } from "../cli/utils/mcp-call.js";
import { getArchitectProjectRoot } from "./plan-registry.js";
import type { ArchitectToolTraceEntry } from "./native-tool-loop.js";

export type ArchitectCliAdapter = "codex-cli" | "copilot-cli";

export interface ArchitectCliBridgeRoute {
  enabled: true;
  provider: ArchitectCliAdapter;
  mcp_port: number;
  available_tool_count: number;
  advertised_tool_count: number;
  advertised_tools: string[];
  iterations: number;
  stop_reason: string;
  fallback_reason: string | null;
  run_id: string;
  executable: string;
  bridge_entry: string;
  duration_ms: number;
  exit_code: number | null;
  signal: NodeJS.Signals | null;
  timed_out: boolean;
}

export interface ArchitectCliBridgeProvenance {
  authority: "dreamgraph_mcp";
  route: ArchitectCliAdapter;
  provider: ArchitectCliAdapter;
  model: string;
  run_id: string;
  tool_calls: Array<{
    iteration: number;
    tool: string;
    status: ArchitectToolTraceEntry["status"];
    duration_ms: number;
  }>;
}

export interface ArchitectCliBridgeResult {
  content: string;
  model: string;
  route: ArchitectCliBridgeRoute;
  provenance: ArchitectCliBridgeProvenance;
  tool_trace: ArchitectToolTraceEntry[];
}

export interface RunArchitectCliBridgeInput {
  adapter: ArchitectCliAdapter;
  req: IncomingMessage;
  messages: LlmMessage[];
  userMessage: string;
  model: string;
  timeoutMs: number;
  signal?: AbortSignal;
  onToolTrace?: (entry: ArchitectToolTraceEntry) => void;
}

interface ProcessResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  timedOut: boolean;
  durationMs: number;
}

interface AuditRecord {
  server?: string;
  tool?: string;
  inputJson?: string;
  resultJson?: string;
  isError?: boolean;
  status?: ArchitectToolTraceEntry["status"];
  durationMs?: number;
  startedAtEpochMs?: number;
}

const OUTPUT_LIMIT = 512 * 1024;
const CLI_DEFAULT_TIMEOUT_MS = 300_000;
const CODEX_HOME_AUTH_ARTIFACTS = Object.freeze(["auth.json", "version.json", "installation_id"] as const);
const BRIDGE_LOCAL_DREAMGRAPH_TOOLS = Object.freeze(["run_command"] as const);
const BRIDGE_MCP_CONFIG_ENV_KEYS = Object.freeze([
  "DREAMGRAPH_HOST_MCP_URL",
  "DREAMGRAPH_BRIDGE_AUDIT_DIR",
  "DREAMGRAPH_AUDIT_PATH",
  "DREAMGRAPH_RUN_ID",
  "DREAMGRAPH_WORKSPACE_ROOT",
  "ELECTRON_RUN_AS_NODE",
] as const);
const REQUIRED_DREAMGRAPH_TOOLS = Object.freeze(["query_resource", "read_source_code", "search_source_code", "run_command"] as const);
const CLI_BINARY_ENV_KEY_BY_ADAPTER: Record<ArchitectCliAdapter, string> = Object.freeze({
  "codex-cli": "DREAMGRAPH_ARCHITECT_CODEX_CLI_BINARY",
  "copilot-cli": "DREAMGRAPH_ARCHITECT_COPILOT_CLI_BINARY",
});
const CLI_DEFAULT_BINARY_BY_ADAPTER: Record<ArchitectCliAdapter, string> = Object.freeze({
  "codex-cli": "codex",
  "copilot-cli": "copilot",
});
const IS_WINDOWS = process.platform === "win32";
const WINDOWS_PATH_EXTS: readonly string[] = IS_WINDOWS
  ? Array.from(new Set([...(process.env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD").split(";"), ".PS1"]
    .map((value) => value.trim().toLowerCase())
    .filter(Boolean)))
  : [];

export async function runArchitectCliBridge(input: RunArchitectCliBridgeInput): Promise<ArchitectCliBridgeResult> {
  const mcpPort = architectMcpPort(input.req);
  if (mcpPort == null) {
    throw new Error("ARCHITECT_CLI_BRIDGE_MCP_PORT_UNAVAILABLE: request host did not expose a local MCP port");
  }

  const upstreamTools = await mcpListTools(mcpPort);
  const availableToolNames = resolveArchitectCliBridgeToolNames(upstreamTools.map((tool) => tool.name));
  const missingTools = REQUIRED_DREAMGRAPH_TOOLS.filter((name) => !availableToolNames.includes(name));
  if (missingTools.length > 0) {
    throw new Error(`ARCHITECT_CLI_BRIDGE_MCP_TOOL_MISMATCH: missing required DreamGraph MCP tool(s): ${missingTools.join(", ")}`);
  }

  const runId = `architect-${input.adapter}-${randomUUID()}`;
  const scratchDir = await mkdtemp(join(tmpdir(), `dreamgraph-architect-${input.adapter}-`));
  const auditDir = join(scratchDir, "audit");
  const auditPath = join(auditDir, `${runId}.ndjson`);
  const bridgeSpawn = resolveBridgeSpawn();
  const prompt = serializeCliPrompt(input.messages, input.userMessage, input.adapter);
  const model = input.model && input.model !== "auto" ? input.model : undefined;
  const timeoutMs = Number.isFinite(input.timeoutMs) && input.timeoutMs > 0
    ? Math.max(30_000, Math.min(input.timeoutMs, CLI_DEFAULT_TIMEOUT_MS))
    : CLI_DEFAULT_TIMEOUT_MS;
  const startedAt = Date.now();

  try {
    await mkdir(auditDir, { recursive: true, mode: 0o700 });
    const envBase = buildBridgeEnv({
      mcpPort,
      runId,
      auditDir,
      auditPath,
      workspaceRoot: getArchitectProjectRoot(),
    });
    const invocation = input.adapter === "codex-cli"
      ? await prepareCodexInvocation({ scratchDir, prompt, model, bridgeSpawn, envBase, runId, availableToolNames })
      : await prepareCopilotInvocation({ scratchDir, prompt, model, bridgeSpawn, envBase, runId, availableToolNames });

    const auditTail = startAuditTraceTail(auditPath, input.onToolTrace);
    let processResult: ProcessResult;
    try {
      processResult = await runProcess({
        command: invocation.command,
        args: invocation.args,
        cwd: invocation.cwd,
        env: invocation.env,
        stdin: invocation.stdin,
        timeoutMs,
        signal: input.signal,
      });
    } finally {
      await auditTail.stop();
    }
    const audit = await readAuditTrace(auditPath);
    const toolTrace = auditRecordsToToolTrace(audit);
    auditTail.emitEntries(toolTrace);

    const content = await extractAssistantContent(input.adapter, processResult, invocation.outputPath);
    const completedTools = toolTrace.filter((entry) => entry.status === "completed").length;
    const failureReason = processResult.timedOut
      ? `${input.adapter.toUpperCase()}_BRIDGE_TIMEOUT: timeout after ${timeoutMs}ms; completed tools ${completedTools}/${toolTrace.length}`
      : processResult.exitCode !== 0
        ? `${input.adapter.toUpperCase()}_BRIDGE_NONZERO_EXIT: exit=${processResult.exitCode}; stderr=${compact(processResult.stderr)}`
        : !content.trim()
          ? `${input.adapter.toUpperCase()}_BRIDGE_EMPTY_RESPONSE: CLI completed without assistant text`
          : null;

    return {
      content: content.trim(),
      model: input.model,
      route: {
        enabled: true,
        provider: input.adapter,
        mcp_port: mcpPort,
        available_tool_count: availableToolNames.length,
        advertised_tool_count: availableToolNames.length,
        advertised_tools: availableToolNames,
        iterations: 1,
        stop_reason: processResult.timedOut ? "cli_timed_out" : processResult.exitCode !== 0 ? "cli_failed" : failureReason ? "cli_empty_response" : "cli_completed",
        fallback_reason: failureReason,
        run_id: runId,
        executable: invocation.command,
        bridge_entry: bridgeSpawn.entryPath,
        duration_ms: Math.max(0, Date.now() - startedAt),
        exit_code: processResult.exitCode,
        signal: processResult.signal,
        timed_out: processResult.timedOut,
      },
      provenance: {
        authority: "dreamgraph_mcp",
        route: input.adapter,
        provider: input.adapter,
        model: input.model,
        run_id: runId,
        tool_calls: toolTrace.map((entry) => ({
          iteration: entry.iteration,
          tool: entry.tool,
          status: entry.status,
          duration_ms: entry.duration_ms,
        })),
      },
      tool_trace: toolTrace,
    };
  } finally {
    await rm(scratchDir, { recursive: true, force: true }).catch(() => undefined);
  }
}

function architectMcpPort(req: IncomingMessage): number | null {
  const host = req.headers.host;
  if (!host) return null;
  try {
    const url = new URL(`http://${host}`);
    const port = Number(url.port);
    return Number.isInteger(port) && port > 0 ? port : null;
  } catch {
    return null;
  }
}

function resolveBridgeSpawn(): { entryPath: string; command: string; args: string[] } {
  const compiled = fileURLToPath(new URL("./cli-mcp-bridge.js", import.meta.url));
  if (existsSync(compiled)) {
    return { entryPath: compiled, command: process.execPath, args: [compiled] };
  }
  const source = fileURLToPath(new URL("./cli-mcp-bridge.ts", import.meta.url));
  if (existsSync(source)) {
    return { entryPath: source, command: process.execPath, args: [...process.execArgv, source] };
  }
  throw new Error("ARCHITECT_CLI_BRIDGE_ENTRY_MISSING: cli-mcp-bridge entry file was not found");
}

function buildBridgeEnv(input: {
  mcpPort: number;
  runId: string;
  auditDir: string;
  auditPath: string;
  workspaceRoot: string;
}): Record<string, string> {
  const env = stringEnv(process.env);
  return {
    ...env,
    DREAMGRAPH_HOST_MCP_URL: `http://127.0.0.1:${input.mcpPort}/mcp`,
    DREAMGRAPH_BRIDGE_AUDIT_DIR: input.auditDir,
    DREAMGRAPH_AUDIT_PATH: input.auditPath,
    DREAMGRAPH_RUN_ID: input.runId,
    DREAMGRAPH_WORKSPACE_ROOT: input.workspaceRoot,
    ELECTRON_RUN_AS_NODE: "1",
  };
}

function bridgeMcpConfigEnv(env: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const key of BRIDGE_MCP_CONFIG_ENV_KEYS) {
    out[key] = env[key] ?? "";
  }
  return out;
}

async function resolveArchitectCliExecutable(adapter: ArchitectCliAdapter): Promise<string> {
  const envKey = CLI_BINARY_ENV_KEY_BY_ADAPTER[adapter];
  const configured = process.env[envKey]?.trim();
  const binaryName = configured && configured.length > 0
    ? configured
    : CLI_DEFAULT_BINARY_BY_ADAPTER[adapter];
  const resolved = await resolveArchitectCliBridgeExecutablePath(binaryName, process.env);
  if (resolved) return resolved;
  const label = adapter === "codex-cli" ? "CODEX_CLI_NOT_FOUND" : "COPILOT_CLI_NOT_FOUND";
  throw new Error(`${label}: binary "${binaryName}" was not found on PATH; set ${envKey} to the full CLI executable path`);
}

export async function resolveArchitectCliBridgeExecutablePath(
  binaryName: string,
  env: Readonly<Record<string, string | undefined>> = process.env,
): Promise<string | null> {
  if (typeof binaryName !== "string" || binaryName.trim().length === 0) {
    throw new Error("resolveArchitectCliBridgeExecutablePath: binaryName must be a non-empty string");
  }
  const normalized = binaryName.trim();
  let resolved: string | null = null;
  if (IS_WINDOWS) {
    resolved = await resolveViaPowerShell(normalized, env);
  }
  return resolved ?? await resolveOnPath(normalized, env);
}

async function resolveViaPowerShell(
  binaryName: string,
  env: Readonly<Record<string, string | undefined>>,
): Promise<string | null> {
  if (!IS_WINDOWS) return null;
  if (/[\u0000-\u001f]/.test(binaryName)) return null;
  const quoted = binaryName.replace(/'/g, "''");
  const script =
    `$ErrorActionPreference='SilentlyContinue';` +
    `$commands=Get-Command -Name '${quoted}' -CommandType Application,ExternalScript -All -ErrorAction SilentlyContinue;` +
    `if($commands){[Console]::Out.Write(($commands|ForEach-Object{$_.Source}) -join [char]0)}`;
  const result = await runProcess({
    command: "powershell.exe",
    args: ["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", script],
    cwd: process.cwd(),
    env: stringEnv(env),
    stdin: "",
    timeoutMs: 5_000,
  }).catch(() => null);
  if (!result || result.exitCode !== 0) return null;
  const live: string[] = [];
  for (const candidate of result.stdout.split("\u0000").map((value) => value.trim()).filter(Boolean)) {
    if (await isExecutableFile(candidate)) live.push(candidate);
  }
  if (live.length === 0) return null;
  live.sort((a, b) => rankWindowsShimByExtension(a) - rankWindowsShimByExtension(b));
  return live[0] ?? null;
}

async function resolveOnPath(
  binaryName: string,
  env: Readonly<Record<string, string | undefined>>,
): Promise<string | null> {
  if (isAbsolute(binaryName)) {
    if (await isExecutableFile(binaryName)) {
      if (!IS_WINDOWS || hasWindowsExecutableExtension(binaryName)) return binaryName;
      for (const ext of WINDOWS_PATH_EXTS) {
        const candidate = binaryName + ext.toLowerCase();
        if (await isExecutableFile(candidate)) return candidate;
      }
      return null;
    }
    if (IS_WINDOWS) {
      for (const ext of WINDOWS_PATH_EXTS) {
        const candidate = binaryName + ext.toLowerCase();
        if (await isExecutableFile(candidate)) return candidate;
      }
    }
    return null;
  }

  const pathVar = env.PATH ?? env.Path ?? env.path ?? "";
  if (!pathVar) return null;
  const candidates: string[] = [];
  for (const dir of pathVar.split(delimiter)) {
    if (!dir) continue;
    if (IS_WINDOWS) {
      for (const ext of WINDOWS_PATH_EXTS) candidates.push(join(dir, binaryName + ext.toLowerCase()));
      if (hasWindowsExecutableExtension(binaryName)) candidates.push(join(dir, binaryName));
    } else {
      candidates.push(join(dir, binaryName));
    }
  }

  const live: string[] = [];
  for (const candidate of candidates) {
    if (await isExecutableFile(candidate)) live.push(candidate);
  }
  if (live.length === 0) return null;
  if (IS_WINDOWS) live.sort((a, b) => rankWindowsShimByExtension(a) - rankWindowsShimByExtension(b));
  return live[0] ?? null;
}

async function isExecutableFile(absPath: string): Promise<boolean> {
  try {
    await access(absPath, IS_WINDOWS ? FS.F_OK : FS.X_OK);
    return true;
  } catch {
    return false;
  }
}

function hasWindowsExecutableExtension(sourcePath: string): boolean {
  const lower = sourcePath.toLowerCase();
  return WINDOWS_PATH_EXTS.some((ext) => lower.endsWith(ext));
}

function rankWindowsShimByExtension(sourcePath: string): number {
  const lower = sourcePath.toLowerCase();
  if (lower.endsWith(".exe")) return 0;
  if (lower.endsWith(".cmd")) return 1;
  if (lower.endsWith(".com")) return 2;
  if (lower.endsWith(".bat")) return 3;
  if (lower.endsWith(".ps1")) return 4;
  return 5;
}

async function prepareCodexInvocation(input: {
  scratchDir: string;
  prompt: string;
  model: string | undefined;
  bridgeSpawn: { entryPath: string; command: string; args: string[] };
  envBase: Record<string, string>;
  runId: string;
  availableToolNames: string[];
}): Promise<{ command: string; args: string[]; cwd: string; env: Record<string, string>; stdin: string; outputPath: string | null }> {
  const command = await resolveArchitectCliExecutable("codex-cli");
  const codexHome = join(input.scratchDir, "codex-home");
  const artifactsDir = join(input.scratchDir, "artifacts");
  await mkdir(codexHome, { recursive: true, mode: 0o700 });
  await mkdir(artifactsDir, { recursive: true, mode: 0o700 });
  await copyCodexHomeAuthArtifacts(codexHome);
  await writeFile(join(codexHome, "config.toml"), createArchitectCodexConfigToml({
    bridgeCommand: input.bridgeSpawn.command,
    bridgeArgs: input.bridgeSpawn.args,
    env: bridgeMcpConfigEnv(input.envBase),
    tools: input.availableToolNames,
  }), { mode: 0o600 });

  const outputPath = join(artifactsDir, "last-message.txt");
  const args = [
    "exec",
    "--json",
    "--cd",
    input.scratchDir,
    "--sandbox",
    "read-only",
    "--output-last-message",
    outputPath,
    "--skip-git-repo-check",
    "--ignore-rules",
    "--ephemeral",
  ];
  if (input.model) args.push("--model", input.model);
  args.push("-");

  return {
    command,
    args,
    cwd: input.scratchDir,
    env: {
      ...input.envBase,
      CODEX_HOME: codexHome,
      RUST_LOG: input.envBase.RUST_LOG || "info,codex_mcp_server=info,rmcp=warn",
    },
    stdin: input.prompt,
    outputPath,
  };
}

export function createArchitectCopilotPromptFileDirective(promptFilePath: string): string {
  return "The full DreamGraph Architect request is stored verbatim in the file at this path: "
    + promptFilePath
    + ". Use your read tool to load the file's full contents before responding. Treat that file as the request envelope, respond only to its CURRENT USER REQUEST section, and use DreamGraph MCP for repository facts, mutations, and verification. Do not mention this transport directive.";
}

async function prepareCopilotInvocation(input: {
  scratchDir: string;
  prompt: string;
  model: string | undefined;
  bridgeSpawn: { entryPath: string; command: string; args: string[] };
  envBase: Record<string, string>;
  runId: string;
  availableToolNames: string[];
}): Promise<{ command: string; args: string[]; cwd: string; env: Record<string, string>; stdin: string; outputPath: string | null }> {
  const command = await resolveArchitectCliExecutable("copilot-cli");
  const copilotHome = join(input.scratchDir, "copilot-home");
  const promptFilePath = join(input.scratchDir, "prompt.md");
  await mkdir(copilotHome, { recursive: true, mode: 0o700 });
  await copyCopilotHome(copilotHome);
  await writeFile(promptFilePath, input.prompt, { mode: 0o600 });
  await writeFile(join(copilotHome, "mcp-config.json"), copilotMcpConfigJson({
    bridgeCommand: input.bridgeSpawn.command,
    bridgeArgs: input.bridgeSpawn.args,
    env: bridgeMcpConfigEnv(input.envBase),
    tools: input.availableToolNames,
    runId: input.runId,
  }), { mode: 0o600 });

  const args = [];
  if (input.model) args.push("--model", input.model);
  args.push("--allow-all-tools", "--output-format", "json", "--deny-tool", "shell", "--deny-tool", "write");
  for (const tool of input.availableToolNames) {
    args.push("--allow-tool", `dreamgraph(${tool})`);
  }
  args.push("--add-dir", input.scratchDir, "--prompt", createArchitectCopilotPromptFileDirective(promptFilePath));

  return {
    command,
    args,
    cwd: getArchitectProjectRoot(),
    env: { ...input.envBase, COPILOT_HOME: copilotHome },
    stdin: "",
    outputPath: null,
  };
}

export function createArchitectCodexConfigToml(input: {
  bridgeCommand: string;
  bridgeArgs: string[];
  env: Record<string, string>;
  tools: string[];
}): string {
  const lines = [
    "# Generated by DreamGraph for an isolated standalone Architect Codex CLI run.",
    "[mcp_servers.dreamgraph]",
    `command = ${tomlString(input.bridgeCommand)}`,
    `args = ${tomlArray(input.bridgeArgs)}`,
    `trust_level = ${tomlString("trusted")}`,
    "disabled_tools = []",
    "default_tools_enabled = true",
    `default_tools_approval_mode = ${tomlString("approve")}`,
    "",
    "[mcp_servers.dreamgraph.env]",
  ];
  for (const key of Object.keys(input.env).sort()) {
    lines.push(`${tomlKey(key)} = ${tomlString(input.env[key] ?? "")}`);
  }
  for (const tool of input.tools) {
    lines.push("", `[mcp_servers.dreamgraph.tools.${tomlKey(tool)}]`, `approval_mode = ${tomlString("approve")}`);
  }
  return `${lines.join("\n")}\n`;
}

function copilotMcpConfigJson(input: {
  bridgeCommand: string;
  bridgeArgs: string[];
  env: Record<string, string>;
  tools: string[];
  runId: string;
}): string {
  return `${JSON.stringify({
    mcpServers: {
      dreamgraph: {
        type: "stdio",
        command: input.bridgeCommand,
        args: input.bridgeArgs,
        env: input.env,
      },
    },
    _dreamgraph_meta: {
      runId: input.runId,
      authoritativeServer: "dreamgraph",
      allowlist: input.tools,
    },
  }, null, 2)}\n`;
}

function serializeCliPrompt(messages: LlmMessage[], userMessage: string, adapter: ArchitectCliAdapter): string {
  return [
    `You are running inside DreamGraph architect through the real ${adapter} bridge.`,
    "Use the dreamgraph MCP server as the authoritative source for repository facts and mutations.",
    "Do not use provider-native shell/read/write routes; use dreamgraph:run_command, read_source_code, patch_file, and related DreamGraph MCP tools.",
    "",
    ...messages.map((message) => `## ${message.role.toUpperCase()}\n${message.content}`),
    "",
    "## CURRENT USER REQUEST",
    userMessage,
  ].join("\n\n");
}

async function copyCodexHomeAuthArtifacts(runHomeDir: string): Promise<void> {
  const sourceHome = process.env.CODEX_HOME && process.env.CODEX_HOME.length > 0
    ? process.env.CODEX_HOME
    : join(homedir(), ".codex");
  for (const filename of CODEX_HOME_AUTH_ARTIFACTS) {
    const source = join(sourceHome, filename);
    try {
      await copyFile(source, join(runHomeDir, filename));
    } catch {
      // Missing auth artifacts are reported by Codex during the login probe/run.
    }
  }
}

async function copyCopilotHome(runHomeDir: string): Promise<void> {
  const sourceHome = process.env.COPILOT_HOME && process.env.COPILOT_HOME.length > 0
    ? process.env.COPILOT_HOME
    : join(homedir(), ".copilot");
  await copyDirRecursive(sourceHome, runHomeDir, new Set(["mcp-config.json"]));
}

async function copyDirRecursive(source: string, target: string, excludeNames: Set<string>): Promise<void> {
  let entries: Array<{ name: string; isDirectory: () => boolean; isFile: () => boolean }>;
  try {
    entries = await readdir(source, { withFileTypes: true });
  } catch {
    return;
  }
  await mkdir(target, { recursive: true, mode: 0o700 });
  for (const entry of entries) {
    if (excludeNames.has(entry.name)) continue;
    const from = join(source, entry.name);
    const to = join(target, entry.name);
    if (entry.isDirectory()) {
      await copyDirRecursive(from, to, excludeNames);
    } else if (entry.isFile()) {
      await copyFile(from, to).catch(() => undefined);
    }
  }
}

export function createArchitectCliBridgeSpawnPlan(command: string, args: readonly string[]): {
  command: string;
  args: string[];
  windowsVerbatimArguments?: boolean;
} {
  if (IS_WINDOWS && /\.ps1$/i.test(command)) {
    return {
      command: "powershell.exe",
      args: ["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", command, ...args],
    };
  }
  if (IS_WINDOWS && /\.(?:cmd|bat)$/i.test(command)) {
    for (let index = 0; index < args.length; index += 1) {
      if (/[\r\n]/.test(args[index] ?? "")) {
        throw new Error(`runProcess: argv[${index}] for Windows command shim contains a newline; pass payloads via stdin or a file`);
      }
    }
    const tokens = [command, ...args]
      .map((token) => quoteForCommandLineToArgvW(token))
      .map((token) => escapeForCmdExe(token))
      .join(" ");
    return {
      command: "cmd.exe",
      args: ["/d", "/s", "/c", `"${tokens}"`],
      windowsVerbatimArguments: true,
    };
  }
  return { command, args: [...args] };
}

function quoteForCommandLineToArgvW(arg: string): string {
  if (arg.length > 0 && !/[ \t\n\v"]/.test(arg)) return arg;
  let out = "\"";
  for (let index = 0; index <= arg.length; index += 1) {
    let backslashes = 0;
    while (index < arg.length && arg[index] === "\\") {
      backslashes += 1;
      index += 1;
    }
    if (index === arg.length) {
      out += "\\".repeat(backslashes * 2);
      break;
    }
    if (arg[index] === "\"") {
      out += "\\".repeat(backslashes * 2 + 1) + "\"";
    } else {
      out += "\\".repeat(backslashes);
      out += arg[index] ?? "";
    }
  }
  return `${out}"`;
}

function escapeForCmdExe(token: string): string {
  return token.replace(/[()%!^<>&|]/g, (value) => `^${value}`);
}

function runProcess(input: {
  command: string;
  args: string[];
  cwd: string;
  env: Record<string, string>;
  stdin: string;
  timeoutMs: number;
  signal?: AbortSignal;
}): Promise<ProcessResult> {
  return new Promise((resolvePromise, reject) => {
    const startedAt = Date.now();
    const spawnPlan = createArchitectCliBridgeSpawnPlan(input.command, input.args);
    const child = spawn(spawnPlan.command, spawnPlan.args, {
      cwd: input.cwd,
      env: input.env,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
      windowsVerbatimArguments: spawnPlan.windowsVerbatimArguments,
    });

    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let settled = false;
    const terminateChild = () => {
      child.kill("SIGTERM");
      setTimeout(() => child.kill("SIGKILL"), 2_000).unref?.();
    };
    const timer = setTimeout(() => {
      timedOut = true;
      terminateChild();
    }, input.timeoutMs);
    timer.unref?.();
    const abortListener = () => terminateChild();
    if (input.signal?.aborted) {
      abortListener();
    } else {
      input.signal?.addEventListener("abort", abortListener, { once: true });
    }

    child.stdout.on("data", (chunk) => {
      stdout = appendLimited(stdout, String(chunk));
    });
    child.stderr.on("data", (chunk) => {
      stderr = appendLimited(stderr, String(chunk));
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      input.signal?.removeEventListener("abort", abortListener);
      if (settled) return;
      settled = true;
      reject(error);
    });
    child.on("close", (exitCode, signal) => {
      clearTimeout(timer);
      input.signal?.removeEventListener("abort", abortListener);
      if (settled) return;
      settled = true;
      resolvePromise({
        stdout,
        stderr,
        exitCode,
        signal,
        timedOut,
        durationMs: Math.max(0, Date.now() - startedAt),
      });
    });

    child.stdin.end(input.stdin);
  });
}

async function extractAssistantContent(adapter: ArchitectCliAdapter, result: ProcessResult, outputPath: string | null): Promise<string> {
  if (outputPath) {
    const fromFile = await readFile(outputPath, "utf8").catch(() => "");
    if (fromFile.trim()) return fromFile;
  }
  if (adapter === "copilot-cli") {
    const parsed = extractCopilotAssistantText(result.stdout);
    if (parsed.trim()) return parsed;
  }
  return compact(result.stdout);
}

export function resolveArchitectCliBridgeToolNames(upstreamToolNames: readonly string[]): string[] {
  const names = [...upstreamToolNames];
  for (const localToolName of BRIDGE_LOCAL_DREAMGRAPH_TOOLS) {
    if (!names.includes(localToolName)) names.push(localToolName);
  }
  return names;
}

function extractCopilotAssistantText(stdout: string): string {
  const chunks: string[] = [];
  for (const line of stdout.split(/\r?\n/)) {
    if (!line.trim().startsWith("{")) continue;
    try {
      const event = JSON.parse(line) as Record<string, unknown>;
      if (event.type === "assistant.message_delta" && typeof event.deltaContent === "string") {
        chunks.push(event.deltaContent);
      } else if (event.type === "assistant.message" && typeof event.content === "string") {
        chunks.length = 0;
        chunks.push(event.content);
      }
    } catch {
      // ignore non-event lines
    }
  }
  return chunks.join("");
}

async function readAuditTrace(auditPath: string): Promise<AuditRecord[]> {
  const text = await readFile(auditPath, "utf8").catch(() => "");
  const out: AuditRecord[] = [];
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      const parsed = JSON.parse(line) as AuditRecord;
      out.push(parsed);
    } catch {
      // ignore malformed audit lines
    }
  }
  return out;
}

function auditTraceKey(record: AuditRecord, fallbackIndex: number): string {
  return [record.server ?? "dreamgraph", record.tool ?? "unknown", String(record.startedAtEpochMs ?? fallbackIndex)].join(":");
}

function auditRecordsToToolTrace(records: AuditRecord[]): ArchitectToolTraceEntry[] {
  const order = new Map<string, number>();
  const byKey = new Map<string, ArchitectToolTraceEntry>();
  for (let index = 0; index < records.length; index += 1) {
    const record = records[index];
    const key = auditTraceKey(record, index);
    if (!order.has(key)) order.set(key, order.size + 1);
    byKey.set(key, auditToToolTrace(record, order.get(key) ?? order.size + 1, key));
  }
  return [...byKey.entries()]
    .sort((left, right) => (order.get(left[0]) ?? 0) - (order.get(right[0]) ?? 0))
    .map(([, entry]) => entry);
}

function startAuditTraceTail(
  auditPath: string,
  onToolTrace: ((entry: ArchitectToolTraceEntry) => void) | undefined,
): { stop: () => Promise<void>; emitEntries: (entries: ArchitectToolTraceEntry[]) => void } {
  if (!onToolTrace) {
    return { stop: async () => undefined, emitEntries: () => undefined };
  }
  const emitted = new Map<string, string>();
  let flushing = false;
  const emitEntries = (entries: ArchitectToolTraceEntry[]): void => {
    for (const entry of entries) {
      const key = entry.trace_id ?? `${entry.tool}:${entry.iteration}`;
      const signature = [entry.status, entry.duration_ms, entry.result_preview].join("|");
      if (emitted.get(key) === signature) continue;
      emitted.set(key, signature);
      onToolTrace(entry);
    }
  };
  const flush = async (): Promise<void> => {
    if (flushing) return;
    flushing = true;
    try {
      emitEntries(auditRecordsToToolTrace(await readAuditTrace(auditPath)));
    } finally {
      flushing = false;
    }
  };
  const timer = setInterval(() => {
    void flush();
  }, 250);
  timer.unref?.();
  void flush();
  return {
    stop: async () => {
      clearInterval(timer);
      await flush();
    },
    emitEntries,
  };
}

function auditToToolTrace(record: AuditRecord, iteration: number, traceId: string): ArchitectToolTraceEntry {
  const status = record.status ?? (record.isError ? "failed" : "completed");
  return {
    iteration,
    tool: `${record.server ?? "dreamgraph"}:${record.tool ?? "unknown"}`,
    args_summary: compact(record.inputJson ?? "{}"),
    status,
    duration_ms: typeof record.durationMs === "number" ? Math.max(0, Math.trunc(record.durationMs)) : 0,
    result_preview: compact(previewAuditResult(record.resultJson ?? "")),
    trace_id: traceId,
  };
}

function previewAuditResult(resultJson: string): string {
  if (!resultJson.trim()) return "";
  try {
    const parsed = JSON.parse(resultJson) as unknown;
    if (isRecord(parsed) && Array.isArray(parsed.content)) {
      const text = parsed.content
        .filter((item): item is { type: string; text: string } => isRecord(item) && item.type === "text" && typeof item.text === "string")
        .map((item) => item.text)
        .join("\n")
        .trim();
      return text || resultJson;
    }
  } catch {
    // Fall back to the raw bridge payload below.
  }
  return resultJson;
}

function appendLimited(current: string, next: string): string {
  const combined = current + next;
  if (combined.length <= OUTPUT_LIMIT) return combined;
  return `${combined.slice(0, OUTPUT_LIMIT)}\n[output truncated]`;
}

function compact(text: string): string {
  return text.replace(/\s+/g, " ").trim().slice(0, 4_000);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringEnv(source: Readonly<Record<string, string | undefined>>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(source)) {
    if (typeof value === "string") out[key] = value;
  }
  return out;
}

function tomlString(value: string): string {
  return JSON.stringify(value);
}

function tomlKey(value: string): string {
  return /^[A-Za-z0-9_-]+$/.test(value) ? value : tomlString(value);
}

function tomlArray(values: readonly string[]): string {
  return `[${values.map(tomlString).join(", ")}]`;
}
