export interface CodexCliFsPort {
    mkdtemp(prefix: string): Promise<string>;
    mkdir(absPath: string, opts?: {
        readonly recursive?: boolean;
        readonly mode?: number;
    }): Promise<void>;
    writeFile(absPath: string, contents: string, opts?: {
        readonly mode?: number;
    }): Promise<void>;
    readFileUtf8(absPath: string): Promise<string | null>;
    rmRecursive(absPath: string): Promise<void>;
    copyDirRecursive(srcAbsPath: string, dstAbsPath: string, opts?: {
        readonly excludeNames?: readonly string[];
    }): Promise<boolean>;
    homeDir(): string;
    joinPath(...segments: readonly string[]): string;
}
export interface CodexCliResolveResult {
    readonly executablePath: string;
    readonly versionString: string | null;
}
export interface CodexCliCommandResult {
    readonly stdout: string;
    readonly stderr: string;
    readonly exitCode: number | null;
    readonly signal: string | null;
    readonly durationMs: number;
    readonly timedOut: boolean;
    readonly aborted: boolean;
}
export interface CodexCliSpawnInput {
    readonly command: string;
    readonly args: readonly string[];
    readonly cwd: string;
    readonly env: Readonly<Record<string, string>>;
    readonly stdin: string;
    readonly timeoutMs: number;
    readonly idleTimeoutMs?: number;
    readonly abortSignal?: AbortSignal;
    readonly onStdoutChunk?: (chunk: string) => void;
    readonly onStderrChunk?: (chunk: string) => void;
}
export interface CodexCliSpawnResult extends CodexCliCommandResult {
    readonly timeoutKind: "wall" | "idle" | null;
}
export interface CodexCliProcessPort {
    resolveExecutable(binaryName: string): Promise<CodexCliResolveResult | null>;
    runRootHelp(input: {
        readonly command: string;
        readonly cwd: string;
        readonly env: Readonly<Record<string, string>>;
    }): Promise<CodexCliCommandResult>;
    runExecHelp(input: {
        readonly command: string;
        readonly cwd: string;
        readonly env: Readonly<Record<string, string>>;
    }): Promise<CodexCliCommandResult>;
    runLoginStatus(input: {
        readonly command: string;
        readonly cwd: string;
        readonly env: Readonly<Record<string, string>>;
    }): Promise<CodexCliCommandResult>;
    spawn(input: CodexCliSpawnInput): Promise<CodexCliSpawnResult>;
}
export interface CodexCliCryptoPort {
    randomToken(byteLength: number): string;
    randomRunId(): string;
}
export interface CodexCliClockPort {
    nowMs(): number;
}
export interface CodexMcpBridgeSpawn {
    readonly command: string;
    readonly args: readonly string[];
    readonly env?: Readonly<Record<string, string>>;
}
export interface CodexCliRegistryPort {
    listAuthoritativeToolNames(): Promise<readonly string[]>;
    describeBridgeSpawn(): Promise<CodexMcpBridgeSpawn>;
}
export interface RecordedMcpToolCall {
    readonly server: string;
    readonly tool: string;
    readonly inputJson: string;
    readonly resultJson: string;
    readonly isError: boolean;
    readonly durationMs: number;
    readonly startedAtEpochMs: number;
}
export interface CodexCliMcpAuditPort {
    startRecording(runId: string): Promise<void>;
    finishRecording(runId: string): Promise<readonly RecordedMcpToolCall[]>;
}
export interface CodexCliMcpAuditLivePort {
    subscribe(runId: string, handler: (call: RecordedMcpToolCall) => void): Promise<CodexCliMcpAuditLiveSubscription>;
}
export interface CodexCliMcpAuditLiveSubscription {
    close(): Promise<void>;
}
//# sourceMappingURL=orchestrator-ports.d.ts.map