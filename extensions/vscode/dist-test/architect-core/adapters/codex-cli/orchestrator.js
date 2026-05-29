"use strict";
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Codex CLI adapter - bounded native runner (Slice 3).
Object.defineProperty(exports, "__esModule", { value: true });
exports.runCodexCli = runCodexCli;
const argv_js_1 = require("./argv.js");
const help_probe_js_1 = require("./help-probe.js");
const mcp_config_js_1 = require("./mcp-config.js");
const transcript_classifier_js_1 = require("./transcript-classifier.js");
const transcript_js_1 = require("./transcript.js");
const types_js_1 = require("./types.js");
const DEFAULT_BINARY_NAME = "codex";
const DEFAULT_TOKEN_BYTES = 32;
const CODEX_HOME_AUTH_ARTIFACTS = Object.freeze([
    "auth.json",
    "version.json",
    "installation_id",
]);
// Patterns that indicate a real MCP load/runtime failure (the bridge never
// initialized or crashed during a tool call). The previous version of this
// regex also matched `rmcp::transport::async_rw` and "error reading from
// stream: serde error EOF" — both of which Codex emits as NORMAL teardown
// noise when it taskkills its MCP child processes at the end of a successful
// run. Matching those lines produced a false MCP_PROBE_FAILED whenever the
// model answered without invoking a tool. Keep only the patterns that are
// unambiguous load/start failures or explicit codex_mcp_server errors.
const MCP_RUNTIME_FAILURE_RE = /\b(?:codex_mcp_server::|failed to load mcp|failed to start mcp|mcp bridge|mcp server (?:failed|crashed|errored)|tools\/list (?:failed|timeout|timed out))\b/i;
const USER_CANCELLED_MCP_TOOL_CALL_RE = /\buser cancelled MCP tool call\b/i;
const MCP_TOOL_FAILURE_LINE_RE = /\bmcp_tool_call\s+(?:failed|failure|error|cancelled|canceled)\s*:\s*([a-z0-9_-]+)\.([a-z0-9_.-]+)(?::\s*(.*))?$/i;
const SCHEMA_ARGUMENT_FAILURE_RE = /\b(?:invalid\s+(?:arguments?|args|input|params?)|schema(?:\s+validation)?|missing\s+required|required\s+(?:property|field)|unexpected\s+(?:argument|field|property)|unknown\s+(?:argument|field|property)|must\s+include|class_name)\b/i;
const POLICY_BLOCKED_FAILURE_RE = /\b(?:blocked by policy|policy denial|policy denied|not allowed by policy|read-only sandbox|writing is blocked|rejected by user approval settings|user approval settings)\b/i;
const CONTINUATION_AUTH_FAILURE_RE = /\b(?:requires?\s+(?:authorization|approval)|authorization\s+required|approval\s+required|not\s+authorized|manual\s+authorization|user\s+cancelled\s+MCP\s+tool\s+call)\b/i;
const MISSING_TOOL_FAILURE_RE = /\b(?:unknown tool|tool not found|no such tool|missing tool|tool .*not listed|not found.*tool|does not exist)\b/i;
const RUNTIME_MCP_TOOL_FAILURE_RE = /\b(?:mcp server (?:failed|crashed|errored)|connection (?:closed|reset)|transport|eof|timed?\s*out|timeout|runtime|failed to execute)\b/i;
const LOGIN_RECOVERY = Object.freeze({
    kind: "codex-login",
    label: "Run codex login",
    command: "codex login",
});
async function runCodexCli(input, deps) {
    if (!input.prompt) {
        throw new Error("runCodexCli: prompt is required");
    }
    if (!Number.isFinite(input.timeoutMs) || input.timeoutMs <= 0) {
        throw new Error("runCodexCli: timeoutMs must be > 0");
    }
    const startedAtEpochMs = deps.clock.nowMs();
    const runId = deps.crypto.randomRunId();
    const binaryName = input.binaryName ?? DEFAULT_BINARY_NAME;
    const normalizedInvocationCwd = normalizeOptionalCwd(input.invocationCwd);
    const probeCwd = resolveProbeCwd(normalizedInvocationCwd, deps.fs);
    let runScratchDir = null;
    let auditRecording = false;
    notifyRunId(input, runId);
    try {
        const probeEnv = buildEnv(input.baseEnv);
        const resolved = await deps.process.resolveExecutable(binaryName);
        if (!resolved) {
            return fail({
                provider: types_js_1.CODEX_CLI_PROVIDER_ID,
                runId,
                startedAtEpochMs,
                endedAtEpochMs: deps.clock.nowMs(),
                code: "CODEX_CLI_NOT_FOUND",
                cause: "missing-binary",
                preSpawn: true,
                message: `Codex CLI binary "${binaryName}" was not found on PATH`,
            });
        }
        const rootHelp = await deps.process.runRootHelp({
            command: resolved.executablePath,
            cwd: probeCwd,
            env: probeEnv,
        });
        const execHelp = await deps.process.runExecHelp({
            command: resolved.executablePath,
            cwd: probeCwd,
            env: probeEnv,
        });
        const helpSurface = (0, help_probe_js_1.parseCodexHelpSurface)({
            rootHelpText: `${rootHelp.stdout}\n${rootHelp.stderr}`,
            execHelpText: `${execHelp.stdout}\n${execHelp.stderr}`,
            versionString: resolved.versionString,
        });
        if (!(0, help_probe_js_1.isHelpSurfaceSupported)(helpSurface)) {
            return fail({
                provider: types_js_1.CODEX_CLI_PROVIDER_ID,
                runId,
                startedAtEpochMs,
                endedAtEpochMs: deps.clock.nowMs(),
                code: "CODEX_HELP_SURFACE_UNSUPPORTED",
                cause: "unsupported-help",
                preSpawn: true,
                message: missingRequiredHelpFlagsMessage(helpSurface),
                helpSurface,
            });
        }
        const loginStatus = await deps.process.runLoginStatus({
            command: resolved.executablePath,
            cwd: probeCwd,
            env: probeEnv,
        });
        const loginTranscript = (0, transcript_js_1.normalizeCodexTranscript)({
            stdout: loginStatus.stdout,
            stderr: loginStatus.stderr,
            exitCode: loginStatus.exitCode,
        });
        if (loginTranscript.notLoggedIn) {
            return fail({
                provider: types_js_1.CODEX_CLI_PROVIDER_ID,
                runId,
                startedAtEpochMs,
                endedAtEpochMs: deps.clock.nowMs(),
                code: "CODEX_NOT_LOGGED_IN",
                cause: "not-logged-in",
                preSpawn: true,
                message: notLoggedInMessage(resolved.executablePath, loginTranscript),
                helpSurface,
                recoveryAction: LOGIN_RECOVERY,
            });
        }
        let liveTools;
        let bridgeSpawn;
        try {
            liveTools = await deps.registry.listAuthoritativeToolNames();
            bridgeSpawn = await deps.registry.describeBridgeSpawn();
        }
        catch (err) {
            return fail({
                provider: types_js_1.CODEX_CLI_PROVIDER_ID,
                runId,
                startedAtEpochMs,
                endedAtEpochMs: deps.clock.nowMs(),
                code: "MCP_PROBE_FAILED",
                cause: "mcp-load-failed",
                preSpawn: true,
                message: `DreamGraph MCP bridge probe failed: ${errorMessage(err)}`,
                helpSurface,
            });
        }
        let bridgePlan;
        try {
            bridgePlan = (0, mcp_config_js_1.buildCodexMcpBridgePlan)({
                runId,
                transportToken: deps.crypto.randomToken(DEFAULT_TOKEN_BYTES),
                dreamgraphCommand: bridgeSpawn.command,
                dreamgraphArgs: bridgeSpawn.args,
                dreamgraphEnv: bridgeSpawn.env,
                liveToolNames: liveTools,
            });
        }
        catch (err) {
            return fail({
                provider: types_js_1.CODEX_CLI_PROVIDER_ID,
                runId,
                startedAtEpochMs,
                endedAtEpochMs: deps.clock.nowMs(),
                code: "DREAMGRAPH_TOOL_REGISTRY_MISMATCH",
                cause: "registry-mismatch",
                preSpawn: true,
                message: errorMessage(err),
                helpSurface,
            });
        }
        runScratchDir = await deps.fs.mkdtemp("dreamgraph-codex-cli-run-");
        const runHomeDir = deps.fs.joinPath(runScratchDir, "codex-home");
        const artifactsDir = deps.fs.joinPath(runScratchDir, "artifacts");
        await deps.fs.mkdir(runHomeDir, { recursive: true, mode: 0o700 });
        await deps.fs.mkdir(artifactsDir, { recursive: true, mode: 0o700 });
        const sourceHome = resolveEffectiveCodexHome(input.baseEnv, deps.fs);
        const copiedCodexHomeFiles = await copyCodexHomeAuthArtifacts(deps.fs, sourceHome, runHomeDir);
        const configPath = deps.fs.joinPath(runHomeDir, bridgePlan.config.filename);
        await deps.fs.writeFile(configPath, (0, mcp_config_js_1.serializeCodexMcpConfig)(bridgePlan.config), {
            mode: 0o600,
        });
        const outputLastMessagePath = deps.fs.joinPath(artifactsDir, "last-message.txt");
        const requestManifestPath = deps.fs.joinPath(runScratchDir, "request.json");
        await deps.fs.writeFile(requestManifestPath, `${JSON.stringify({
            runId,
            provider: types_js_1.CODEX_CLI_PROVIDER_ID,
            model: input.model ?? null,
            profile: input.profile ?? null,
            invocationCwd: normalizedInvocationCwd,
            probeCwd,
            timeoutMs: input.timeoutMs,
            idleTimeoutMs: input.idleTimeoutMs ?? null,
            startedAtEpochMs,
            codexHome: runHomeDir,
            sourceCodexHome: sourceHome,
            copiedCodexHomeFiles,
            mcpConfigFile: configPath,
            outputLastMessagePath,
        }, null, 2)}\n`, { mode: 0o600 });
        // `$CODEX_HOME` points at the scratch run home, so loading config.toml here
        // is isolated from the user's persistent Codex config. Codex 0.133 rejects
        // some MCP server fields (notably args/env) when they are duplicated via
        // `-c`, so the bridge server definition must come from this config file
        // only. Caller overrides remain available for non-bridge settings.
        const mergedConfigOverrides = [
            ...(input.configOverrides ?? []),
        ];
        const runCwd = runScratchDir;
        if (!runCwd) {
            throw new Error("runCodexCli: run scratch directory was not initialized");
        }
        const argvPlan = (0, argv_js_1.buildCodexArgv)({
            workspace: runCwd,
            model: input.model,
            profile: input.profile,
            outputLastMessagePath,
            configOverrides: mergedConfigOverrides,
            skipGitRepoCheck: true,
            ignoreRules: true,
            ephemeral: true,
            helpSurface,
        });
        await deps.mcpAudit.startRecording(runId);
        auditRecording = true;
        const spawnInput = {
            command: resolved.executablePath,
            args: argvPlan.args,
            cwd: runCwd,
            env: buildSpawnEnv(input.baseEnv, runHomeDir),
            stdin: input.prompt,
            timeoutMs: input.timeoutMs,
            ...(typeof input.idleTimeoutMs === "number" && input.idleTimeoutMs > 0
                ? { idleTimeoutMs: input.idleTimeoutMs }
                : {}),
            ...(input.abortSignal ? { abortSignal: input.abortSignal } : {}),
            ...(input.onStdoutChunk ? { onStdoutChunk: input.onStdoutChunk } : {}),
            ...(input.onStderrChunk ? { onStderrChunk: input.onStderrChunk } : {}),
        };
        let spawn;
        try {
            spawn = await deps.process.spawn(spawnInput);
        }
        catch (err) {
            const recorded = await finishAudit(deps, runId);
            auditRecording = false;
            const endedAtEpochMs = deps.clock.nowMs();
            const failure = {
                code: "CODEX_RUN_NONZERO_EXIT",
                cause: "spawn-error",
                preSpawn: false,
                message: `Codex CLI spawn failed: ${errorMessage(err)}`,
            };
            const transcript = (0, transcript_js_1.normalizeCodexTranscript)({ stdout: "", stderr: errorMessage(err) });
            return Object.freeze({
                provider: types_js_1.CODEX_CLI_PROVIDER_ID,
                runId,
                startedAtEpochMs,
                endedAtEpochMs,
                totalDurationMs: endedAtEpochMs - startedAtEpochMs,
                ok: false,
                failure,
                helpSurface,
                argvPlan,
                mcpConfig: bridgePlan.config,
                transcript,
                toolCalls: Object.freeze(classifyRecorded(recorded, bridgePlan.registry.allowedTools)),
                toolCallWitnesses: transcript.toolCallWitnesses,
            });
        }
        const recorded = await finishAudit(deps, runId);
        auditRecording = false;
        const transcript = (0, transcript_js_1.normalizeCodexTranscript)({
            stdout: spawn.stdout,
            stderr: spawn.stderr,
            exitCode: spawn.exitCode,
        });
        // The MCP audit bridge is the only authoritative source for verified tool
        // results. Transcript MCP events are useful witnesses, but they are not
        // sufficient proof that DreamGraph executed and returned data.
        const toolCalls = Object.freeze(classifyRecorded(recorded, bridgePlan.registry.allowedTools));
        const transcriptWitnessedDreamGraphCalls = hasTranscriptDreamGraphToolCalls(transcript);
        const processSucceeded = spawn.exitCode === 0 && !spawn.timedOut && !spawn.aborted && !spawn.signal;
        const terminalTranscriptFailure = transcript.usageLimit !== null ||
            transcript.modelUnsupported ||
            transcript.policyDenied ||
            (transcript.notLoggedIn && countSuccessfulDreamGraphToolCalls(toolCalls) === 0);
        const failure = processSucceeded && !terminalTranscriptFailure
            ? recorded.length === 0 && (transcriptWitnessedDreamGraphCalls || hasCancelledMcpToolCallFailure(transcript))
                ? transcriptMcpAuditMissingFailure(transcript)
                : mcpRuntimeFailureFor(transcript, toolCalls)
            : spawnFailureFor(spawn, transcript, toolCalls);
        const endedAtEpochMs = deps.clock.nowMs();
        return Object.freeze({
            provider: types_js_1.CODEX_CLI_PROVIDER_ID,
            runId,
            startedAtEpochMs,
            endedAtEpochMs,
            totalDurationMs: endedAtEpochMs - startedAtEpochMs,
            ok: failure === undefined,
            ...(failure ? { failure } : {}),
            helpSurface,
            argvPlan,
            mcpConfig: bridgePlan.config,
            spawn,
            transcript,
            toolCalls,
            toolCallWitnesses: transcript.toolCallWitnesses,
        });
    }
    finally {
        if (auditRecording) {
            try {
                await deps.mcpAudit.finishRecording(runId);
            }
            catch {
                // Keep cleanup best-effort; never mask the primary failure.
            }
        }
        if (runScratchDir) {
            try {
                await deps.fs.rmRecursive(runScratchDir);
            }
            catch {
                // Best-effort cleanup after every run outcome.
            }
        }
    }
}
function notifyRunId(input, runId) {
    if (!input.onRunIdAssigned)
        return;
    try {
        input.onRunIdAssigned(runId);
    }
    catch {
        // Observer failures must not break provider execution.
    }
}
function resolveProbeCwd(invocationCwd, fs) {
    return invocationCwd ?? fs.homeDir();
}
function normalizeOptionalCwd(invocationCwd) {
    const cwd = invocationCwd?.trim();
    return cwd && cwd.length > 0 ? cwd : null;
}
async function finishAudit(deps, runId) {
    return deps.mcpAudit.finishRecording(runId);
}
function buildEnv(base) {
    const out = {};
    for (const [key, value] of Object.entries(base)) {
        if (typeof value === "string")
            out[key] = value;
    }
    return Object.freeze(out);
}
function buildSpawnEnv(base, runCodexHome) {
    const out = { ...buildEnv(base) };
    out.CODEX_HOME = runCodexHome;
    // Surface MCP load/runtime diagnostics on stderr so the orchestrator's
    // failure path can include a meaningful tail when the bridge fails to
    // initialize, and so post-hoc inspection of `transcript.diagnostics`
    // shows what Codex actually did with the MCP config. We only set this
    // when the user hasn't explicitly chosen a verbosity, so a developer
    // can still opt into deeper tracing via baseEnv.RUST_LOG.
    if (typeof base.RUST_LOG !== "string" || base.RUST_LOG.length === 0) {
        out.RUST_LOG = "info,codex_mcp_server=info,rmcp=warn";
    }
    return Object.freeze(out);
}
function resolveEffectiveCodexHome(baseEnv, fs) {
    const fromEnv = baseEnv.CODEX_HOME;
    if (typeof fromEnv === "string" && fromEnv.length > 0)
        return fromEnv;
    return fs.joinPath(fs.homeDir(), ".codex");
}
async function copyCodexHomeAuthArtifacts(fs, sourceHome, runHomeDir) {
    const copied = [];
    for (const filename of CODEX_HOME_AUTH_ARTIFACTS) {
        const raw = await fs.readFileUtf8(fs.joinPath(sourceHome, filename));
        if (raw === null)
            continue;
        await fs.writeFile(fs.joinPath(runHomeDir, filename), raw, { mode: 0o600 });
        copied.push(filename);
    }
    return Object.freeze(copied);
}
function classifyRecorded(recorded, allowlist) {
    return recorded.map((call) => ({
        call,
        classification: (0, transcript_classifier_js_1.classifyToolCall)({ server: call.server, tool: call.tool }, { authoritativeServer: types_js_1.DREAMGRAPH_AUTHORITATIVE_SERVER_NAME, allowlist }),
    }));
}
function hasTranscriptDreamGraphToolCalls(transcript) {
    return transcript.toolCalls.some((call) => call.server === types_js_1.DREAMGRAPH_AUTHORITATIVE_SERVER_NAME) ||
        transcript.toolCallWitnesses.some((call) => call.server === types_js_1.DREAMGRAPH_AUTHORITATIVE_SERVER_NAME);
}
function hasCancelledMcpToolCallFailure(transcript) {
    if (USER_CANCELLED_MCP_TOOL_CALL_RE.test(transcript.assistantText))
        return true;
    return transcript.diagnostics.some((line) => USER_CANCELLED_MCP_TOOL_CALL_RE.test(line));
}
function missingRequiredHelpFlagsMessage(surface) {
    const missing = [];
    const exec = surface.exec;
    if (!surface.root.execCommand)
        missing.push("exec command");
    if (!exec.json)
        missing.push("--json");
    if (!exec.model)
        missing.push("--model");
    if (!exec.cd)
        missing.push("--cd");
    if (!exec.sandbox)
        missing.push("--sandbox");
    if (!exec.config)
        missing.push("--config");
    if (!exec.profile)
        missing.push("--profile");
    if (!exec.addDir)
        missing.push("--add-dir");
    if (!exec.outputLastMessage)
        missing.push("--output-last-message");
    if (!exec.outputSchema)
        missing.push("--output-schema");
    if (!exec.skipGitRepoCheck)
        missing.push("--skip-git-repo-check");
    if (!exec.ignoreUserConfig)
        missing.push("--ignore-user-config");
    if (!exec.ignoreRules)
        missing.push("--ignore-rules");
    if (!exec.ephemeral)
        missing.push("--ephemeral");
    if (!exec.positionalStdinPrompt)
        missing.push("positional stdin prompt '-' argument");
    return `Codex CLI help surface is missing required support: ${missing.join(", ")}`;
}
function notLoggedInMessage(codexExecutable, transcript) {
    const detail = transcript.diagnostics.length > 0
        ? `codex login status reported: ${transcript.diagnostics.join("\n")}`
        : "codex login status did not report an authenticated session";
    return `${detail}. Run "${codexExecutable} login" in a user-visible terminal so the browser-based OpenAI login flow can open, then retry.`;
}
function spawnFailureFor(spawn, transcript, toolCalls) {
    const successfulDreamGraphCalls = countSuccessfulDreamGraphToolCalls(toolCalls);
    if (transcript.usageLimit) {
        return {
            code: "CODEX_USAGE_LIMIT",
            cause: "usage-limit",
            preSpawn: false,
            message: usageLimitMessage(transcript, successfulDreamGraphCalls),
        };
    }
    if (transcript.modelUnsupported) {
        return {
            code: "CODEX_MODEL_UNSUPPORTED",
            cause: "model-unsupported",
            preSpawn: false,
            message: `Codex CLI rejected the selected model.${failureTail(transcript)}`,
        };
    }
    const mcpToolFailure = detailedMcpToolFailureFor(transcript, successfulDreamGraphCalls);
    if (mcpToolFailure)
        return mcpToolFailure;
    if (transcript.policyDenied) {
        return {
            code: "CODEX_POLICY_DENIED",
            cause: "provider-native-restriction",
            preSpawn: false,
            message: "Codex provider-native shell/read/write execution was blocked by policy. " +
                "This does not mean DreamGraph MCP tools are unavailable; use dreamgraph:run_command for verification when it is listed." +
                failureTail(transcript),
        };
    }
    if (transcript.notLoggedIn && successfulDreamGraphCalls === 0) {
        return {
            code: "CODEX_NOT_LOGGED_IN",
            cause: "not-logged-in",
            preSpawn: false,
            message: notLoggedInMessage("codex", transcript),
            recoveryAction: LOGIN_RECOVERY,
        };
    }
    if (spawn.aborted) {
        return {
            code: "CANCELLED",
            cause: "user-cancelled",
            preSpawn: false,
            message: "Codex CLI run was cancelled by the host",
        };
    }
    if (spawn.timedOut) {
        const idle = spawn.timeoutKind === "idle";
        return {
            code: "TIMEOUT",
            cause: idle ? "idle-timeout" : "wall-timeout",
            preSpawn: false,
            message: idle
                ? `Codex CLI run exceeded idle timeout (${spawn.durationMs}ms)`
                : `Codex CLI run exceeded wall-clock timeout (${spawn.durationMs}ms)`,
        };
    }
    if (spawn.signal) {
        return {
            code: "CODEX_RUN_SIGNALED",
            cause: "process-signal",
            preSpawn: false,
            message: `Codex CLI terminated by signal ${spawn.signal}`,
        };
    }
    const tail = failureTail(transcript);
    const progress = successfulDreamGraphCalls > 0
        ? ` after ${successfulDreamGraphCalls === 1 ? "1 successful DreamGraph tool call" : `${successfulDreamGraphCalls} successful DreamGraph tool calls`}. Partial DreamGraph evidence was preserved`
        : "";
    return {
        code: "CODEX_RUN_NONZERO_EXIT",
        cause: "nonzero-exit",
        preSpawn: false,
        message: `Codex CLI exited with code ${spawn.exitCode}${progress}${tail}`,
    };
}
function detailedMcpToolFailureFor(transcript, successfulDreamGraphCalls) {
    for (const line of transcript.diagnostics) {
        const match = line.match(MCP_TOOL_FAILURE_LINE_RE);
        if (!match)
            continue;
        const server = match[1] ?? "unknown";
        const rawTool = match[2] ?? "unknown";
        const detail = match[3] ?? "";
        const text = `${rawTool} ${detail}`;
        const aliasedReadSource = rawTool === "read_source_file";
        if (aliasedReadSource || SCHEMA_ARGUMENT_FAILURE_RE.test(text)) {
            return dreamgraphToolFailure({
                code: "DREAMGRAPH_TOOL_SCHEMA_ARGS",
                cause: "schema-args-failure",
                server,
                tool: rawTool,
                successfulDreamGraphCalls,
                transcript,
                guidance: aliasedReadSource
                    ? "read_source_file is not a DreamGraph/Codex tool name; retry as read_source_code with the required repo and filePath/entity/range arguments."
                    : schemaFailureGuidance(text),
            });
        }
        if (CONTINUATION_AUTH_FAILURE_RE.test(text)) {
            return dreamgraphToolFailure({
                code: "DREAMGRAPH_TOOL_AUTHORIZATION_NEEDED",
                cause: "continuation-authorization-needed",
                server,
                tool: rawTool,
                successfulDreamGraphCalls,
                transcript,
                guidance: "The tool exists, but the pass needs an explicit bounded continuation authorization rather than a missing-tool recovery.",
            });
        }
        if (POLICY_BLOCKED_FAILURE_RE.test(text)) {
            return dreamgraphToolFailure({
                code: "DREAMGRAPH_TOOL_POLICY_BLOCKED",
                cause: "policy-blocked",
                server,
                tool: rawTool,
                successfulDreamGraphCalls,
                transcript,
                guidance: "DreamGraph MCP policy blocked this tool call. Do not classify this as Codex provider-native shell denial.",
            });
        }
        if (MISSING_TOOL_FAILURE_RE.test(text)) {
            return dreamgraphToolFailure({
                code: "DREAMGRAPH_TOOL_MISSING",
                cause: "missing-tool",
                server,
                tool: rawTool,
                successfulDreamGraphCalls,
                transcript,
                guidance: "The named MCP tool was not available in the active DreamGraph tool surface.",
            });
        }
        if (RUNTIME_MCP_TOOL_FAILURE_RE.test(text)) {
            return dreamgraphToolFailure({
                code: "DREAMGRAPH_MCP_RUNTIME_FAILURE",
                cause: "runtime-mcp-failure",
                server,
                tool: rawTool,
                successfulDreamGraphCalls,
                transcript,
                guidance: "The DreamGraph MCP runtime failed while executing an available tool; preserve partial evidence and retry the bounded tool call if appropriate.",
            });
        }
    }
    return undefined;
}
function schemaFailureGuidance(text) {
    if (/\bclass_name\b/i.test(text)) {
        return "The tool is present, but the call used invalid metadata arguments. For modify_api_surface property metadata updates, include class_name with the property member payload before retrying.";
    }
    return "The tool is present, but the call used invalid schema/arguments. Retry with the required arguments instead of treating the tool as missing.";
}
function dreamgraphToolFailure(args) {
    const progress = args.successfulDreamGraphCalls > 0
        ? ` after ${args.successfulDreamGraphCalls === 1 ? "1 successful DreamGraph tool call" : `${args.successfulDreamGraphCalls} successful DreamGraph tool calls`}. Partial DreamGraph evidence was preserved`
        : "";
    return {
        code: args.code,
        cause: args.cause,
        preSpawn: false,
        message: `DreamGraph MCP tool call ${args.server}:${args.tool} failed${progress}. ${args.guidance}` +
            failureTail(args.transcript),
    };
}
function countSuccessfulDreamGraphToolCalls(toolCalls) {
    let count = 0;
    for (const toolCall of toolCalls) {
        if (toolCall.call.server === types_js_1.DREAMGRAPH_AUTHORITATIVE_SERVER_NAME &&
            toolCall.call.isError !== true) {
            count += 1;
        }
    }
    return count;
}
function usageLimitMessage(transcript, successfulDreamGraphCalls) {
    const retry = transcript.usageLimit?.retryAt;
    const wait = retry ? `Wait until ${retry}` : "Wait before retrying";
    const countLabel = successfulDreamGraphCalls === 1 ? "1 successful DreamGraph tool call" : `${successfulDreamGraphCalls} successful DreamGraph tool calls`;
    return `Codex usage limit was reached after ${countLabel}. ${wait}, purchase more credits, or switch provider. No login action is needed.${failureTail(transcript)}`;
}
function mcpRuntimeFailureFor(transcript, toolCalls) {
    if (toolCalls.length > 0)
        return undefined;
    if (!hasMcpRuntimeFailure(transcript))
        return undefined;
    return {
        code: "MCP_PROBE_FAILED",
        cause: "mcp-load-failed",
        preSpawn: false,
        message: "Codex CLI completed without any audited DreamGraph MCP calls after reporting MCP runtime errors. " +
            "Treating the run as ungrounded instead of accepting provider-inline output without a tool trace." +
            failureTail(transcript),
    };
}
function transcriptMcpAuditMissingFailure(transcript) {
    return {
        code: "MCP_PROBE_FAILED",
        cause: "mcp-load-failed",
        preSpawn: false,
        message: "Codex reported DreamGraph MCP tool calls, but the DreamGraph audit bridge returned no tool results. " +
            "Treating the run as unverified instead of accepting transcript-only MCP events." +
            failureTail(transcript),
    };
}
function hasMcpRuntimeFailure(transcript) {
    for (const line of transcript.diagnostics) {
        if (MCP_RUNTIME_FAILURE_RE.test(line))
            return true;
    }
    return false;
}
function failureTail(transcript) {
    const parts = [];
    const diagnostics = salientFailureDiagnostics(transcript);
    if (diagnostics.length > 0) {
        parts.push(`diagnostics:\n${diagnostics.slice(-6).join("\n")}`);
    }
    else if (transcript.diagnostics.length > 0) {
        parts.push(`diagnostics:\nsuppressed ${transcript.diagnostics.length} verbose Codex diagnostic line${transcript.diagnostics.length === 1 ? "" : "s"}`);
    }
    const stdout = transcript.assistantText.trim();
    if (stdout.length > 0 && stdout.length <= 1000) {
        parts.push(`stdout:\n${stdout}`);
    }
    return parts.length > 0 ? `\n${parts.join("\n\n")}` : " (no output captured on stdout or stderr)";
}
const SALIENT_FAILURE_DIAGNOSTIC_RE = /\b(?:turn error|usage limit|rate[_ -]?limit|insufficient[_ -]?quota|unsupported[_ -]?model|model_not_supported|unsupported_model|model_not_found|invalid[_ -]?model|not logged in|login required|authentication required|blocked by policy|read-only sandbox|writing is blocked|user approval settings|mcp_tool_call failed|failed to load mcp|failed to start mcp|mcp server failed|mcp_tool_call\s+(?:failed|failure|error|cancelled|canceled))\b/i;
const GENERIC_FAILURE_DIAGNOSTIC_RE = /\b(?:error|failed|failure|fatal|panic|exception)\b/i;
const VERBOSE_CODEX_TELEMETRY_RE = /(?:^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z\s+INFO\b)|(?:\bcodex_otel\.)|(?:\bsession_loop\{)|(?:\bmodel_client\.stream_responses_websocket\b)|(?:\bfeedback_tags\b)/i;
const SOURCE_SNIPPET_DIAGNOSTIC_RE = /^\s*(?:throw\s+new\s+Error|assert\.|const\s+\w+|let\s+\w+|return\s+fail\b|if\s*\()/;
function salientFailureDiagnostics(transcript) {
    const out = [];
    for (const err of transcript.structuredErrors) {
        pushSalient(out, `${err.code ? `${err.code}: ` : ""}${err.message}`);
    }
    for (const warning of transcript.pluginSyncWarnings) {
        pushSalient(out, warning);
    }
    for (const line of transcript.diagnostics) {
        if (SOURCE_SNIPPET_DIAGNOSTIC_RE.test(line) && !SALIENT_FAILURE_DIAGNOSTIC_RE.test(line))
            continue;
        if (VERBOSE_CODEX_TELEMETRY_RE.test(line) && !SALIENT_FAILURE_DIAGNOSTIC_RE.test(line))
            continue;
        if (!SALIENT_FAILURE_DIAGNOSTIC_RE.test(line) &&
            !GENERIC_FAILURE_DIAGNOSTIC_RE.test(line) &&
            !transcript.pluginSyncWarnings.includes(line)) {
            continue;
        }
        pushSalient(out, line);
    }
    return Object.freeze(out);
}
function pushSalient(out, raw) {
    const scrubbed = scrubDiagnostic(raw);
    if (scrubbed.length === 0 || out.includes(scrubbed))
        return;
    out.push(scrubbed.length <= 300 ? scrubbed : `${scrubbed.slice(0, 300)}... [truncated ${scrubbed.length - 300} chars]`);
}
function scrubDiagnostic(line) {
    return line
        .replace(/\buser\.email="[^"]*"/g, 'user.email="[redacted]"')
        .replace(/\buser\.account_id="[^"]*"/g, 'user.account_id="[redacted]"')
        .trim();
}
function errorMessage(err) {
    return err instanceof Error ? err.message : String(err);
}
function fail(args) {
    const failure = {
        code: args.code,
        cause: args.cause,
        preSpawn: args.preSpawn,
        message: args.message,
        ...(args.recoveryAction ? { recoveryAction: args.recoveryAction } : {}),
    };
    return Object.freeze({
        provider: args.provider,
        runId: args.runId,
        startedAtEpochMs: args.startedAtEpochMs,
        endedAtEpochMs: args.endedAtEpochMs,
        totalDurationMs: args.endedAtEpochMs - args.startedAtEpochMs,
        ok: false,
        failure,
        ...(args.helpSurface ? { helpSurface: args.helpSurface } : {}),
        toolCalls: Object.freeze([]),
        toolCallWitnesses: Object.freeze([]),
    });
}
//# sourceMappingURL=orchestrator.js.map