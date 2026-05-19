// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Copilot CLI adapter — orchestrator IO ports (Slice 2).
//
// The orchestrator owns six effectful steps: probe `--help`, validate
// the live MCP tool registry, materialize a per-run `COPILOT_HOME`,
// spawn the CLI, capture stdout/stderr, and read back the audit log
// of MCP tool calls served by the in-process DreamGraph server.
//
// Every effect is hidden behind a port so the orchestrator stays
// unit-testable with `node:test` (no `child_process`, no real `fs`,
// no `node:crypto` randomness in the test paths). Real implementations
// of these ports ship in the host wiring slice.
//
// Hard rules (binding):
//  - Interfaces only in this file. No factories, no const objects.
//  - Every port method is async, even when an implementation could
//    be sync, so the orchestrator never has to special-case the wire.
//  - No port returns `void`; either a typed result or `Promise<void>`
//    explicitly.
//  - Provider-agnostic: nothing here names Anthropic/OpenAI/etc.
//    Only Copilot CLI's spawn shape, because that is what this adapter
//    exists to translate.

// ---------------------------------------------------------------------------
// Filesystem port — only the operations the orchestrator actually needs
// ---------------------------------------------------------------------------

export interface CopilotCliFsPort {
  /**
   * Create a new uniquely-named directory rooted at the host's temp
   * area whose final segment starts with `prefix`. Returns the absolute
   * path. The orchestrator uses this for the per-run `COPILOT_HOME`.
   */
  mkdtemp(prefix: string): Promise<string>;

  /**
   * Recursively create a directory if missing. The orchestrator uses
   * this for nested artifact directories (`logs/`, `audit/`).
   */
  mkdir(absPath: string, opts?: { readonly recursive?: boolean; readonly mode?: number }): Promise<void>;

  /**
   * Write a file with the given UTF-8 string. When `mode` is supplied
   * the orchestrator expects 0o600-equivalent restriction where the OS
   * supports it (the port is the single point of policy enforcement).
   */
  writeFile(absPath: string, contents: string, opts?: { readonly mode?: number }): Promise<void>;

  /**
   * Recursively delete a directory tree. Used to scrub the per-run
   * scratch dir once the run terminates (success OR failure).
   */
  rmRecursive(absPath: string): Promise<void>;

  /**
   * Recursively copy a directory tree from `srcAbsPath` to `dstAbsPath`,
   * preserving the per-file mode bits the host can express. The
   * destination MUST already exist (caller creates it via `mkdir`)
   * so the copy never accidentally clobbers an unrelated path. When
   * `excludeNames` is supplied, any directory entry whose final path
   * segment matches a name in that list is skipped (recursively — a
   * skipped directory's children are not copied).
   *
   * The orchestrator uses this to clone the user's source
   * `<COPILOT_HOME>` into a per-run isolated `COPILOT_HOME`,
   * excluding `mcp-config.json` so the per-run MCP manifest the
   * adapter writes next is not overwritten by the user's persistent
   * one. This is the data-plane delivery mechanism for MCP config —
   * see the Large Payload Isolation Rule documented in argv.ts.
   */
  copyDirRecursive(
    srcAbsPath: string,
    dstAbsPath: string,
    opts?: { readonly excludeNames?: readonly string[] },
  ): Promise<void>;

  /**
   * Read a UTF-8 file's contents. Returns `null` when the file does
   * not exist; throws for any other I/O error so the caller can
   * distinguish "absent" (a normal first-run state) from "unreadable"
   * (a real failure that must surface).
   *
   * The orchestrator uses this to inspect the user's persistent
   * `<copilotHome>/config.json` for an active GitHub login before
   * spawning Copilot in non-interactive mode (the CLI silently exits
   * non-zero with no output when invoked unauthenticated under a
   * non-TTY parent).
   */
  readFileUtf8(absPath: string): Promise<string | null>;

  /**
   * Absolute path to the host user's home directory. Used by the
   * orchestrator to compute the default Copilot CLI config location
   * (`<homeDir>/.copilot`) when `COPILOT_HOME` is not set in the
   * inherited environment.
   */
  homeDir(): string;

  /**
   * Path-join helper kept on the port so the orchestrator never imports
   * `node:path` directly (lets the test fake use a deterministic
   * separator regardless of the host OS).
   */
  joinPath(...segments: readonly string[]): string;
}

// ---------------------------------------------------------------------------
// Process port — Copilot CLI discovery, version probe, and spawn
// ---------------------------------------------------------------------------

export interface CopilotCliResolveResult {
  /** Absolute path to the resolved `copilot` executable. */
  readonly executablePath: string;
  /**
   * The `--version` line as printed by the CLI (best-effort — `null`
   * if the CLI does not expose a version banner).
   */
  readonly versionString: string | null;
}

export interface CopilotCliHelpResult {
  /** Raw `--help` output captured verbatim from stdout. */
  readonly helpText: string;
  /** Re-stated for convenience (mirrors `resolve()` result). */
  readonly versionString: string | null;
}

export interface CopilotCliSpawnInput {
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd: string;
  /** Full env passed to the child. The orchestrator constructs this. */
  readonly env: Readonly<Record<string, string>>;
  /**
   * Hard wall-clock cap for the run. The port MUST kill the process
   * if exceeded. Zero or negative is a programmer error.
   */
  readonly timeoutMs: number;
  /** Optional cancellation signal. The port forwards it to `spawn`. */
  readonly abortSignal?: AbortSignal;
  /** Live stdout chunk callback; receives decoded UTF-8 strings. */
  readonly onStdoutChunk?: (chunk: string) => void;
  /** Live stderr chunk callback; receives decoded UTF-8 strings. */
  readonly onStderrChunk?: (chunk: string) => void;
}

export interface CopilotCliSpawnResult {
  /** Concatenated UTF-8 stdout. */
  readonly stdout: string;
  /** Concatenated UTF-8 stderr. */
  readonly stderr: string;
  /** Process exit code, or `null` when terminated by signal. */
  readonly exitCode: number | null;
  /** Terminating signal name when applicable, otherwise `null`. */
  readonly signal: string | null;
  /** Wall-clock duration measured by the port. */
  readonly durationMs: number;
  /** True when the port killed the child because `timeoutMs` elapsed. */
  readonly timedOut: boolean;
  /** True when the child exited because `abortSignal` fired. */
  readonly aborted: boolean;
}

export interface CopilotCliProcessPort {
  /**
   * Locate the Copilot CLI binary on `PATH`. Returns `null` when the
   * binary is not installed. The version probe is best-effort.
   */
  resolveExecutable(binaryName: string): Promise<CopilotCliResolveResult | null>;

  /**
   * Run `<command> --help` and capture stdout. The port is responsible
   * for any short timeout it wants to enforce on the help probe.
   */
  runHelp(input: { readonly command: string; readonly cwd: string; readonly env: Readonly<Record<string, string>> }): Promise<CopilotCliHelpResult>;

  /** Spawn the CLI and wait for it to terminate. */
  spawn(input: CopilotCliSpawnInput): Promise<CopilotCliSpawnResult>;
}

// ---------------------------------------------------------------------------
// Crypto port — token + run-id generation
// ---------------------------------------------------------------------------

export interface CopilotCliCryptoPort {
  /**
   * Generate a CSPRNG-backed token. The orchestrator uses this for
   * `DREAMGRAPH_MCP_TOKEN` (the per-run secret the in-process server
   * uses to authenticate the spawned bridge).
   */
  randomToken(byteLength: number): string;
  /**
   * Generate a CSPRNG-backed run identifier suitable for filesystem
   * paths and log keys. Implementations should return a URL/path-safe
   * string with a length stable enough to compare in tests.
   */
  randomRunId(): string;
}

// ---------------------------------------------------------------------------
// Clock port — wall-clock for run timing
// ---------------------------------------------------------------------------

export interface CopilotCliClockPort {
  nowMs(): number;
}

// ---------------------------------------------------------------------------
// Registry port — bridge between the in-process MCP server and the CLI
// ---------------------------------------------------------------------------

export interface CopilotMcpBridgeSpawn {
  /**
   * Command Copilot will spawn (read by the CLI from `mcp-config.json`)
   * to start the DreamGraph stdio MCP bridge. Typically the host
   * extension ships a tiny Node entry point that re-emits the
   * in-process server's tool surface over stdio.
   */
  readonly command: string;
  readonly args: readonly string[];
  /**
   * Extra env to merge into the bridge process (the orchestrator will
   * always overwrite `DREAMGRAPH_MCP_TOKEN` and `DREAMGRAPH_RUN_ID`).
   */
  readonly env?: Readonly<Record<string, string>>;
}

export interface CopilotCliRegistryPort {
  /**
   * Names of the tools the live in-process DreamGraph MCP server
   * actually exposes RIGHT NOW. The orchestrator uses this to verify
   * `COPILOT_REQUIRED_AUTHORITATIVE_TOOLS` is satisfied before spawn.
   */
  listAuthoritativeToolNames(): Promise<readonly string[]>;

  /**
   * Concrete spawn config Copilot will use to launch the DreamGraph
   * bridge. Returned per-run so the host can vary (e.g.) the bridge
   * entry point's path between dev and packaged builds.
   */
  describeBridgeSpawn(): Promise<CopilotMcpBridgeSpawn>;
}

// ---------------------------------------------------------------------------
// Audit port — authoritative source of truth for tool calls actually served
// ---------------------------------------------------------------------------

export interface RecordedMcpToolCall {
  /** MCP server name — `"dreamgraph"` for authoritative calls. */
  readonly server: string;
  /** Tool name as seen by the MCP server. */
  readonly tool: string;
  /** JSON-stringified input arguments. */
  readonly inputJson: string;
  /** JSON-stringified result payload (truncated by the port if huge). */
  readonly resultJson: string;
  /** True when the server replied with an error. */
  readonly isError: boolean;
  /** Per-call duration measured by the bridge. */
  readonly durationMs: number;
  /** Wall-clock when the call started, in epoch ms. */
  readonly startedAtEpochMs: number;
}

export interface CopilotCliMcpAuditPort {
  /**
   * Begin capturing tool calls served by the in-process DreamGraph MCP
   * server for a specific run. Idempotent for the same `runId`.
   */
  startRecording(runId: string): Promise<void>;
  /**
   * Stop capturing and return everything observed. Calling twice for
   * the same run returns an empty array on the second call (the port
   * frees its buffer on first finish).
   */
  finishRecording(runId: string): Promise<readonly RecordedMcpToolCall[]>;
}

// ---------------------------------------------------------------------------
// Live audit port — tail of the per-run NDJSON stream for UX progress
// ---------------------------------------------------------------------------

/**
 * Live tail of the per-run MCP audit NDJSON. Emits one event per
 * tool-call the bridge appends, in append order, while the Copilot CLI
 * subprocess is still running. Closing the subscription is idempotent
 * and safe at any point in the run lifecycle.
 *
 * Purely additive to {@link CopilotCliMcpAuditPort}: `finishRecording`
 * remains the authoritative source of the complete classified tool-call
 * set. The live channel is a UX hint and may legally lose its last
 * in-flight line if the spawn dies mid-write — `finishRecording` will
 * see that line after the bridge flushes on exit.
 */
export interface CopilotCliMcpAuditLivePort {
  /**
   * Begin tailing the audit file for `runId`. The handler is invoked
   * once per appended NDJSON line, in append order, with a parsed
   * record. Malformed lines are skipped silently (same policy as the
   * batch reader). Handler exceptions are swallowed so a buggy
   * consumer cannot break the run.
   *
   * Records written between `startRecording` and `subscribe` are
   * replayed as catch-up events before any new ones are delivered.
   */
  subscribe(
    runId: string,
    handler: (call: RecordedMcpToolCall) => void,
  ): Promise<CopilotCliMcpAuditLiveSubscription>;
}

export interface CopilotCliMcpAuditLiveSubscription {
  /** Stop receiving events. Idempotent. Never throws. */
  close(): Promise<void>;
}
