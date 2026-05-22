import type { CodexHelpSurface } from "./types.js";
export declare function parseCodexHelpSurface(input: {
    readonly rootHelpText: string;
    readonly execHelpText: string;
    readonly versionString?: string | null;
}): CodexHelpSurface;
export declare function isHelpSurfaceSupported(surface: CodexHelpSurface): boolean;
//# sourceMappingURL=help-probe.d.ts.map