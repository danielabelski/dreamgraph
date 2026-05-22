// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Codex CLI adapter - real process port (Slice 3).

import { spawn } from "node:child_process";
import { access, constants as FS } from "node:fs/promises";
import { delimiter, isAbsolute, join } from "node:path";

import type {
  CodexCliCommandResult,
  CodexCliProcessPort,
  CodexCliResolveResult,
  CodexCliSpawnInput,
  CodexCliSpawnResult,
} from "../orchestrator-ports.js";

const HELP_PROBE_TIMEOUT_MS = 5_000;
const VERSION_PROBE_TIMEOUT_MS = 5_000;
const SIGTERM_GRACE_MS = 1_500;
const IS_WINDOWS = process.platform === "win32";
const WINDOWS_PATH_EXTS: readonly string[] = IS_WINDOWS
  ? Array.from(new Set([...(process.env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD").split(";"), ".PS1"].map((s) => s.trim().toLowerCase()).filter(Boolean)))
  : [];

async function isExecutableFile(absPath: string): Promise<boolean> {
  try {
    await access(absPath, IS_WINDOWS ? FS.F_OK : FS.X_OK);
    return true;
  } catch {
    return false;
  }
}

function quoteForCommandLineToArgvW(arg: string): string {
  if (arg.length > 0 && !/[ \t\n\v"]/.test(arg)) return arg;
  let out = "\"";
  for (let i = 0; i <= arg.length; i++) {
    let backslashes = 0;
    while (i < arg.length && arg[i] === "\\") {
      backslashes++;
      i++;
    }
    if (i === arg.length) {
      out += "\\".repeat(backslashes * 2);
      break;
    }
    if (arg[i] === "\"") {
      out += "\\".repeat(backslashes * 2 + 1) + "\"";
    } else {
      out += "\\".repeat(backslashes) + arg[i];
    }
  }
  return `${out}\"`;
}

function escapeForCmdExe(token: string): string {
  return token.replace(/[()%!^<>&|]/g, "^$&");
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

async function resolveOnPath(binaryName: string, env: Readonly<Record<string, string | undefined>>): Promise<string | null> {
  if (isAbsolute(binaryName)) {
    if (await isExecutableFile(binaryName)) return binaryName;
    if (IS_WINDOWS) {
      for (const ext of WINDOWS_PATH_EXTS) {
        const candidate = binaryName + ext;
        if (await isExecutableFile(candidate)) return candidate;
      }
    }
    return null;
  }
  const pathVar = env.PATH ?? env.Path ?? env.path ?? "";
  if (pathVar.length === 0) return null;
  const candidates: string[] = [];
  for (const dir of pathVar.split(delimiter)) {
    if (!dir) continue;
    if (IS_WINDOWS) {
      for (const ext of WINDOWS_PATH_EXTS) candidates.push(join(dir, binaryName + ext));
      if (WINDOWS_PATH_EXTS.some((ext) => binaryName.toLowerCase().endsWith(ext))) candidates.push(join(dir, binaryName));
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

interface CapturedRun extends CodexCliCommandResult {
  readonly timeoutKind: "wall" | "idle" | null;
  readonly spawnError: Error | null;
}

interface CaptureOptions {
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly env: Readonly<Record<string, string>>;
  readonly stdin?: string;
  readonly timeoutMs: number;
  readonly idleTimeoutMs?: number;
  readonly abortSignal?: AbortSignal;
  readonly onStdoutChunk?: (chunk: string) => void;
  readonly onStderrChunk?: (chunk: string) => void;
}

function captureRun(opts: CaptureOptions): Promise<CapturedRun> {
  return new Promise<CapturedRun>((resolve) => {
    const startedAt = Date.now();
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let timeoutKind: "wall" | "idle" | null = null;
    let aborted = false;
    let settled = false;
    let timeoutTimer: NodeJS.Timeout | null = null;
    let idleTimer: NodeJS.Timeout | null = null;
    let sigkillTimer: NodeJS.Timeout | null = null;

    let child: ReturnType<typeof spawn>;
    try {
      let spawnCommand = opts.command;
      let spawnArgs = [...opts.args];
      let useVerbatimArgs = false;
      if (IS_WINDOWS && /\.ps1$/i.test(opts.command)) {
        spawnCommand = "powershell.exe";
        spawnArgs = ["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", opts.command, ...opts.args];
      } else if (IS_WINDOWS && /\.(?:cmd|bat)$/i.test(opts.command)) {
        for (let i = 0; i < opts.args.length; i++) {
          if (/[\r\n]/.test(opts.args[i] ?? "")) {
            throw new Error(`process.spawn: argv[${i}] for Windows .cmd/.bat shim contains a newline; move payload to stdin or a file`);
          }
        }
        const tokens = [opts.command, ...opts.args]
          .map((t) => quoteForCommandLineToArgvW(t))
          .map((t) => escapeForCmdExe(t))
          .join(" ");
        spawnCommand = "cmd.exe";
        spawnArgs = ["/d", "/s", "/c", `\"${tokens}\"`];
        useVerbatimArgs = true;
      }
      child = spawn(spawnCommand, spawnArgs, {
        cwd: opts.cwd,
        env: { ...opts.env },
        shell: false,
        windowsHide: true,
        windowsVerbatimArguments: useVerbatimArgs,
        stdio: ["pipe", "pipe", "pipe"],
      });
    } catch (err) {
      resolve({
        stdout: "",
        stderr: "",
        exitCode: null,
        signal: null,
        durationMs: Date.now() - startedAt,
        timedOut: false,
        timeoutKind: null,
        aborted: false,
        spawnError: err instanceof Error ? err : new Error(String(err)),
      });
      return;
    }

    const settle = (result: Omit<CapturedRun, "durationMs">) => {
      if (settled) return;
      settled = true;
      if (timeoutTimer) clearTimeout(timeoutTimer);
      if (idleTimer) clearTimeout(idleTimer);
      if (sigkillTimer) clearTimeout(sigkillTimer);
      if (opts.abortSignal) opts.abortSignal.removeEventListener("abort", onAbort);
      resolve({ ...result, durationMs: Date.now() - startedAt });
    };

    const killChild = () => {
      try {
        child.kill("SIGTERM");
      } catch {
        // child may already be gone
      }
      sigkillTimer = setTimeout(() => {
        try {
          child.kill("SIGKILL");
        } catch {
          // child may already be gone
        }
      }, SIGTERM_GRACE_MS);
      sigkillTimer.unref?.();
    };

    const onAbort = () => {
      aborted = true;
      killChild();
    };

    if (opts.abortSignal) {
      if (opts.abortSignal.aborted) onAbort();
      else opts.abortSignal.addEventListener("abort", onAbort, { once: true });
    }

    timeoutTimer = setTimeout(() => {
      timedOut = true;
      timeoutKind = "wall";
      killChild();
    }, opts.timeoutMs);
    timeoutTimer.unref?.();

    const idleBudget = opts.idleTimeoutMs;
    const armIdleTimer = () => {
      if (!Number.isFinite(idleBudget) || (idleBudget as number) <= 0) return;
      if (idleTimer) clearTimeout(idleTimer);
      idleTimer = setTimeout(() => {
        timedOut = true;
        timeoutKind = "idle";
        killChild();
      }, idleBudget as number);
      idleTimer.unref?.();
    };
    armIdleTimer();

    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
      stdout += chunk;
      armIdleTimer();
      opts.onStdoutChunk?.(chunk);
    });
    child.stderr?.on("data", (chunk: string) => {
      stderr += chunk;
      armIdleTimer();
      opts.onStderrChunk?.(chunk);
    });

    child.on("error", (err) => {
      settle({ stdout, stderr, exitCode: null, signal: null, timedOut, timeoutKind, aborted, spawnError: err });
    });
    child.on("close", (code, signal) => {
      settle({
        stdout,
        stderr,
        exitCode: typeof code === "number" ? code : null,
        signal: (signal as NodeJS.Signals | null) ?? null,
        timedOut,
        timeoutKind,
        aborted,
        spawnError: null,
      });
    });

    if (opts.stdin !== undefined) {
      child.stdin?.end(opts.stdin);
    } else {
      child.stdin?.end();
    }
  });
}

function asCommandResult(result: CapturedRun): CodexCliCommandResult {
  return Object.freeze({
    stdout: result.stdout,
    stderr: result.stderr,
    exitCode: result.exitCode,
    signal: result.signal,
    durationMs: result.durationMs,
    timedOut: result.timedOut,
    aborted: result.aborted,
  });
}

async function runCommand(input: {
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly env: Readonly<Record<string, string>>;
  readonly timeoutMs: number;
}): Promise<CodexCliCommandResult> {
  const result = await captureRun(input);
  if (result.spawnError) throw result.spawnError;
  return asCommandResult(result);
}

export const HOST_PROCESS: CodexCliProcessPort = Object.freeze({
  async resolveExecutable(binaryName: string): Promise<CodexCliResolveResult | null> {
    if (typeof binaryName !== "string" || binaryName.length === 0) {
      throw new Error("resolveExecutable: binaryName must be a non-empty string");
    }
    const resolved = await resolveOnPath(binaryName, process.env);
    if (!resolved) return null;
    let versionString: string | null = null;
    try {
      const v = await captureRun({ command: resolved, args: ["--version"], cwd: process.cwd(), env: filteredEnv(process.env), timeoutMs: VERSION_PROBE_TIMEOUT_MS });
      if (!v.spawnError && v.exitCode === 0) versionString = v.stdout.trim().split(/\r?\n/, 1)[0] ?? null;
    } catch {
      versionString = null;
    }
    return Object.freeze({ executablePath: resolved, versionString });
  },

  async runRootHelp(input: { readonly command: string; readonly cwd: string; readonly env: Readonly<Record<string, string>> }): Promise<CodexCliCommandResult> {
    return runCommand({ ...input, args: ["--help"], timeoutMs: HELP_PROBE_TIMEOUT_MS });
  },

  async runExecHelp(input: { readonly command: string; readonly cwd: string; readonly env: Readonly<Record<string, string>> }): Promise<CodexCliCommandResult> {
    return runCommand({ ...input, args: ["exec", "--help"], timeoutMs: HELP_PROBE_TIMEOUT_MS });
  },

  async runLoginStatus(input: { readonly command: string; readonly cwd: string; readonly env: Readonly<Record<string, string>> }): Promise<CodexCliCommandResult> {
    return runCommand({ ...input, args: ["login", "status"], timeoutMs: HELP_PROBE_TIMEOUT_MS });
  },

  async spawn(input: CodexCliSpawnInput): Promise<CodexCliSpawnResult> {
    if (!Number.isFinite(input.timeoutMs) || input.timeoutMs <= 0) {
      throw new Error("process.spawn: timeoutMs must be a positive finite number");
    }
    const result = await captureRun(input);
    if (result.spawnError) throw result.spawnError;
    return Object.freeze({
      stdout: result.stdout,
      stderr: result.stderr,
      exitCode: result.exitCode,
      signal: result.signal,
      durationMs: result.durationMs,
      timedOut: result.timedOut,
      timeoutKind: result.timeoutKind,
      aborted: result.aborted,
    });
  },
});

function filteredEnv(env: NodeJS.ProcessEnv): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (typeof value === "string") out[key] = value;
  }
  return out;
}
