"use strict";
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Codex CLI adapter - ProviderPort wrapper (Slice 4).
Object.defineProperty(exports, "__esModule", { value: true });
exports.createCodexCliProviderPort = createCodexCliProviderPort;
const allowlist_js_1 = require("./allowlist.js");
const orchestrator_js_1 = require("./orchestrator.js");
const prompt_serializer_js_1 = require("./prompt-serializer.js");
const event_stream_js_1 = require("./event-stream.js");
const transcript_js_1 = require("./transcript.js");
function validateOptions(opts) {
    if (!opts || typeof opts !== "object") {
        throw new Error("createCodexCliProviderPort: options object is required");
    }
    if (!opts.hostLlm) {
        throw new Error("createCodexCliProviderPort: hostLlm reference is required");
    }
    if (opts.invocationCwd !== undefined && typeof opts.invocationCwd !== "string") {
        throw new Error("createCodexCliProviderPort: invocationCwd must be a string when provided");
    }
    if (!Number.isFinite(opts.timeoutMs) || opts.timeoutMs <= 0) {
        throw new Error("createCodexCliProviderPort: timeoutMs must be a positive finite number");
    }
    if (!opts.baseEnv || typeof opts.baseEnv !== "object") {
        throw new Error("createCodexCliProviderPort: baseEnv object is required");
    }
    if (!opts.deps || typeof opts.deps !== "object") {
        throw new Error("createCodexCliProviderPort: deps object is required");
    }
}
function buildFailureError(result) {
    const failure = result.failure;
    const code = failure?.code ?? "CODEX_CLI_UNKNOWN_FAILURE";
    const message = failure?.message ?? "Codex CLI run failed without a failure descriptor";
    const err = new Error(`[${code}] ${message}`);
    err.codexCliFailureCode = code;
    err.codexCliRunResult = result;
    return err;
}
function projectProposal(result, classifiedCalls) {
    const content = result.transcript?.assistantText ?? "";
    const response = {
        content,
        promptTokens: 0,
        completionTokens: 0,
        durationMs: result.totalDurationMs > 0 ? result.totalDurationMs : 0,
        toolCalls: [],
        stopReason: "end_turn",
    };
    // Codex executes MCP calls inside its own process. The pass driver
    // must not dispatch any pending tool calls from this proposal.
    void classifiedCalls;
    return Object.freeze({
        response,
        toolCalls: Object.freeze([]),
    });
}
async function resolveLiveToolsManifest(options) {
    const manifest = options.cliToolsManifest;
    if (!manifest) {
        throw new Error("resolveLiveToolsManifest: cliToolsManifest is required");
    }
    const liveToolNames = await options.deps.registry.listAuthoritativeToolNames();
    const allowlist = (0, allowlist_js_1.buildAuthoritativeAllowlist)(liveToolNames);
    const live = new Set(allowlist.tools);
    const tools = manifest.tools.filter((tool) => live.has(tool));
    return {
        server: manifest.server,
        tools: Object.freeze(tools),
        ...(tools.includes("run_command")
            ? {}
            : { commandExecutionDisabledReason: "run_command was absent from the effective Codex authoritative allowlist" }),
    };
}
function createCodexCliProviderPort(options) {
    validateOptions(options);
    return Object.freeze({
        llm: options.hostLlm,
        getCapabilities() {
            return Object.freeze({ textAttachments: false, imageAttachments: false });
        },
        async callProvider(input) {
            const cliToolsManifest = options.cliToolsManifest
                ? await resolveLiveToolsManifest(options)
                : undefined;
            const promptText = (0, prompt_serializer_js_1.serializeConversationForCodexCli)(input.prompt.conversation, {
                ...(options.historyKeepLast !== undefined
                    ? { historyKeepLast: options.historyKeepLast }
                    : {}),
                markCurrentTurn: options.markCurrentTurn ?? true,
                ...(cliToolsManifest ? { cliToolsManifest } : {}),
            });
            if (options.onPromptComposed) {
                try {
                    options.onPromptComposed({
                        promptByteLength: Buffer.byteLength(promptText, "utf8"),
                        historyMessageCount: input.prompt.conversation.length,
                        mcpToolsAdvertised: cliToolsManifest?.tools.length ?? 0,
                        mcpServerAdvertised: cliToolsManifest?.server ?? null,
                        markCurrentTurn: options.markCurrentTurn ?? true,
                        model: options.model ?? null,
                    });
                }
                catch {
                    // Observer failures must not break provider execution.
                }
            }
            const liveEnabled = Boolean(options.auditLive && options.onToolCall);
            const witnessEnabled = Boolean(options.onToolWitness);
            const subHolder = { current: null };
            const stdoutEvents = (0, event_stream_js_1.createCodexCliEventStream)();
            let currentRunId = null;
            let witnessSequence = 0;
            const liveWitnessesSeen = new Set();
            let assistantStreamed = false;
            let deltasStreamed = false;
            let streamedSnapshot = "";
            const emitToolWitness = (witness) => {
                if (!witnessEnabled || !currentRunId || input.abortSignal?.aborted === true)
                    return;
                const key = [
                    witness.server,
                    witness.tool,
                    witness.status,
                    witness.detail ?? "",
                ].join("\0");
                if (liveWitnessesSeen.has(key))
                    return;
                liveWitnessesSeen.add(key);
                try {
                    options.onToolWitness?.(currentRunId, witness);
                }
                catch {
                    // observer failures must not break the spawn
                }
            };
            const onRunIdAssigned = liveEnabled || witnessEnabled
                ? (runId) => {
                    currentRunId = runId;
                    if (!liveEnabled)
                        return;
                    const live = options.auditLive;
                    const handler = options.onToolCall;
                    void live
                        .subscribe(runId, (call) => {
                        if (input.abortSignal?.aborted === true)
                            return;
                        try {
                            handler(runId, call);
                        }
                        catch {
                            // handler failures must not break the live tail
                        }
                    })
                        .then((sub) => {
                        subHolder.current = sub;
                    })
                        .catch(() => {
                        // subscription failures degrade to post-run reconciliation
                    });
                }
                : undefined;
            const onStdoutChunk = input.onStreamChunk || witnessEnabled
                ? (chunk) => {
                    const events = stdoutEvents.feed(chunk);
                    if (witnessEnabled) {
                        const witnesses = (0, transcript_js_1.projectCodexToolCallWitnesses)(events, witnessSequence);
                        witnessSequence += witnesses.length;
                        for (const witness of witnesses)
                            emitToolWitness(witness);
                    }
                    if (!input.onStreamChunk)
                        return;
                    for (const event of events) {
                        const delta = (0, event_stream_js_1.codexAssistantDelta)(event);
                        if (delta) {
                            try {
                                input.onStreamChunk?.(delta);
                                assistantStreamed = true;
                                deltasStreamed = true;
                                streamedSnapshot += delta;
                            }
                            catch {
                                // observer failures must not break the spawn
                            }
                            continue;
                        }
                        if (deltasStreamed)
                            continue;
                        const completed = (0, event_stream_js_1.codexAssistantCompletedText)(event);
                        if (!completed)
                            continue;
                        let completedChunk = "";
                        if (streamedSnapshot.length === 0) {
                            completedChunk = completed;
                        }
                        else if (completed.startsWith(streamedSnapshot)) {
                            completedChunk = completed.slice(streamedSnapshot.length);
                        }
                        if (completedChunk.length === 0)
                            continue;
                        try {
                            input.onStreamChunk?.(completedChunk);
                            assistantStreamed = true;
                            streamedSnapshot = completed;
                        }
                        catch {
                            // observer failures must not break the spawn
                        }
                    }
                }
                : undefined;
            let stderrRemainder = "";
            const onStderrChunk = witnessEnabled
                ? (chunk) => {
                    const normalized = `${stderrRemainder}${chunk}`.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
                    const lines = normalized.split("\n");
                    stderrRemainder = lines.pop() ?? "";
                    const witnesses = (0, transcript_js_1.projectCodexToolCallWitnessesFromDiagnostics)(lines, witnessSequence);
                    witnessSequence += witnesses.length;
                    for (const witness of witnesses)
                        emitToolWitness(witness);
                }
                : undefined;
            let result;
            try {
                result = await (0, orchestrator_js_1.runCodexCli)({
                    prompt: promptText,
                    ...(typeof options.invocationCwd === "string" && options.invocationCwd.length > 0
                        ? { invocationCwd: options.invocationCwd.trim() }
                        : {}),
                    timeoutMs: options.timeoutMs,
                    ...(typeof options.idleTimeoutMs === "number" && options.idleTimeoutMs > 0
                        ? { idleTimeoutMs: options.idleTimeoutMs }
                        : {}),
                    ...(options.model ? { model: options.model } : {}),
                    ...(options.profile ? { profile: options.profile } : {}),
                    ...(options.configOverrides ? { configOverrides: options.configOverrides } : {}),
                    ...(options.binaryName ? { binaryName: options.binaryName } : {}),
                    ...(input.abortSignal ? { abortSignal: input.abortSignal } : {}),
                    ...(onRunIdAssigned ? { onRunIdAssigned } : {}),
                    ...(onStdoutChunk ? { onStdoutChunk } : {}),
                    ...(onStderrChunk ? { onStderrChunk } : {}),
                    baseEnv: options.baseEnv,
                }, options.deps);
            }
            finally {
                const sub = subHolder.current;
                if (sub) {
                    try {
                        await sub.close();
                    }
                    catch {
                        // teardown failures must not propagate into the pass
                    }
                }
            }
            if (options.onRunResult) {
                try {
                    options.onRunResult(result);
                }
                catch {
                    // Observer failures must not crash the pass driver.
                }
            }
            if (!result.ok) {
                const err = buildFailureError(result);
                if (result.failure?.code === "CANCELLED" || input.abortSignal?.aborted === true) {
                    err.name = "AbortError";
                }
                throw err;
            }
            const proposal = projectProposal(result, result.toolCalls);
            for (const event of stdoutEvents.flush()) {
                const delta = (0, event_stream_js_1.codexAssistantDelta)(event);
                if (delta && input.onStreamChunk) {
                    input.onStreamChunk(delta);
                    assistantStreamed = true;
                }
            }
            if (!assistantStreamed && input.onStreamChunk && proposal.response.content.length > 0) {
                input.onStreamChunk(proposal.response.content);
            }
            return proposal;
        },
    });
}
//# sourceMappingURL=provider-port.js.map