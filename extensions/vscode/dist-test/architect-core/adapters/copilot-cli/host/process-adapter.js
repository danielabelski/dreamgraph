"use strict";
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Copilot CLI adapter — real `CopilotCliProcessPort` (Slice 3).
//
// Wraps `node:child_process.spawn` and a small `which`-style PATH
// walk so the orchestrator never has to know about Windows `.cmd`
// shims, env-var separators, or signal semantics.
//
// Policy lives in `orchestrator.ts` (which env keys to set, which
// args, which timeout). This file only translates port calls into
// stdlib calls and reports back honest result fields.
Object.defineProperty(exports, "__esModule", { value: true });
exports.HOST_PROCESS = void 0;
const node_child_process_1 = require("node:child_process");
const promises_1 = require("node:fs/promises");
const node_path_1 = require("node:path");
// Short cap for the help probe so a wedged binary cannot stall a run
// before the orchestrator's main timeout even starts.
const HELP_PROBE_TIMEOUT_MS = 5_000;
// Best-effort version probe — same short cap, and absorbed silently.
const VERSION_PROBE_TIMEOUT_MS = 5_000;
// Grace period between the polite interrupt (SIGINT / Ctrl+C) and the
// hard SIGTERM/SIGKILL escalation. Mirrors the wall-clock budget a
// human user would give a CLI to flush its NDJSON stream and exit
// cleanly after pressing Ctrl+C.
const SIGINT_GRACE_MS = 1_500;
// Grace period between SIGTERM and SIGKILL when we kill for timeout.
const SIGTERM_GRACE_MS = 1_500;
const IS_WINDOWS = process.platform === "win32";
// PATHEXT decides which extensions the OS treats as executable on
// Windows. We mirror that for our manual `which` walk so resolving
// `copilot` finds `copilot.cmd` (the npm shim) the same way `cmd.exe`
// would. We also consider `.PS1` so PowerShell-only shims (some
// nvm-for-windows package installs ship `<bin>.ps1` only) are
// discoverable; spawn-time logic wraps those through `powershell.exe`.
const WINDOWS_PATH_EXTS = IS_WINDOWS
    ? Array.from(new Set([
        ...((process.env["PATHEXT"] ?? ".COM;.EXE;.BAT;.CMD")
            .split(";")
            .map((s) => s.trim())
            .filter((s) => s.length > 0)),
        ".PS1",
    ].map((s) => s.toLowerCase())))
    : [];
async function isExecutableFile(absPath) {
    try {
        // On POSIX, check the executable bit. On Windows, plain existence
        // is enough because the OS uses PATHEXT, not a mode bit.
        await (0, promises_1.access)(absPath, IS_WINDOWS ? promises_1.constants.F_OK : promises_1.constants.X_OK);
        return true;
    }
    catch {
        return false;
    }
}
// CommandLineToArgvW-compatible quoting for a single argv token. The
// receiving program's MS C runtime startup parses the kernel-supplied
// command line per these rules, so producing them here guarantees the
// child process sees exactly the bytes we put in `arg` as one argv
// slot — even when `arg` contains spaces, embedded quotes, or
// backslash runs.
function quoteForCommandLineToArgvW(arg) {
    if (arg.length > 0 && !/[ \t\n\v"]/.test(arg)) {
        return arg;
    }
    let out = "\"";
    for (let i = 0; i <= arg.length; i++) {
        let backslashes = 0;
        while (i < arg.length && arg[i] === "\\") {
            backslashes++;
            i++;
        }
        if (i === arg.length) {
            // Trailing backslashes must be doubled before the closing quote
            // so the parser does not consume the quote itself.
            out += "\\".repeat(backslashes * 2);
            break;
        }
        if (arg[i] === "\"") {
            // Each backslash before a quote must be doubled, plus one more
            // to escape the quote itself.
            out += "\\".repeat(backslashes * 2 + 1) + "\"";
        }
        else {
            out += "\\".repeat(backslashes) + arg[i];
        }
    }
    return out + "\"";
}
// Caret-escape every cmd.exe metacharacter (& | < > ^ ( ) % ! and the
// quote char itself) so cmd.exe's own tokenizer leaves the already
// CommandLineToArgvW-quoted token alone before re-emitting it to the
// shimmed child process. Without this step, a `{` inside JSON survives
// fine but a `&` inside any argv would terminate cmd.exe's command
// parsing prematurely.
//
// IMPORTANT: `"` is intentionally NOT in this character class. The
// `quoteForCommandLineToArgvW` step above has already wrapped the
// token in literal `"` delimiters that must reach cmd.exe AS quote
// delimiters so its tokenizer treats the JSON payload (with embedded
// `\"`) as a single argv slot. Caret-escaping those quotes would
// hide them from cmd.exe and the tokenizer would split the JSON on
// every interior `\` boundary — exactly the "too many arguments"
// failure mode we hit before this fix.
function escapeForCmdExe(token) {
    return token.replace(/[()%!^<>&|]/g, "^$&");
}
// On Windows, ask PowerShell to resolve the command. PowerShell uses
// a richer resolver than `cmd.exe`'s `where` (it knows about junctions,
// per-user PATH overlays, ExternalScript shims, etc.), and it is the
// resolver users have when they type the command into the same shell
// that hosts VS Code. We constrain to `Application,ExternalScript` so
// PowerShell functions/aliases never leak through (they cannot be
// spawned by `child_process`). Returns null if PowerShell itself is
// missing or the command is not found.
//
// Extension-priority filter: when several entries shadow each other on
// PATH (e.g. VS Code's own shim AND an npm-global shim), prefer the
// extensions whose argv handling we can drive losslessly. `.exe`/`.cmd`
// shims expose the child to plain Win32 CreateProcess + cmd.exe
// tokenization, which we wrap with `windowsVerbatimArguments` and
// caret/CommandLineToArgvW quoting at spawn time. `.bat` shims that
// re-launch via `powershell -File` and `.ps1` ExternalScripts go
// through PowerShell's parameter binder, which silently strips the
// double quotes around JSON payloads — that mangling is what produces
// the `Invalid JSON` / `too many arguments` errors users see when
// `--additional-mcp-config '{"mcpServers":...}'` is in the argv. So
// we score each candidate and pick the lossless one when possible,
// falling back to lossy types only if the user explicitly has nothing
// else on PATH.
function rankWindowsShimByExtension(sourcePath) {
    const lower = sourcePath.toLowerCase();
    if (lower.endsWith(".exe"))
        return 0;
    if (lower.endsWith(".cmd"))
        return 1;
    if (lower.endsWith(".com"))
        return 2;
    if (lower.endsWith(".bat"))
        return 3;
    if (lower.endsWith(".ps1"))
        return 4;
    return 5;
}
async function resolveViaPowerShell(binaryName) {
    if (!IS_WINDOWS)
        return null;
    // `binaryName` flows in from user settings; sanitize for PowerShell
    // single-quoted string interpolation by doubling embedded single
    // quotes. Reject any control characters outright.
    if (/[\u0000-\u001f]/.test(binaryName))
        return null;
    const quoted = binaryName.replace(/'/g, "''");
    // Enumerate ALL matches so we can prefer lossless shim types over
    // PowerShell-delegating ones. Source paths are emitted one per line
    // and joined with a NUL byte so paths containing whitespace survive
    // the round-trip intact.
    const script = `$ErrorActionPreference='SilentlyContinue';` +
        `$cs=Get-Command -Name '${quoted}' -CommandType Application,ExternalScript -All -ErrorAction SilentlyContinue;` +
        `if($cs){[Console]::Out.Write(($cs|ForEach-Object{$_.Source}) -join [char]0)}`;
    const result = await captureRun({
        command: "powershell.exe",
        args: ["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", script],
        cwd: process.cwd(),
        env: filteredEnv(process.env),
        timeoutMs: HELP_PROBE_TIMEOUT_MS,
    });
    if (result.spawnError || result.exitCode !== 0)
        return null;
    const candidates = result.stdout
        .split("\u0000")
        .map((s) => s.trim())
        .filter((s) => s.length > 0);
    if (candidates.length === 0)
        return null;
    // Verify each candidate exists (Get-Command can return stale
    // entries when a junction target is gone), then pick the
    // best-scoring one.
    const live = [];
    for (const c of candidates) {
        if (await isExecutableFile(c))
            live.push(c);
    }
    if (live.length === 0)
        return null;
    live.sort((a, b) => rankWindowsShimByExtension(a) - rankWindowsShimByExtension(b));
    return live[0];
}
async function resolveOnPath(binaryName, env) {
    if ((0, node_path_1.isAbsolute)(binaryName)) {
        if (await isExecutableFile(binaryName)) {
            // On Windows, also verify the supplied absolute path has an
            // extension that PATHEXT recognises; otherwise the OS cannot
            // exec it and `spawn` will ENOENT at run time. Try appending
            // a PATHEXT entry if the bare path is unspawnable.
            if (IS_WINDOWS) {
                const lower = binaryName.toLowerCase();
                if (WINDOWS_PATH_EXTS.some((ext) => lower.endsWith(ext.toLowerCase()))) {
                    return binaryName;
                }
                for (const ext of WINDOWS_PATH_EXTS) {
                    const candidate = binaryName + ext.toLowerCase();
                    if (await isExecutableFile(candidate))
                        return candidate;
                }
                return null;
            }
            return binaryName;
        }
        if (IS_WINDOWS) {
            for (const ext of WINDOWS_PATH_EXTS) {
                const candidate = binaryName + ext.toLowerCase();
                if (await isExecutableFile(candidate))
                    return candidate;
            }
        }
        return null;
    }
    const pathVar = env["PATH"] ?? env["Path"] ?? env["path"] ?? "";
    if (pathVar.length === 0) {
        return null;
    }
    const candidates = [];
    for (const dir of pathVar.split(node_path_1.delimiter)) {
        if (dir.length === 0)
            continue;
        if (IS_WINDOWS) {
            // Windows: PATHEXT decides what `cmd.exe` would actually
            // execute. Try the PATHEXT extensions FIRST so we never
            // return the bare extensionless `copilot` script that npm /
            // nvm-windows install alongside the real `copilot.cmd` shim
            // (the bare file passes F_OK but Windows cannot spawn it
            // without an extension and you get ENOENT at exec time).
            // Only fall back to the bare name when it already contains
            // an extension that PATHEXT recognises.
            for (const ext of WINDOWS_PATH_EXTS) {
                candidates.push((0, node_path_1.join)(dir, binaryName + ext.toLowerCase()));
            }
            const lower = binaryName.toLowerCase();
            if (WINDOWS_PATH_EXTS.some((ext) => lower.endsWith(ext.toLowerCase()))) {
                candidates.push((0, node_path_1.join)(dir, binaryName));
            }
        }
        else {
            candidates.push((0, node_path_1.join)(dir, binaryName));
        }
    }
    // Collect every existing candidate, then on Windows pick the
    // shim whose argv handling we can drive losslessly (prefer
    // `.exe`/`.cmd` over `.bat`/`.ps1` — see
    // `rankWindowsShimByExtension` for the reasoning). On POSIX,
    // first match wins as before.
    if (IS_WINDOWS) {
        const live = [];
        for (const c of candidates) {
            if (await isExecutableFile(c))
                live.push(c);
        }
        if (live.length === 0)
            return null;
        live.sort((a, b) => rankWindowsShimByExtension(a) - rankWindowsShimByExtension(b));
        return live[0];
    }
    for (const c of candidates) {
        if (await isExecutableFile(c)) {
            return c;
        }
    }
    return null;
}
function captureRun(opts) {
    return new Promise((resolve) => {
        const startedAt = Date.now();
        let stdout = "";
        let stderr = "";
        let timedOut = false;
        let aborted = false;
        let settled = false;
        let sigtermTimer = null;
        let sigkillTimer = null;
        let timeoutTimer = null;
        let idleTimer = null;
        let child;
        try {
            // Windows shim handling. We MUST keep `shell:false` so:
            //   - `child.kill` actually terminates the target process
            //     (`shell:true` only kills the cmd.exe wrapper, leaving the
            //     grandchild alive and our `timedOut` flag stale).
            //   - ENOENT propagates as a spawn error rather than being
            //     silently absorbed by cmd.exe with a nonzero exit code.
            //   - cmd.exe does NOT re-parse argv. With `shell:true`, Node
            //     concatenates args with spaces and hands the whole string to
            //     cmd.exe, which strips one layer of double quotes. That
            //     mangles JSON-bearing flags such as
            //     `--additional-mcp-config '{"mcpServers":...}'` into
            //     `{mcpServers:...}` and copilot then exits with either
            //     "Invalid JSON" or "too many arguments".
            //
            // For `.cmd`/`.bat` shims (e.g. npm's `copilot.cmd`) we cannot
            // spawn them directly on Windows because the OS loader only
            // executes PE binaries. The pattern that survives both Node's
            // CreateProcess quoting AND cmd.exe's parsing is:
            //   * `windowsVerbatimArguments: true` so Node hands our argv
            //     string to CreateProcess unchanged (no auto-quoting that
            //     would double-escape our JSON).
            //   * Construct the command line ourselves: each token is
            //     CommandLineToArgvW-quoted (so the child sees discrete
            //     argv slots), then cmd.exe metacharacters (& | < > ^ ( ) % !
            //     and embedded ") are caret-escaped (so cmd.exe's tokenizer
            //     leaves them alone), then the entire command is wrapped in
            //     an outer pair of quotes that pairs with `cmd.exe /s` to
            //     keep the inner quoting intact.
            //   * `cmd.exe /d /s /c "<cmdline>"` then dispatches the shim
            //     with the recovered argv exactly as a non-Windows kernel
            //     would have done with execve().
            // PowerShell scripts (`.ps1`) get the analogous
            // `powershell.exe -File <path>` rewrite (no quote-stripping
            // hazard there because powershell.exe parses argv per .NET
            // rules, which align with CommandLineToArgvW).
            let spawnCommand = opts.command;
            let spawnArgs = [...opts.args];
            let useVerbatimArgs = false;
            if (IS_WINDOWS && /\.ps1$/i.test(opts.command)) {
                spawnCommand = "powershell.exe";
                spawnArgs = [
                    "-NoLogo",
                    "-NoProfile",
                    "-NonInteractive",
                    "-ExecutionPolicy",
                    "Bypass",
                    "-File",
                    opts.command,
                    ...opts.args,
                ];
            }
            else if (IS_WINDOWS && /\.(?:cmd|bat)$/i.test(opts.command)) {
                // Reject embedded LF/CR in any token BEFORE handing the
                // command line to cmd.exe. `cmd.exe /c` treats the first
                // newline as a command terminator; everything after it falls
                // off the command line and the child sees a malformed argv.
                // On real shims this manifests as a silent native crash with
                // exit code 3221226505 (0xC0000409 STATUS_STACK_BUFFER_OVERRUN)
                // and no captured stdout / stderr — extremely hard to diagnose
                // post-hoc. Failing loudly here forces the caller to keep
                // multi-line content out of argv (the Large Payload Isolation
                // Rule already mandates this for prompts; this is the
                // mechanical guard that backs it up).
                for (let i = 0; i < opts.args.length; i++) {
                    if (/[\r\n]/.test(opts.args[i])) {
                        throw new Error(`process.spawn: argv[${i}] for Windows .cmd/.bat shim contains a newline; ` +
                            "newlines are unrepresentable across cmd.exe /c and would crash the child silently. " +
                            "Move the payload to a file and pass the path instead.");
                    }
                }
                const tokens = [opts.command, ...opts.args]
                    .map((t) => quoteForCommandLineToArgvW(t))
                    .map((t) => escapeForCmdExe(t))
                    .join(" ");
                spawnCommand = "cmd.exe";
                spawnArgs = ["/d", "/s", "/c", `"${tokens}"`];
                useVerbatimArgs = true;
            }
            child = (0, node_child_process_1.spawn)(spawnCommand, spawnArgs, {
                cwd: opts.cwd,
                env: { ...opts.env },
                shell: false,
                windowsHide: true,
                windowsVerbatimArguments: useVerbatimArgs,
                stdio: ["ignore", "pipe", "pipe"],
            });
        }
        catch (err) {
            resolve({
                stdout: "",
                stderr: "",
                exitCode: null,
                signal: null,
                durationMs: Date.now() - startedAt,
                timedOut: false,
                aborted: false,
                spawnError: err instanceof Error ? err : new Error(String(err)),
            });
            return;
        }
        const settle = (result) => {
            if (settled)
                return;
            settled = true;
            if (timeoutTimer)
                clearTimeout(timeoutTimer);
            if (idleTimer)
                clearTimeout(idleTimer);
            if (sigtermTimer)
                clearTimeout(sigtermTimer);
            if (sigkillTimer)
                clearTimeout(sigkillTimer);
            if (opts.abortSignal)
                opts.abortSignal.removeEventListener("abort", onAbort);
            resolve({ ...result, durationMs: Date.now() - startedAt });
        };
        // Cancellation escalation:
        //   step 1: SIGINT  — equivalent to Ctrl+C; lets the CLI flush
        //                     its NDJSON stream and exit cleanly.
        //                     On Windows there is no real SIGINT for
        //                     spawned children, so we go straight to
        //                     the tree-kill path below.
        //   step 2: SIGTERM — polite termination after a short grace.
        //   step 3: SIGKILL — unconditional kill if the child is still
        //                     up; on Windows we additionally invoke
        //                     `taskkill /T /F /PID <pid>` so the whole
        //                     process tree dies with the cmd.exe shim
        //                     (otherwise `copilot.cmd → node copilot.js`
        //                     leaves the node grandchild orphaned and
        //                     still emitting stdout).
        const tryKill = (signal) => {
            try {
                child.kill(signal);
            }
            catch {
                /* child may already be dead */
            }
        };
        const taskkillTreeOnWindows = () => {
            if (!IS_WINDOWS)
                return;
            const pid = child.pid;
            if (typeof pid !== "number" || pid <= 0)
                return;
            try {
                // /T = tree, /F = force. Detached + ignore stdio so this
                // helper neither blocks on the kill nor pollutes our stdout
                // capture with taskkill's own status text.
                const k = (0, node_child_process_1.spawn)("taskkill.exe", ["/T", "/F", "/PID", String(pid)], {
                    windowsHide: true,
                    detached: true,
                    stdio: "ignore",
                });
                k.on("error", () => {
                    /* taskkill missing or denied — best effort */
                });
                k.unref();
            }
            catch {
                /* swallow — best effort */
            }
        };
        const killHard = () => {
            if (sigtermTimer || sigkillTimer)
                return;
            // Step 1: polite interrupt. On POSIX this is SIGINT (the same
            // signal a human Ctrl+C produces). On Windows child.kill()
            // does not implement SIGINT for non-console grandchildren, so
            // we still invoke it (no-op on most shims) and rely on the
            // SIGTERM step below to begin actual termination.
            tryKill("SIGINT");
            sigtermTimer = setTimeout(() => {
                tryKill("SIGTERM");
                sigkillTimer = setTimeout(() => {
                    tryKill("SIGKILL");
                    // On Windows, child.kill maps to TerminateProcess(handle)
                    // for the immediate PID only — that kills cmd.exe but
                    // leaves the npm/node grandchild that copilot.cmd actually
                    // launched. taskkill /T walks the parent-child relationship
                    // recorded by the OS and terminates the whole subtree, which
                    // is the only reliable way to stop a long-running Copilot
                    // CLI run on Windows.
                    taskkillTreeOnWindows();
                }, SIGTERM_GRACE_MS);
                sigkillTimer.unref?.();
            }, SIGINT_GRACE_MS);
            sigtermTimer.unref?.();
        };
        const onAbort = () => {
            aborted = true;
            killHard();
        };
        if (opts.abortSignal) {
            if (opts.abortSignal.aborted) {
                onAbort();
            }
            else {
                opts.abortSignal.addEventListener("abort", onAbort, { once: true });
            }
        }
        if (Number.isFinite(opts.timeoutMs) && opts.timeoutMs > 0) {
            timeoutTimer = setTimeout(() => {
                timedOut = true;
                killHard();
            }, opts.timeoutMs);
            timeoutTimer.unref?.();
        }
        // Idle-output timer. Reset on every stdout/stderr chunk so a long
        // pass that keeps streaming tool events / assistant deltas is
        // allowed to run past the wall-clock cap; a stalled run (no
        // output for `idleTimeoutMs`) is killed and surfaces as a
        // timeout to the caller.
        const idleBudget = opts.idleTimeoutMs;
        const armIdleTimer = () => {
            if (!Number.isFinite(idleBudget) || idleBudget <= 0)
                return;
            if (idleTimer)
                clearTimeout(idleTimer);
            idleTimer = setTimeout(() => {
                timedOut = true;
                killHard();
            }, idleBudget);
            idleTimer.unref?.();
        };
        armIdleTimer();
        child.stdout?.setEncoding("utf8");
        child.stderr?.setEncoding("utf8");
        child.stdout?.on("data", (chunk) => {
            stdout += chunk;
            armIdleTimer();
            opts.onStdoutChunk?.(chunk);
        });
        child.stderr?.on("data", (chunk) => {
            stderr += chunk;
            armIdleTimer();
            opts.onStderrChunk?.(chunk);
        });
        child.on("error", (err) => {
            settle({
                stdout,
                stderr,
                exitCode: null,
                signal: null,
                timedOut,
                aborted,
                spawnError: err,
            });
        });
        child.on("close", (code, signal) => {
            settle({
                stdout,
                stderr,
                exitCode: typeof code === "number" ? code : null,
                signal: signal ?? null,
                timedOut,
                aborted,
                spawnError: null,
            });
        });
    });
}
exports.HOST_PROCESS = Object.freeze({
    async resolveExecutable(binaryName) {
        if (typeof binaryName !== "string" || binaryName.length === 0) {
            throw new Error("resolveExecutable: binaryName must be a non-empty string");
        }
        // Windows: prefer PowerShell's resolver because it matches what
        // the user sees when they type the command in their shell, and it
        // handles `.ps1` shims that our PATH walk cannot exec directly.
        // Fall back to the manual PATH walk only if PowerShell is missing
        // or returns nothing (e.g. command lives only in a non-default
        // PATHEXT extension recorded in the env we received).
        let resolved = null;
        if (IS_WINDOWS) {
            resolved = await resolveViaPowerShell(binaryName);
        }
        if (!resolved) {
            resolved = await resolveOnPath(binaryName, process.env);
        }
        if (!resolved) {
            return null;
        }
        // Best-effort version banner. Failures here MUST NOT mark the
        // binary as unresolvable — many CLIs do not print `--version`,
        // and the orchestrator already does its own help-surface probe.
        let versionString = null;
        try {
            const v = await captureRun({
                command: resolved,
                args: ["--version"],
                cwd: process.cwd(),
                env: filteredEnv(process.env),
                timeoutMs: VERSION_PROBE_TIMEOUT_MS,
            });
            if (v.spawnError === null && v.exitCode === 0) {
                const trimmed = v.stdout.trim();
                if (trimmed.length > 0) {
                    versionString = trimmed.split(/\r?\n/, 1)[0] ?? null;
                }
            }
        }
        catch {
            versionString = null;
        }
        return Object.freeze({ executablePath: resolved, versionString });
    },
    async runHelp(input) {
        const result = await captureRun({
            command: input.command,
            args: ["--help"],
            cwd: input.cwd,
            env: input.env,
            timeoutMs: HELP_PROBE_TIMEOUT_MS,
        });
        if (result.spawnError) {
            throw new Error(`runHelp: failed to spawn '${input.command}': ${result.spawnError.message}`);
        }
        // Some CLIs emit help on stderr instead of stdout. Concatenate
        // both so the orchestrator's help-surface parser sees everything.
        const helpText = result.stdout.length > 0 ? result.stdout : result.stderr;
        return Object.freeze({ helpText, versionString: null });
    },
    async spawn(input) {
        if (!Number.isFinite(input.timeoutMs) || input.timeoutMs <= 0) {
            throw new Error("process.spawn: timeoutMs must be a positive finite number");
        }
        const result = await captureRun({
            command: input.command,
            args: input.args,
            cwd: input.cwd,
            env: input.env,
            timeoutMs: input.timeoutMs,
            ...(typeof input.idleTimeoutMs === "number" && input.idleTimeoutMs > 0
                ? { idleTimeoutMs: input.idleTimeoutMs }
                : {}),
            abortSignal: input.abortSignal,
            onStdoutChunk: input.onStdoutChunk,
            onStderrChunk: input.onStderrChunk,
        });
        if (result.spawnError) {
            // Spawn-time failures (ENOENT, EACCES, …) surface as port-level
            // exceptions; the orchestrator translates them into the right
            // failure code (e.g. `COPILOT_CLI_NOT_FOUND` when ENOENT).
            throw Object.assign(result.spawnError, {
                copilotCliSpawnContext: {
                    command: input.command,
                    args: input.args,
                    cwd: input.cwd,
                    durationMs: result.durationMs,
                },
            });
        }
        return Object.freeze({
            stdout: result.stdout,
            stderr: result.stderr,
            exitCode: result.exitCode,
            signal: result.signal,
            durationMs: result.durationMs,
            timedOut: result.timedOut,
            aborted: result.aborted,
        });
    },
});
function filteredEnv(env) {
    const out = {};
    for (const [k, v] of Object.entries(env)) {
        if (typeof v === "string")
            out[k] = v;
    }
    return out;
}
//# sourceMappingURL=process-adapter.js.map