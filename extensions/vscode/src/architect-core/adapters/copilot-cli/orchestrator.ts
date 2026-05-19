// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Copilot CLI adapter — orchestrator (Slice 2).
//
// `runCopilotCli` is the single entry point that turns a Copilot-CLI
// run request into a normalized `CopilotCliRunResult`. It performs
// the six effectful steps the user-facing surface requires:
//
//   1. Resolve the `copilot` executable, probe `--help`, and verify
//      the user is logged in. Reject runs where the help surface is
//      missing required flags or the persistent Copilot config does
//      not record an active GitHub login.
//   2. Validate the live in-process DreamGraph MCP server actually
//      exposes every tool in `COPILOT_REQUIRED_AUTHORITATIVE_TOOLS`.
//   3. Materialize a per-run scratch directory containing
//      `mcp-config.json` (token-scoped, dreamgraph-only) and, when the
//      prompt overflows the inline-argv budget, `prompt.txt`.
//   4. Spawn `copilot` with the structured argv from `buildCopilotArgv`,
//      including `--additional-mcp-config <inline-json>` so Copilot
//      loads the DreamGraph MCP for this single session WITHOUT
//      discarding the user's persistent `COPILOT_HOME` (and thus
//      their auth tokens). The CLI accepts ONLY inline JSON for this
//      flag — `@<file>` references are rejected with an `Invalid
//      JSON` error, verified empirically against the installed CLI.
//   5. Snapshot the MCP audit recorder for the run and classify every
//      observed tool call via `classifyToolCall`.
//   6. Normalize stdout/stderr + classified tool calls into a single
//      result envelope ready for the eventual `ProviderPort` adapter
//      to map onto `PassResult` / `ArchitectRunResult`.
//
// The per-run scratch directory is scrubbed in `finally` regardless of
// outcome. The user's `COPILOT_HOME` is NEVER written to or moved.
//
// All effectful work is delegated to injected ports (`orchestrator-
// ports.ts`); the orchestrator itself contains no `child_process`,
// `fs`, `crypto`, or `vscode` imports. That makes the entire flow
// unit-testable with `node:test` and fake ports.

import {
  COPILOT_REQUIRED_AUTHORITATIVE_TOOLS,
  DREAMGRAPH_AUTHORITATIVE_SERVER_NAME,
  type CopilotArgvPlan,
  type CopilotCliErrorCode,
  type CopilotCliProviderId,
  type CopilotHelpSurface,
  type CopilotMcpConfigArtifact,
  type ToolCallClass,
} from "./types.js";
import { isHelpSurfaceSupported, parseCopilotHelpSurface } from "./help-probe.js";
import { buildAuthoritativeAllowlist } from "./allowlist.js";
import {
  buildCopilotMcpConfig,
  serializeCopilotMcpConfig,
} from "./mcp-config.js";
import { buildCopilotArgv } from "./argv.js";
import { classifyToolCall } from "./transcript-classifier.js";
import { normalizeCopilotTranscript, type CopilotCliTranscript } from "./transcript.js";
import {
  createCopilotCliEventStream,
  type CliJsonEvent,
} from "./event-stream.js";
import {
  type CopilotCliClockPort,
  type CopilotCliCryptoPort,
  type CopilotCliFsPort,
  type CopilotCliMcpAuditPort,
  type CopilotCliProcessPort,
  type CopilotCliRegistryPort,
  type CopilotCliSpawnResult,
  type RecordedMcpToolCall,
} from "./orchestrator-ports.js";

// ---------------------------------------------------------------------------
// Inputs / outputs
// ---------------------------------------------------------------------------

export interface CopilotCliRunInput {
  /**
   * The user-visible prompt the model will see. The orchestrator passes
   * this through `--prompt` verbatim; it MUST be pre-composed by the
   * caller (no implicit context, no implicit framing).
   */
  readonly prompt: string;
  /**
   * Optional model selector. Forwarded as `--model <model>` when set.
   * The orchestrator does not validate the value (versions evolve).
   */
  readonly model?: string;
  /**
   * Working directory for the spawned CLI. The orchestrator never
   * creates files here — only `COPILOT_HOME` receives writes.
   */
  readonly invocationCwd: string;
  /**
   * Hard wall-clock cap. Required (no implicit infinite runs).
   */
  readonly timeoutMs: number;
  /**
   * Optional cancellation signal forwarded to the spawn port.
   */
  readonly abortSignal?: AbortSignal;
  /**
   * Live stdout chunk listener. Forwarded to the spawn port unchanged.
   */
  readonly onStdoutChunk?: (chunk: string) => void;
  /**
   * Live stderr chunk listener. Forwarded to the spawn port unchanged.
   */
  readonly onStderrChunk?: (chunk: string) => void;
  /**
   * Base process environment to inherit (typically `process.env` from
   * the host). The orchestrator copies it untouched into the spawned
   * CLI's environment so the user's persistent `COPILOT_HOME` (and
   * therefore their GitHub auth tokens) flows through unchanged. The
   * adapter NEVER overrides `COPILOT_HOME` — doing so would discard
   * the auth tokens the CLI needs for its non-interactive `--prompt`
   * mode and silently exit non-zero with no output.
   */
  readonly baseEnv: Readonly<Record<string, string | undefined>>;
  /**
   * Override the binary name. Defaults to `"copilot"`. Useful in tests
   * and when packagers ship a renamed binary.
   */
  readonly binaryName?: string;
  /**
   * Optional callback invoked synchronously as soon as the orchestrator
   * has minted the `runId` for this invocation, before the CLI is
   * spawned and before `mcpAudit.startRecording` runs. Used by the
   * provider-port layer to subscribe to the live audit NDJSON file at
   * the earliest possible moment so no tool calls are missed.
   */
  readonly onRunIdAssigned?: (runId: string) => void;
  /**
   * Optional per-event callback for the CLI's `--output-format json`
   * NDJSON stdout stream. Receives every parsed event (tool starts/
   * completes, assistant message/reasoning deltas, the final
   * `result` summary, plus any unrecognized event surfaced as
   * `kind: "other"`). Always set by the production provider-port to
   * drive the authoritative live UX. Handler exceptions are
   * swallowed so a buggy consumer cannot break the run.
   */
  readonly onCliEvent?: (event: CliJsonEvent) => void;
}

export interface CopilotCliDeps {
  readonly fs: CopilotCliFsPort;
  readonly process: CopilotCliProcessPort;
  readonly crypto: CopilotCliCryptoPort;
  readonly clock: CopilotCliClockPort;
  readonly registry: CopilotCliRegistryPort;
  readonly mcpAudit: CopilotCliMcpAuditPort;
}

export interface ClassifiedToolCall {
  readonly call: RecordedMcpToolCall;
  readonly classification: ToolCallClass;
}

export interface CopilotCliFailure {
  readonly code: CopilotCliErrorCode;
  readonly message: string;
  /** True when no spawn occurred (failure happened during validation). */
  readonly preSpawn: boolean;
}

export interface CopilotCliRunResult {
  /** Stable provider identifier. */
  readonly provider: CopilotCliProviderId;
  /** Run identifier minted by the crypto port. */
  readonly runId: string;
  /** Wall-clock start (epoch ms) measured by the clock port. */
  readonly startedAtEpochMs: number;
  /** Wall-clock end (epoch ms) measured by the clock port. */
  readonly endedAtEpochMs: number;
  /** Total wall-clock duration in ms (`endedAtEpochMs - startedAtEpochMs`). */
  readonly totalDurationMs: number;
  /**
   * `true` when the spawn returned exit code 0 AND validation passed.
   * `false` for any pre-spawn failure or non-zero exit.
   */
  readonly ok: boolean;
  /**
   * Populated only when `ok === false`. The orchestrator writes a
   * single failure descriptor; iteration is the caller's responsibility.
   */
  readonly failure?: CopilotCliFailure;
  /** Help-surface snapshot used for the run (when reached). */
  readonly helpSurface?: CopilotHelpSurface;
  /** Argv plan that was actually passed to spawn (when reached). */
  readonly argvPlan?: CopilotArgvPlan;
  /** MCP config artifact written to `COPILOT_HOME` (when reached). */
  readonly mcpConfig?: CopilotMcpConfigArtifact;
  /** Spawn outcome (when reached). */
  readonly spawn?: CopilotCliSpawnResult;
  /** Normalized transcript (when reached). */
  readonly transcript?: CopilotCliTranscript;
  /** Classified MCP tool calls observed during the run. */
  readonly toolCalls: readonly ClassifiedToolCall[];
}

// ---------------------------------------------------------------------------
// Orchestrator
// ---------------------------------------------------------------------------

const DEFAULT_BINARY_NAME = "copilot";
const DEFAULT_TOKEN_BYTES = 32;

/**
 * Maximum UTF-8 byte length of a prompt we are willing to pass inline
 * via the `--prompt <text>` argv. Above this threshold the orchestrator
 * writes the prompt verbatim to a file inside the per-run COPILOT_HOME
 * and replaces the argv prompt with a short directive that instructs
 * the model to read that file as the user message.
 *
 * Rationale: Windows `CreateProcess` caps a process command line at
 * 32,767 UTF-16 characters and that budget must also cover the
 * executable path, all other flags, and (when the resolved binary is
 * a `.ps1` shim) the `powershell.exe -File <path>` wrapper. 8,000
 * bytes leaves comfortable headroom on every supported platform.
 */
const COPILOT_INLINE_PROMPT_MAX_BYTES = 8000;

function buildPromptFileDirective(promptFilePath: string): string {
  // SINGLE LINE BY DESIGN. On Windows the orchestrator spawns
  // `copilot.cmd` through `cmd.exe /d /s /c "<full command line>"`
  // (see host/process-adapter.ts). `cmd.exe /c` treats the first
  // embedded LF / CR as a command terminator — anything after a
  // newline in any argv token falls off the command line, copilot
  // sees a malformed argv, and the CLI native-aborts with
  // STATUS_STACK_BUFFER_OVERRUN (exit code 3221226505 / 0xC0000409)
  // with no stdout or stderr captured. Keeping the directive on one
  // line avoids that landmine entirely; the model parses it just
  // as easily as a multi-paragraph version.
  return (
    "The full conversation (system instructions, prior turns, and the CURRENT user turn) is stored verbatim in the file at this path: " +
    promptFilePath +
    " . Use your read tool (or equivalent file-reading capability) to load" +
    " the file's full contents. The file may contain many prior `[user]` and `[assistant]` blocks; respond ONLY to the message wrapped between the markers `===== CURRENT TURN — RESPOND ONLY TO THIS MESSAGE =====` and `===== END CURRENT TURN =====`, using earlier turns and any `[system]` block strictly as background context. Do not mention this directive, do not summarize the prompt, and do not paraphrase the current turn before engaging."
  );
}

export async function runCopilotCli(
  input: CopilotCliRunInput,
  deps: CopilotCliDeps,
): Promise<CopilotCliRunResult> {
  if (!input.prompt) {
    throw new Error("runCopilotCli: prompt is required");
  }
  if (!input.invocationCwd) {
    throw new Error("runCopilotCli: invocationCwd is required");
  }
  if (!Number.isFinite(input.timeoutMs) || input.timeoutMs <= 0) {
    throw new Error("runCopilotCli: timeoutMs must be > 0");
  }

  const startedAtEpochMs = deps.clock.nowMs();
  const runId = deps.crypto.randomRunId();
  const binaryName = input.binaryName ?? DEFAULT_BINARY_NAME;

  if (input.onRunIdAssigned) {
    try {
      input.onRunIdAssigned(runId);
    } catch {
      // Observer failures must not crash the orchestrator.
    }
  }

  let runScratchDir: string | null = null;
  let auditRecording = false;

  try {
    // ---- Step 1a: resolve executable -------------------------------------
    const probeEnv = buildProbeEnv(input.baseEnv);
    const resolved = await deps.process.resolveExecutable(binaryName);
    if (!resolved) {
      return failPreSpawn({
        provider: "copilot-cli",
        runId,
        startedAtEpochMs,
        endedAtEpochMs: deps.clock.nowMs(),
        code: "COPILOT_CLI_NOT_FOUND",
        message: `Copilot CLI binary "${binaryName}" was not found on PATH`,
      });
    }

    // ---- Step 1b: probe --help -------------------------------------------
    const help = await deps.process.runHelp({
      command: resolved.executablePath,
      cwd: input.invocationCwd,
      env: probeEnv,
    });
    const helpSurface = parseCopilotHelpSurface(
      help.helpText,
      help.versionString ?? resolved.versionString,
    );
    if (!isHelpSurfaceSupported(helpSurface)) {
      return failPreSpawn({
        provider: "copilot-cli",
        runId,
        startedAtEpochMs,
        endedAtEpochMs: deps.clock.nowMs(),
        code: "COPILOT_HELP_SURFACE_UNSUPPORTED",
        message: missingRequiredHelpFlagsMessage(helpSurface),
        helpSurface,
      });
    }

    // ---- Step 1c: verify user is logged in -------------------------------
    // Copilot CLI's non-interactive mode silently exits non-zero with
    // zero output when invoked without a valid login. Catch that case
    // pre-spawn so the host can surface a `copilot login` instruction
    // instead of a baffling "exited with code 1" message.
    const loginStatus = await checkCopilotLoginStatus(input.baseEnv, deps.fs);
    if (!loginStatus.loggedIn) {
      return failPreSpawn({
        provider: "copilot-cli",
        runId,
        startedAtEpochMs,
        endedAtEpochMs: deps.clock.nowMs(),
        code: "COPILOT_NOT_LOGGED_IN",
        message: notLoggedInMessage(resolved.executablePath, loginStatus),
        helpSurface,
      });
    }

    // ---- Step 2: validate authoritative tool registry --------------------
    const liveTools = await deps.registry.listAuthoritativeToolNames();
    const allowlist = buildAuthoritativeAllowlist(liveTools);
    if (!allowlist.ok) {
      return failPreSpawn({
        provider: "copilot-cli",
        runId,
        startedAtEpochMs,
        endedAtEpochMs: deps.clock.nowMs(),
        code: "DREAMGRAPH_TOOL_REGISTRY_MISMATCH",
        message:
          `In-process DreamGraph MCP server is missing required authoritative tool(s): ` +
          allowlist.missingRequired.join(", "),
        helpSurface,
      });
    }

    // ---- Step 3: materialize per-run scratch dir ------------------------
    //
    // The adapter follows the LARGE PAYLOAD ISOLATION RULE
    // (see argv.ts): argv stays tiny; semantic payloads (MCP
    // manifest, prompt, authority policy, request manifest) live in
    // a per-run directory laid out as:
    //
    //   <runDir>/
    //     copilot-home/         ← isolated COPILOT_HOME for this run
    //       mcp-config.json     ← per-run authoritative MCP manifest
    //       config.json         ← cloned from the user's source HOME
    //       … (other auth/settings/agents files cloned)
    //     request.json          ← audit manifest for this run
    //     prompt.md             ← verbatim prompt text
    //     authority-policy.json ← allow/deny snapshot
    //     artifacts/            ← placeholder for downstream artifacts
    //
    // The CLI is then spawned with `COPILOT_HOME=<runDir>/copilot-home`,
    // which is the documented data-plane channel for MCP config.
    // No JSON, no prompt text, no schemas travel through argv.
    const bridge = await deps.registry.describeBridgeSpawn();
    const transportToken = deps.crypto.randomToken(DEFAULT_TOKEN_BYTES);
    const mcpConfig = buildCopilotMcpConfig({
      runId,
      transportToken,
      dreamgraphCommand: bridge.command,
      dreamgraphArgs: bridge.args,
      dreamgraphEnv: bridge.env,
      allowlist: allowlist.tools,
    });

    runScratchDir = await deps.fs.mkdtemp("dreamgraph-copilot-cli-run-");
    const runHomeDir = deps.fs.joinPath(runScratchDir, "copilot-home");
    const runArtifactsDir = deps.fs.joinPath(runScratchDir, "artifacts");
    await deps.fs.mkdir(runHomeDir, { recursive: true, mode: 0o700 });
    await deps.fs.mkdir(runArtifactsDir, { recursive: true, mode: 0o700 });

    // Clone the user's source COPILOT_HOME into the per-run home so
    // the CLI keeps its persistent GitHub auth (config.json),
    // settings, custom agents, etc. Skip `mcp-config.json` so the
    // adapter's per-run manifest written next is the only one.
    // `loginStatus.copilotHome` was resolved earlier from the same
    // base env using the documented `$COPILOT_HOME` precedence.
    await deps.fs.copyDirRecursive(loginStatus.copilotHome, runHomeDir, {
      excludeNames: ["mcp-config.json"],
    });

    // Write the per-run authoritative MCP manifest. Pretty-printed
    // (two-space indent + trailing newline) for stable diffs and
    // audit hashing. The CLI reads it from `<COPILOT_HOME>/mcp-config.json`.
    const mcpConfigPath = deps.fs.joinPath(runHomeDir, mcpConfig.filename);
    await deps.fs.writeFile(
      mcpConfigPath,
      serializeCopilotMcpConfig(mcpConfig),
      { mode: 0o600 },
    );

    // Write the verbatim prompt to disk. Done unconditionally so the
    // audit trail always contains the exact text that drove the run,
    // even when the prompt also fits inline on argv.
    const promptFilePath = deps.fs.joinPath(runScratchDir, "prompt.md");
    await deps.fs.writeFile(promptFilePath, input.prompt, { mode: 0o600 });

    // Write the authority-policy snapshot — allow/deny rules in the
    // shape they will be enforced on argv. Pure data; no secrets.
    const authorityPolicyPath = deps.fs.joinPath(runScratchDir, "authority-policy.json");
    await deps.fs.writeFile(
      authorityPolicyPath,
      `${JSON.stringify({
        runId,
        authoritativeServer: DREAMGRAPH_AUTHORITATIVE_SERVER_NAME,
        allowedTools: [...allowlist.tools],
        deniedInlineTools: ["shell", "write"],
      }, null, 2)}\n`,
      { mode: 0o600 },
    );

    // Write the run request manifest. Re-states the run-shaping
    // inputs (model, timeout, cwd, file pointers) so a forensic
    // reader can reconstruct the invocation without parsing argv.
    // Sensitive material (transport token) is intentionally omitted.
    const requestManifestPath = deps.fs.joinPath(runScratchDir, "request.json");
    await deps.fs.writeFile(
      requestManifestPath,
      `${JSON.stringify({
        runId,
        provider: "copilot-cli",
        model: input.model ?? null,
        invocationCwd: input.invocationCwd,
        timeoutMs: input.timeoutMs,
        startedAtEpochMs,
        copilotHome: runHomeDir,
        promptFile: promptFilePath,
        mcpConfigFile: mcpConfigPath,
        authorityPolicyFile: authorityPolicyPath,
        artifactsDir: runArtifactsDir,
      }, null, 2)}\n`,
      { mode: 0o600 },
    );

    // ---- Step 4: build argv + spawn --------------------------------------
    // Windows CreateProcess caps argv at ~32 KB. Any prompt larger
    // than `COPILOT_INLINE_PROMPT_MAX_BYTES` is replaced in argv by a
    // short directive that points the model at `<runDir>/prompt.md`,
    // which has already been written above.
    const promptByteLength = Buffer.byteLength(input.prompt, "utf8");
    let promptForArgv = input.prompt;
    const addDirs: string[] = [];
    if (promptByteLength > COPILOT_INLINE_PROMPT_MAX_BYTES) {
      promptForArgv = buildPromptFileDirective(promptFilePath);
      // The CLI's read tool defaults to the invocation cwd; expose the
      // run scratch dir so it can actually load `prompt.md`.
      addDirs.push(runScratchDir);
    }

    const argvPlan = buildCopilotArgv({
      prompt: promptForArgv,
      model: input.model,
      authoritativeServer: DREAMGRAPH_AUTHORITATIVE_SERVER_NAME,
      authoritativeAllowlist: allowlist.tools,
      helpSurface,
      addDirs,
    });

    await deps.mcpAudit.startRecording(runId);
    auditRecording = true;

    // Build the NDJSON event-stream parser BEFORE spawn so every
    // stdout chunk — including chunks delivered during partial-line
    // boundaries — flows through it. The user's original
    // `onStdoutChunk` (if any) still receives the raw bytes for
    // forensic/debug purposes; the parser is purely additive.
    const cliEventStream = createCopilotCliEventStream();
    const dispatchEvent = (event: CliJsonEvent): void => {
      if (!input.onCliEvent) return;
      try {
        input.onCliEvent(event);
      } catch {
        // observer failures must not break the spawn
      }
    };
    const stdoutTap = (chunk: string): void => {
      // Forward to original observer first so a slow parser never
      // delays raw chunk visibility.
      if (input.onStdoutChunk) {
        try {
          input.onStdoutChunk(chunk);
        } catch {
          // observer failures must not break the spawn
        }
      }
      for (const ev of cliEventStream.feed(chunk)) {
        dispatchEvent(ev);
      }
    };

    const spawnEnv = buildSpawnEnv(input.baseEnv, runHomeDir);
    const spawnInput = {
      command: resolved.executablePath,
      args: argvPlan.args,
      cwd: input.invocationCwd,
      env: spawnEnv,
      timeoutMs: input.timeoutMs,
      abortSignal: input.abortSignal,
      onStdoutChunk: stdoutTap,
      onStderrChunk: input.onStderrChunk,
    };
    const spawn = await deps.process.spawn(spawnInput);

    // Drain any partial trailing line the spawn may have left buffered.
    for (const ev of cliEventStream.flush()) {
      dispatchEvent(ev);
    }

    // ---- Step 5: snapshot audit + classify -------------------------------
    const recorded = await deps.mcpAudit.finishRecording(runId);
    auditRecording = false;
    const ctx = {
      authoritativeServer: DREAMGRAPH_AUTHORITATIVE_SERVER_NAME,
      allowlist: allowlist.tools,
    };
    const toolCalls: ClassifiedToolCall[] = recorded.map((call) => ({
      call,
      classification: classifyToolCall(
        { server: call.server, tool: call.tool },
        ctx,
      ),
    }));

    // ---- Step 6: normalize transcript + envelope -------------------------
    // With `--output-format json` (always emitted by argv.ts) the
    // authoritative assistant text comes from the event stream's
    // accumulator: `assistant.message_delta` events concatenated, or
    // an `assistant.message` event verbatim when one arrives. The raw
    // stdout NDJSON is intentionally NOT shown to users — they would
    // see JSON envelopes. We still pass it through the transcript
    // normalizer to populate `diagnostics` (stderr) and detect
    // stderr-error patterns; the stdout argument is overridden with
    // the parser snapshot. Falls back to raw stdout when the parser
    // saw zero qualifying events (defensive: test fakes that feed
    // plain text and any future CLI version that ignores the flag).
    const parserSnapshot = cliEventStream.snapshotAssistantText();
    const transcriptStdout = parserSnapshot.length > 0 ? parserSnapshot : spawn.stdout;
    const transcript = normalizeCopilotTranscript({
      stdout: transcriptStdout,
      stderr: spawn.stderr,
    });

    const endedAtEpochMs = deps.clock.nowMs();
    const exitedCleanly = spawn.exitCode === 0 && !spawn.timedOut && !spawn.aborted;
    const failure: CopilotCliFailure | undefined = exitedCleanly
      ? undefined
      : spawnFailureFor(spawn, transcript, spawnInput);

    return Object.freeze({
      provider: "copilot-cli" as const,
      runId,
      startedAtEpochMs,
      endedAtEpochMs,
      totalDurationMs: endedAtEpochMs - startedAtEpochMs,
      ok: exitedCleanly,
      failure,
      helpSurface,
      argvPlan,
      mcpConfig,
      spawn,
      transcript,
      toolCalls: Object.freeze(toolCalls),
    });
  } finally {
    if (auditRecording) {
      // Ensure the audit port is never left holding a buffer for a
      // failed run; ignore the result, errors here would mask the
      // primary failure.
      try {
        await deps.mcpAudit.finishRecording(runId);
      } catch {
        /* swallow — primary error already on the wire */
      }
    }
    if (runScratchDir) {
      try {
        await deps.fs.rmRecursive(runScratchDir);
      } catch {
        /* swallow — best-effort cleanup */
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function buildProbeEnv(
  base: Readonly<Record<string, string | undefined>>,
): Readonly<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(base)) {
    if (typeof value === "string") out[key] = value;
  }
  return Object.freeze(out);
}

function buildSpawnEnv(
  base: Readonly<Record<string, string | undefined>>,
  runCopilotHome: string,
): Readonly<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(base)) {
    if (typeof value === "string") out[key] = value;
  }
  // Pin COPILOT_HOME to the per-run isolated directory. This is the
  // documented data-plane channel for MCP config (the CLI reads
  // `<COPILOT_HOME>/mcp-config.json` on every invocation), and is
  // safe because Step 3 cloned the user's source HOME into this
  // directory so persistent auth, settings, and custom agents are
  // preserved verbatim. The override is a small fixed string — a
  // legal control-plane env value per the Large Payload Isolation
  // Rule documented in argv.ts.
  out.COPILOT_HOME = runCopilotHome;
  return Object.freeze(out);
}

// ---------------------------------------------------------------------------
// Login check
// ---------------------------------------------------------------------------

interface CopilotLoginStatus {
  /** True iff `<copilotHome>/config.json` records at least one logged-in user. */
  readonly loggedIn: boolean;
  /** Absolute path to the Copilot config dir we inspected. */
  readonly copilotHome: string;
  /** Absolute path to the `config.json` we inspected (may not exist). */
  readonly configPath: string;
  /**
   * True when `config.json` was missing (typical first-run state, before
   * the user has ever launched the CLI). False when the file existed but
   * did not record a logged-in user.
   */
  readonly configMissing: boolean;
}

/**
 * Compute the Copilot CLI's effective config directory the same way the
 * CLI itself does: honour `$COPILOT_HOME` when set, otherwise fall back
 * to `<userHome>/.copilot`.
 */
function resolveEffectiveCopilotHome(
  baseEnv: Readonly<Record<string, string | undefined>>,
  fs: CopilotCliFsPort,
): string {
  const fromEnv = baseEnv.COPILOT_HOME;
  if (typeof fromEnv === "string" && fromEnv.length > 0) return fromEnv;
  return fs.joinPath(fs.homeDir(), ".copilot");
}

async function checkCopilotLoginStatus(
  baseEnv: Readonly<Record<string, string | undefined>>,
  fs: CopilotCliFsPort,
): Promise<CopilotLoginStatus> {
  const copilotHome = resolveEffectiveCopilotHome(baseEnv, fs);
  const configPath = fs.joinPath(copilotHome, "config.json");
  const raw = await fs.readFileUtf8(configPath);
  if (raw === null) {
    return { loggedIn: false, copilotHome, configPath, configMissing: true };
  }
  // Be tolerant of the leading `// User settings belong in settings.json.`
  // comment lines the CLI writes — strip simple `//` line comments before
  // parsing. Anything more exotic falls back to "not logged in" rather
  // than throwing, since a malformed config means the CLI itself would
  // refuse to authenticate too.
  const stripped = raw.replace(/^\s*\/\/.*$/gm, "");
  let parsed: unknown;
  try {
    parsed = JSON.parse(stripped);
  } catch {
    return { loggedIn: false, copilotHome, configPath, configMissing: false };
  }
  const loggedIn =
    typeof parsed === "object" &&
    parsed !== null &&
    Array.isArray((parsed as { loggedInUsers?: unknown }).loggedInUsers) &&
    (parsed as { loggedInUsers: unknown[] }).loggedInUsers.length > 0;
  return { loggedIn, copilotHome, configPath, configMissing: false };
}

function notLoggedInMessage(
  copilotExecutable: string,
  status: CopilotLoginStatus,
): string {
  const detail = status.configMissing
    ? `no Copilot config was found at ${status.configPath}`
    : `Copilot config at ${status.configPath} does not record a logged-in user`;
  return (
    `Copilot CLI is not logged in (${detail}). ` +
    `Run "${copilotExecutable} login" in a terminal to authenticate, then retry.`
  );
}

function missingRequiredHelpFlagsMessage(s: CopilotHelpSurface): string {
  const missing: string[] = [];
  if (!s.required.prompt) missing.push("--prompt");
  if (!s.required.allowTool) missing.push("--allow-tool");
  if (!s.required.denyTool) missing.push("--deny-tool");
  if (!s.required.model) missing.push("--model");
  if (!s.required.allowAllTools) missing.push("--allow-all-tools");
  return `Copilot CLI --help is missing required flag(s): ${missing.join(", ")}`;
}

function spawnFailureFor(
  spawn: CopilotCliSpawnResult,
  transcript: CopilotCliTranscript,
  context?: CopilotCliFailureContext,
): CopilotCliFailure {
  if (spawn.aborted) {
    return {
      code: "CANCELLED",
      message: "Copilot CLI run was aborted by the host",
      preSpawn: false,
    };
  }
  if (spawn.timedOut) {
    return {
      code: "TIMEOUT",
      message: `Copilot CLI run exceeded timeout (${spawn.durationMs}ms)`,
      preSpawn: false,
    };
  }
  if (spawn.signal) {
    return {
      code: "COPILOT_RUN_SIGNALED",
      message: `Copilot CLI terminated by signal ${spawn.signal}`,
      preSpawn: false,
    };
  }
  // Surface the most useful diagnostic detail we have. The CLI prints
  // hard errors to stderr in some failure modes (MCP config, flag
  // validation) and to stdout in others (TUI-rendered runtime errors,
  // permission prompts in non-interactive mode). Include both tails so
  // the user always sees something actionable instead of a bare
  // "exited with code 1". When the run failed silently, append spawn
  // context so the host can see exactly what binary/args/cwd/env shape
  // was used without guessing.
  const tail = buildFailureTail(spawn, transcript, context);
  return {
    code: "COPILOT_RUN_NONZERO_EXIT",
    message: `Copilot CLI exited with code ${spawn.exitCode}${tail}`,
    preSpawn: false,
  };
}

const FAILURE_TAIL_MAX_CHARS = 2000;
const FAILURE_ARG_JOIN_MAX_CHARS = 1200;
const FAILURE_CWD_MAX_CHARS = 300;
const FAILURE_COMMAND_MAX_CHARS = 300;
const FAILURE_ENV_KEYS = ["COPILOT_HOME", "PATH", "HOME", "USERPROFILE", "GITHUB_TOKEN"] as const;

type CopilotCliFailureContext = {
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly timeoutMs: number;
  readonly env: Readonly<Record<string, string>>;
};

function buildFailureTail(
  spawn: CopilotCliSpawnResult,
  transcript: CopilotCliTranscript,
  context?: CopilotCliFailureContext,
): string {
  const parts: string[] = [];
  if (transcript.diagnostics.length > 0) {
    const stderrTail = transcript.diagnostics
      .slice(-12)
      .join("\n")
      .slice(-FAILURE_TAIL_MAX_CHARS);
    parts.push(`stderr:\n${stderrTail}`);
  }
  // Include a stdout tail when stderr was empty OR when stdout is very
  // short (the CLI's TUI rendering often prints multi-kilobyte status
  // dashboards on success but only a one-line error on failure).
  const stdoutTrimmed = transcript.assistantText.trim();
  if (stdoutTrimmed.length > 0 && (transcript.diagnostics.length === 0 || stdoutTrimmed.length <= 400)) {
    parts.push(`stdout:\n${stdoutTrimmed.slice(-FAILURE_TAIL_MAX_CHARS)}`);
  }
  if (parts.length === 0) {
    if (spawn.stdout.length === 0 && spawn.stderr.length === 0) {
      if (!context) {
        return " (no output captured on stdout or stderr)";
      }
      return ` (no output captured on stdout or stderr)\nspawn-context:\n${formatFailureContextBlock(context)}`;
    }
    return "";
  }
  if (context) {
    parts.push(`spawn-context:\n${formatFailureContextBlock(context)}`);
  }
  return `\n${parts.join("\n\n")}`;
}

function formatFailureContextInline(context: CopilotCliFailureContext): string {
  return [
    `command=${JSON.stringify(truncateFailureField(context.command, FAILURE_COMMAND_MAX_CHARS))}`,
    `args=${JSON.stringify(truncateFailureField(joinFailureArgs(context.args), FAILURE_ARG_JOIN_MAX_CHARS))}`,
    `cwd=${JSON.stringify(truncateFailureField(context.cwd, FAILURE_CWD_MAX_CHARS))}`,
    `timeoutMs=${context.timeoutMs}`,
    `env=${JSON.stringify(pickFailureEnv(context.env))}`,
  ].join(", ");
}

function formatFailureContextBlock(context: CopilotCliFailureContext): string {
  return [
    `command: ${truncateFailureField(context.command, FAILURE_COMMAND_MAX_CHARS)}`,
    `args: ${truncateFailureField(joinFailureArgs(context.args), FAILURE_ARG_JOIN_MAX_CHARS)}`,
    `cwd: ${truncateFailureField(context.cwd, FAILURE_CWD_MAX_CHARS)}`,
    `timeoutMs: ${context.timeoutMs}`,
    `env: ${JSON.stringify(pickFailureEnv(context.env))}`,
  ].join("\n");
}

function joinFailureArgs(args: readonly string[]): string {
  return args.map((arg) => JSON.stringify(arg)).join(" ");
}

function truncateFailureField(value: string, maxChars: number): string {
  if (value.length <= maxChars) return value;
  return `…${value.slice(-(maxChars - 1))}`;
}

function pickFailureEnv(env: Readonly<Record<string, string>>): Record<string, string> {
  const picked: Record<string, string> = {};
  for (const key of FAILURE_ENV_KEYS) {
    const value = env[key];
    if (typeof value === "string" && value.length > 0) {
      picked[key] = truncateFailureField(value, FAILURE_TAIL_MAX_CHARS);
    }
  }
  return picked;
}

function failPreSpawn(args: {
  provider: CopilotCliProviderId;
  runId: string;
  startedAtEpochMs: number;
  endedAtEpochMs: number;
  code: CopilotCliErrorCode;
  message: string;
  helpSurface?: CopilotHelpSurface;
}): CopilotCliRunResult {
  return Object.freeze({
    provider: args.provider,
    runId: args.runId,
    startedAtEpochMs: args.startedAtEpochMs,
    endedAtEpochMs: args.endedAtEpochMs,
    totalDurationMs: args.endedAtEpochMs - args.startedAtEpochMs,
    ok: false,
    failure: {
      code: args.code,
      message: args.message,
      preSpawn: true,
    },
    helpSurface: args.helpSurface,
    toolCalls: Object.freeze([] as ClassifiedToolCall[]),
  });
}
