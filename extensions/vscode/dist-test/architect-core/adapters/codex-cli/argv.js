"use strict";
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Codex CLI adapter - pure argv builder (Slice 1).
Object.defineProperty(exports, "__esModule", { value: true });
exports.buildCodexArgv = buildCodexArgv;
const FORBIDDEN_CONFIG_KEY_RE = /(?:^|\.)(?:sandbox|sandbox_mode|approval|approval_mode|ask_for_approval|dangerously_bypass_approvals_and_sandbox|yolo|full_auto)(?:$|\.)/i;
function requireFlag(available, flag) {
    if (!available) {
        throw new Error(`buildCodexArgv: help surface does not advertise ${flag}`);
    }
}
function serializeConfigValue(value) {
    if (typeof value === "string") {
        return value;
    }
    return JSON.stringify(value);
}
function configOverrideArg(override) {
    const key = override.key.trim();
    if (key.length === 0) {
        throw new Error("buildCodexArgv: config override key is required");
    }
    if (FORBIDDEN_CONFIG_KEY_RE.test(key)) {
        throw new Error(`buildCodexArgv: config override cannot weaken authoritative sandbox/approval policy: ${key}`);
    }
    return `${key}=${serializeConfigValue(override.value)}`;
}
function buildCodexArgv(input) {
    if (!input.workspace) {
        throw new Error("buildCodexArgv: workspace is required");
    }
    const exec = input.helpSurface.exec;
    requireFlag(exec.json, "--json");
    requireFlag(exec.cd, "--cd");
    requireFlag(exec.sandbox, "--sandbox");
    requireFlag(exec.positionalStdinPrompt, "positional stdin prompt '-' argument");
    const args = [
        "exec",
        "--json",
        "--cd",
        input.workspace,
        "--sandbox",
        "read-only",
    ];
    if (exec.askForApproval) {
        args.push("--ask-for-approval", "never");
    }
    if (input.model) {
        requireFlag(exec.model, "--model");
        args.push("--model", input.model);
    }
    if (input.profile) {
        requireFlag(exec.profile, "--profile");
        args.push("--profile", input.profile);
    }
    if (input.outputLastMessagePath) {
        requireFlag(exec.outputLastMessage, "--output-last-message");
        args.push("--output-last-message", input.outputLastMessagePath);
    }
    if (input.outputSchemaPath) {
        requireFlag(exec.outputSchema, "--output-schema");
        args.push("--output-schema", input.outputSchemaPath);
    }
    const configOverrides = [];
    for (const override of input.configOverrides ?? []) {
        requireFlag(exec.config, "--config");
        const arg = configOverrideArg(override);
        args.push("-c", arg);
        configOverrides.push(arg);
    }
    const addedDirs = [];
    for (const dir of input.addDirs ?? []) {
        if (typeof dir !== "string" || dir.length === 0)
            continue;
        requireFlag(exec.addDir, "--add-dir");
        args.push("--add-dir", dir);
        addedDirs.push(dir);
    }
    if (input.skipGitRepoCheck) {
        requireFlag(exec.skipGitRepoCheck, "--skip-git-repo-check");
        args.push("--skip-git-repo-check");
    }
    if (input.ignoreUserConfig) {
        requireFlag(exec.ignoreUserConfig, "--ignore-user-config");
        args.push("--ignore-user-config");
    }
    if (input.ephemeral) {
        requireFlag(exec.ephemeral, "--ephemeral");
        args.push("--ephemeral");
    }
    args.push("-");
    return {
        args: Object.freeze(args),
        policy: {
            sandboxMode: "read-only",
            approvalMode: exec.askForApproval ? "never" : "not-advertised",
            promptSource: "stdin-positional-dash",
            jsonEventsEnabled: true,
            userConfigIgnored: input.ignoreUserConfig === true,
            ephemeral: input.ephemeral === true,
            gitRepoCheckSkipped: input.skipGitRepoCheck === true,
            addedDirs: Object.freeze(addedDirs),
            configOverrides: Object.freeze(configOverrides),
        },
    };
}
//# sourceMappingURL=argv.js.map