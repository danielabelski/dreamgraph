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
// Patterns that indicate a real MCP load/runtime failure (the bridge never
// initialized or crashed during a tool call). The previous version of this
// regex also matched `rmcp::transport::async_rw` and "error reading from
// stream: serde error EOF" — both of which Codex emits as NORMAL teardown
// noise when it taskkills its MCP child processes at the end of a successful
// run. Matching those lines produced a false MCP_PROBE_FAILED whenever the
// model answered without invoking a tool. Keep only the patterns that are
// unambiguous load/start failures or explicit codex_mcp_server errors.
const MCP_RUNTIME_FAILURE_RE = /\b(?:codex_mcp_server::|failed to load mcp|failed to start mcp|mcp bridge|mcp server (?:failed|crashed|errored)|tools\/list (?:failed|timeout|timed out))\b/i;
const LOGIN_RECOVERY = Object.freeze({
    kind: "codex-login",
    label: "Run codex login",
    command: "codex login",
});
async function runCodexCli(input, deps) {
    if (!input.prompt) {
        throw new Error("runCodexCli: prompt is required");
    }
    if (!input.invocationCwd) {
        throw new Error("runCodexCli: invocationCwd is required");
    }
    if (!Number.isFinite(input.timeoutMs) || input.timeoutMs <= 0) {
        throw new Error("runCodexCli: timeoutMs must be > 0");
    }
    const startedAtEpochMs = deps.clock.nowMs();
    const runId = deps.crypto.randomRunId();
    const binaryName = input.binaryName ?? DEFAULT_BINARY_NAME;
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
            cwd: input.invocationCwd,
            env: probeEnv,
        });
        const execHelp = await deps.process.runExecHelp({
            command: resolved.executablePath,
            cwd: input.invocationCwd,
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
            cwd: input.invocationCwd,
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
        await deps.fs.copyDirRecursive(sourceHome, runHomeDir, {
            excludeNames: ["config.toml"],
        });
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
            invocationCwd: input.invocationCwd,
            timeoutMs: input.timeoutMs,
            idleTimeoutMs: input.idleTimeoutMs ?? null,
            startedAtEpochMs,
            codexHome: runHomeDir,
            sourceCodexHome: sourceHome,
            mcpConfigFile: configPath,
            outputLastMessagePath,
        }, null, 2)}\n`, { mode: 0o600 });
        // The MCP bridge server is written to `$CODEX_HOME/config.toml`, but we
        // ALSO surface it as explicit `-c mcp_servers.<name>.{command,args,env}=...`
        // CLI overrides so that `codex exec` reliably mounts it regardless of which
        // config source the running Codex version prioritises. The bridge overrides
        // are merged BEFORE caller-supplied ones so a caller can still tune behavior
        // (e.g. timeouts) without being able to silently swap the bridge command.
        const mergedConfigOverrides = [
            ...bridgePlan.configOverrides,
            ...(input.configOverrides ?? []),
        ];
        const argvPlan = (0, argv_js_1.buildCodexArgv)({
            workspace: input.invocationCwd,
            model: input.model,
            profile: input.profile,
            outputLastMessagePath,
            configOverrides: mergedConfigOverrides,
            helpSurface,
        });
        await deps.mcpAudit.startRecording(runId);
        auditRecording = true;
        const spawnInput = {
            command: resolved.executablePath,
            args: argvPlan.args,
            cwd: input.invocationCwd,
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
                transcript: (0, transcript_js_1.normalizeCodexTranscript)({ stdout: "", stderr: errorMessage(err) }),
                toolCalls: Object.freeze(classifyRecorded(recorded, bridgePlan.registry.allowedTools)),
            });
        }
        const recorded = await finishAudit(deps, runId);
        auditRecording = false;
        const transcript = (0, transcript_js_1.normalizeCodexTranscript)({
            stdout: spawn.stdout,
            stderr: spawn.stderr,
            exitCode: spawn.exitCode,
        });
        // The MCP audit bridge is authoritative when it has entries, but a successful
        // Codex run that recorded `mcp_tool_call` events in its own JSON stream is
        // also a witness of grounded execution. Falling back to the transcript-derived
        // tool calls here prevents a false MCP_PROBE_FAILED when the audit drained
        // empty (transport race, hiccup) but Codex itself confirmed the invocations.
        const effectiveRecorded = recorded.length > 0
            ? recorded
            : transcriptToolCallsAsRecorded(transcript.toolCalls);
        const toolCalls = Object.freeze(classifyRecorded(effectiveRecorded, bridgePlan.registry.allowedTools));
        const failure = spawn.exitCode === 0 && !spawn.timedOut && !spawn.aborted && !transcript.notLoggedIn
            ? mcpRuntimeFailureFor(transcript, toolCalls)
            : spawnFailureFor(spawn, transcript);
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
function classifyRecorded(recorded, allowlist) {
    return recorded.map((call) => ({
        call,
        classification: (0, transcript_classifier_js_1.classifyToolCall)({ server: call.server, tool: call.tool }, { authoritativeServer: types_js_1.DREAMGRAPH_AUTHORITATIVE_SERVER_NAME, allowlist }),
    }));
}
/**
 * Synthesise RecordedMcpToolCall entries from transcript-derived observations
 * so the orchestrator can classify Codex JSON event witnesses with the same
 * code path as audit-recorded calls. Used only as a fallback when the MCP
 * audit bridge returned an empty recording.
 */
function transcriptToolCallsAsRecorded(observations) {
    return observations.map((obs) => ({
        server: obs.server,
        tool: obs.tool,
        inputJson: "",
        resultJson: "",
        isError: false,
        durationMs: 0,
        startedAtEpochMs: 0,
    }));
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
function spawnFailureFor(spawn, transcript) {
    if (transcript.notLoggedIn) {
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
    return {
        code: "CODEX_RUN_NONZERO_EXIT",
        cause: "nonzero-exit",
        preSpawn: false,
        message: `Codex CLI exited with code ${spawn.exitCode}${tail}`,
    };
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
function hasMcpRuntimeFailure(transcript) {
    for (const line of transcript.diagnostics) {
        if (MCP_RUNTIME_FAILURE_RE.test(line))
            return true;
    }
    return false;
}
function failureTail(transcript) {
    const parts = [];
    if (transcript.diagnostics.length > 0) {
        parts.push(`stderr:\n${transcript.diagnostics.slice(-12).join("\n")}`);
    }
    const stdout = transcript.assistantText.trim();
    if (stdout.length > 0 && stdout.length <= 1000) {
        parts.push(`stdout:\n${stdout}`);
    }
    return parts.length > 0 ? `\n${parts.join("\n\n")}` : " (no output captured on stdout or stderr)";
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
    });
}
//# sourceMappingURL=orchestrator.js.map