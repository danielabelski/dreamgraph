// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Copilot CLI adapter — pure help-text parser (Slice 1).
//
// Distills `copilot --help` output into a `CopilotHelpSurface`. Pure
// function — no I/O, no globals. The caller (a later slice) is
// responsible for spawning `copilot --help` and feeding the captured
// stdout here.
//
// Per binding rule "no empty stubs": if a flag is not detected in the
// help text, the adapter MUST omit it from generated argv (see argv.ts).
// We never assume a flag exists because docs say it should.

import type { CopilotHelpSurface } from "./types.js";

/**
 * Match a long-form flag at a word boundary, e.g. detects `--allow-tool`
 * inside `  --allow-tool <name>   Allow…`. Anchored on `--` so flags
 * mentioned in prose (e.g. "see --allow-tool docs") still match — that
 * is intentional; absence in help text is the failure signal we care
 * about, not exact column placement.
 */
function flagPresent(help: string, flag: string): boolean {
  // Escape regex metacharacters in the flag name (none expected today,
  // but keeps the helper safe if optional flags grow).
  const escaped = flag.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp(`(^|[\\s,(])${escaped}(?=$|[\\s,=)])`, "m");
  return re.test(help);
}

/**
 * Match either a long-form `--prompt` flag OR a short-form `-p` flag
 * shown in the canonical "  -p, --prompt <text>" help layout.
 */
function promptFlagPresent(help: string): boolean {
  return (
    flagPresent(help, "--prompt") ||
    /(^|\s)-p(\s|,)/m.test(help)
  );
}

/**
 * Parse Copilot CLI's `--help` (or `--version`) output into a
 * structured probe. Pure: same input → same output.
 *
 * @param helpText raw stdout captured from `copilot --help`.
 * @param versionString optional verbatim version string from
 *   `copilot --version` (passed through unchanged for audit).
 */
export function parseCopilotHelpSurface(
  helpText: string,
  versionString: string | null = null,
): CopilotHelpSurface {
  // Defensive: treat undefined/null as empty rather than throwing —
  // an empty help surface flips every "required" check to false and
  // the adapter will refuse to launch with COPILOT_HELP_SURFACE_UNSUPPORTED.
  const text = typeof helpText === "string" ? helpText : "";

  return {
    rawLength: text.length,
    versionString: versionString,
    required: {
      prompt: promptFlagPresent(text),
      allowTool: flagPresent(text, "--allow-tool"),
      denyTool: flagPresent(text, "--deny-tool"),
      model: flagPresent(text, "--model"),
      allowAllTools: flagPresent(text, "--allow-all-tools"),
    },
    optional: {
      availableTools: flagPresent(text, "--available-tools"),
      disallowTempDir: flagPresent(text, "--disallow-temp-dir"),
      allowUrl: flagPresent(text, "--allow-url"),
      denyUrl: flagPresent(text, "--deny-url"),
      additionalMcpConfig: flagPresent(text, "--additional-mcp-config"),
    },
  };
}

/**
 * True iff every flag the adapter requires to safely launch Copilot
 * CLI is present in the probed help surface. Caller maps `false` to
 * `COPILOT_HELP_SURFACE_UNSUPPORTED`.
 */
export function isHelpSurfaceSupported(surface: CopilotHelpSurface): boolean {
  const r = surface.required;
  return (
    r.prompt &&
    r.allowTool &&
    r.denyTool &&
    r.model &&
    r.allowAllTools
  );
}
