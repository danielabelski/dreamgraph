// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Codex CLI adapter - pure help-surface parser (Slice 1).

import type { CodexHelpSurface } from "./types.js";

function flagPresent(help: string, flag: string): boolean {
  const escaped = flag.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp(`(^|[\\s,(])${escaped}(?=$|[\\s,=)])`, "m");
  return re.test(help);
}

function shortFlagPresent(help: string, flag: string): boolean {
  const escaped = flag.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp(`(^|\\s)${escaped}(\\s|,)`, "m");
  return re.test(help);
}

function commandPresent(help: string, command: string): boolean {
  const escaped = command.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(^|\\s)${escaped}(\\s|$)`, "m").test(help);
}

function optionLine(help: string, flag: string): string {
  return help.split(/\r?\n/).find((line) => line.includes(flag)) ?? "";
}

function optionWindow(help: string, flag: string): string {
  const lines = help.split(/\r?\n/);
  const index = lines.findIndex((line) => line.includes(flag));
  if (index < 0) return "";
  return lines.slice(index, index + 16).join("\n");
}

function splitEnumText(value: string): readonly string[] {
  const modes = new Set<string>();
  for (const raw of value.split(/[|,]/)) {
    const mode = raw.replace(/[<>[\]`]/g, "").trim();
    if (/^[a-z][a-z0-9-]*$/i.test(mode)) {
      modes.add(mode);
    }
  }
  return Object.freeze([...modes]);
}

function extractModes(help: string, flag: string): readonly string[] {
  const window = optionWindow(help, flag);
  const inline = window.match(/<([a-z][a-z0-9-]*(?:\s*[|,]\s*[a-z][a-z0-9-]*)+)>/i);
  if (inline) {
    return splitEnumText(inline[1] ?? "");
  }

  const bracketed = window.match(/\[possible values:\s*([^\]]+)\]/i);
  if (bracketed) {
    return splitEnumText(bracketed[1] ?? "");
  }

  const bullets = [...window.matchAll(/^\s*-\s*([a-z][a-z0-9-]*)\s*:/gim)].map(
    (match) => match[1] ?? "",
  ).filter(Boolean);
  if (bullets.length > 0) {
    return Object.freeze(bullets);
  }

  return Object.freeze([] as string[]);
}

function positionalStdinPromptPresent(rootHelp: string, execHelp: string): boolean {
  const combined = `${rootHelp}\n${execHelp}`;
  return (
    /(^|\s)-($|\s|,|\))/m.test(combined) &&
    /\b(?:stdin|standard input|read from stdin)\b/i.test(combined)
  );
}

export function parseCodexHelpSurface(input: {
  readonly rootHelpText: string;
  readonly execHelpText: string;
  readonly versionString?: string | null;
}): CodexHelpSurface {
  const root = typeof input.rootHelpText === "string" ? input.rootHelpText : "";
  const exec = typeof input.execHelpText === "string" ? input.execHelpText : "";
  const combined = `${root}\n${exec}`;

  return {
    rawLength: combined.length,
    versionString: input.versionString ?? null,
    root: {
      execCommand: commandPresent(root, "exec") || /\bcodex\s+exec\b/.test(root),
    },
    exec: {
      json: flagPresent(exec, "--json") || flagPresent(exec, "--experimental-json"),
      model: flagPresent(exec, "--model") || shortFlagPresent(exec, "-m"),
      cd: flagPresent(exec, "--cd") || shortFlagPresent(exec, "-C"),
      sandbox: flagPresent(exec, "--sandbox") || shortFlagPresent(exec, "-s"),
      askForApproval: flagPresent(exec, "--ask-for-approval") || shortFlagPresent(exec, "-a"),
      config: flagPresent(exec, "--config") || shortFlagPresent(exec, "-c"),
      profile: flagPresent(exec, "--profile") || shortFlagPresent(exec, "-p"),
      addDir: flagPresent(exec, "--add-dir"),
      outputLastMessage: flagPresent(exec, "--output-last-message"),
      outputSchema: flagPresent(exec, "--output-schema"),
      skipGitRepoCheck: flagPresent(exec, "--skip-git-repo-check"),
      ignoreUserConfig: flagPresent(exec, "--ignore-user-config"),
      ephemeral: flagPresent(exec, "--ephemeral"),
      positionalStdinPrompt: positionalStdinPromptPresent(root, exec),
    },
    safety: {
      sandboxModes: extractModes(exec, "--sandbox"),
      approvalModes: extractModes(exec, "--ask-for-approval"),
      fullAutoDeprecated: flagPresent(exec, "--full-auto") && /deprecated/i.test(optionLine(exec, "--full-auto")),
      dangerousBypass: flagPresent(exec, "--dangerously-bypass-approvals-and-sandbox") || flagPresent(exec, "--yolo"),
    },
  };
}

export function isHelpSurfaceSupported(surface: CodexHelpSurface): boolean {
  const e = surface.exec;
  return (
    surface.root.execCommand &&
    e.json &&
    e.model &&
    e.cd &&
    e.sandbox &&
    e.config &&
    e.profile &&
    e.addDir &&
    e.outputLastMessage &&
    e.outputSchema &&
    e.skipGitRepoCheck &&
    e.ignoreUserConfig &&
    e.ephemeral &&
    e.positionalStdinPrompt
  );
}
