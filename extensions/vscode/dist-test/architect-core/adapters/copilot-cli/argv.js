"use strict";
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Copilot CLI adapter — pure argv builder (Slice 1).
//
// Translates a `CopilotArgvInput` into the exact argv array the
// adapter will pass to `child_process.spawn`. Pure: no I/O, no
// environment reads. The caller is responsible for the executable
// path and `cwd`.
//
// ─────────────────────────────────────────────────────────────────────
// LARGE PAYLOAD ISOLATION RULE  (a.k.a. control-plane / data-plane split)
// ─────────────────────────────────────────────────────────────────────
// Command argv and environment variables are CONTROL PLANE: small
// fixed-vocabulary flags only (model name, allow/deny tool specs,
// `--allow-all-tools`, etc.). Prompt packages, MCP server manifests,
// authority policies, expected-output schemas, transcripts, patches
// and other semantic payloads are DATA PLANE and MUST travel via
// files in a per-run directory or via stdin — never via argv or env.
// This keeps the adapter portable across every host shell, platform,
// and CLI shim layer; argv quoting hazards and OS-imposed argv length
// caps simply don't apply when the payload isn't on argv.
//
// In this builder that means: no JSON, no MCP config, no prompt files,
// no schemas, no patches in argv. The orchestrator delivers MCP config
// to the CLI via the documented data-plane path
// (`<COPILOT_HOME>/mcp-config.json` inside an isolated per-run
// `COPILOT_HOME` it sets in env) and writes large prompts to a
// per-run file that the model reads through its own file-read tool.
//
// Adapter policy enforced here:
//   • Always emit `--allow-all-tools` — the CLI's own help text marks
//     this flag as required for non-interactive (`--prompt`) mode.
//     Per-tool safety is preserved by the unconditional
//     `--deny-tool shell` and `--deny-tool write` below: deny rules take
//     precedence over allows in Copilot CLI's policy resolution.
//   • Always deny inline destructive surfaces (`shell`, `write`).
//   • Allow only `<authoritativeServer>(<tool>)` MCP specs from the
//     verified allowlist. Never wildcard the server.
//   • `--available-tools` is reported as policy metadata but NOT emitted
//     because its argument grammar varies between CLI versions; the
//     `--allow-tool`/`--deny-tool` pair is sufficient and verified.
//   • `--disallow-temp-dir` is emitted when supported (workspace
//     isolation hardening — adapter spawns from an isolated invocation
//     directory anyway, this is belt + suspenders).
//
// Argv ordering is stable for snapshot testing.
Object.defineProperty(exports, "__esModule", { value: true });
exports.buildCopilotArgv = buildCopilotArgv;
/**
 * Inline tool surfaces the adapter ALWAYS denies. These are the
 * well-known names Copilot CLI uses for shell execution and direct
 * file writes; we never let the model reach them in authoritative mode.
 * Deny rules take precedence over `--allow-all-tools`.
 */
const DENIED_INLINE_TOOLS = Object.freeze([
    "shell",
    "write",
]);
function buildCopilotArgv(input) {
    if (!input.prompt) {
        throw new Error("buildCopilotArgv: prompt is required");
    }
    if (input.authoritativeAllowlist.length === 0) {
        throw new Error("buildCopilotArgv: authoritativeAllowlist must be non-empty");
    }
    const args = [];
    // 1. Model selector (optional, but emitted first when present so that
    //    audit-log readers can spot it at a glance).
    if (input.model) {
        args.push("--model", input.model);
    }
    // 2. Non-interactive enabler. Required by the CLI for `--prompt`
    //    runs; safety is preserved by the deny rules emitted next.
    args.push("--allow-all-tools");
    const allowAllToolsEnabled = true;
    // 3. Inline-tool denies. Emitted AFTER `--allow-all-tools` so the
    //    deny precedence is unambiguous in the argv ordering as well.
    const deniedSpecs = [];
    for (const inline of DENIED_INLINE_TOOLS) {
        args.push("--deny-tool", inline);
        deniedSpecs.push(inline);
    }
    // 4. Authoritative MCP allows. One flag per tool — keeps each spec
    //    individually auditable in the spawned argv. Copilot CLI's
    //    permission grammar uses the `<server>(<tool>)` form (see
    //    `copilot --help` examples, e.g. `--allow-tool='MyMCP(my_tool)'`).
    //    A bare `<server>` would whitelist every tool the server exposes,
    //    which is exactly what authoritative mode must prevent.
    const allowedSpecs = [];
    for (const tool of input.authoritativeAllowlist) {
        const spec = `${input.authoritativeServer}(${tool})`;
        args.push("--allow-tool", spec);
        allowedSpecs.push(spec);
    }
    // 5. Optional hardening: disallow temp dir if the CLI knows the flag.
    let tempDirDisallowed = false;
    if (input.helpSurface.optional.disallowTempDir) {
        args.push("--disallow-temp-dir");
        tempDirDisallowed = true;
    }
    // 5b. File-access allowlist. Copilot CLI restricts read tools to the
    //     invocation cwd by default; the orchestrator passes the per-run
    //     scratch directory here so the file-redirect directive's
    //     `prompt.md` is reachable. Empty when the prompt fits inline.
    const addedDirs = [];
    for (const dir of input.addDirs ?? []) {
        if (typeof dir !== "string" || dir.length === 0)
            continue;
        args.push("--add-dir", dir);
        addedDirs.push(dir);
    }
    // 6. Prompt last so the prompt text is visually adjacent to the run
    //    command in shell history / audit dumps. Per the Large Payload
    //    Isolation Rule, when the prompt overflows the inline-argv
    //    budget the orchestrator replaces this string with a tiny
    //    file-read directive whose payload lives on disk in the per-run
    //    directory. Either way, this builder sees a single string.
    args.push("--prompt", input.prompt);
    return {
        args: Object.freeze(args),
        policy: {
            // We track but never emit `--available-tools`; recorded as false
            // until a future slice verifies the per-version argument grammar.
            availableToolsRestricted: false,
            tempDirDisallowed,
            inlineShellDenied: true,
            inlineWriteDenied: true,
            allowAllToolsEnabled,
            allowedToolSpecs: Object.freeze(allowedSpecs),
            deniedToolSpecs: Object.freeze(deniedSpecs),
            addedDirs: Object.freeze(addedDirs),
        },
    };
}
//# sourceMappingURL=argv.js.map