import type { CopilotHelpSurface } from "./types.js";
/**
 * Parse Copilot CLI's `--help` (or `--version`) output into a
 * structured probe. Pure: same input → same output.
 *
 * @param helpText raw stdout captured from `copilot --help`.
 * @param versionString optional verbatim version string from
 *   `copilot --version` (passed through unchanged for audit).
 */
export declare function parseCopilotHelpSurface(helpText: string, versionString?: string | null): CopilotHelpSurface;
/**
 * True iff every flag the adapter requires to safely launch Copilot
 * CLI is present in the probed help surface. Caller maps `false` to
 * `COPILOT_HELP_SURFACE_UNSUPPORTED`.
 */
export declare function isHelpSurfaceSupported(surface: CopilotHelpSurface): boolean;
//# sourceMappingURL=help-probe.d.ts.map