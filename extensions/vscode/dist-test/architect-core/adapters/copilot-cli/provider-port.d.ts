import type { ArchitectLlm } from "../../../architect-llm.js";
import type { ProviderPort } from "../../ports.js";
import { type CopilotCliDeps, type CopilotCliRunResult } from "./orchestrator.js";
export interface CopilotCliProviderPortOptions {
    /**
     * Reference to the host's `ArchitectLlm`. Exposed verbatim through
     * `port.llm` to satisfy the architect-core port contract. Not used
     * for any wire calls; the CLI surface owns its own model selection.
     */
    readonly hostLlm: ArchitectLlm;
    /**
     * Working directory passed to every `runCopilotCli` invocation.
     * Typically the workspace root; the orchestrator never writes here.
     */
    readonly invocationCwd: string;
    /**
     * Hard wall-clock cap per turn, in milliseconds. Required (no
     * implicit infinite runs).
     */
    readonly timeoutMs: number;
    /**
     * Base process environment. Forwarded to the orchestrator, which
     * overlays `COPILOT_HOME` and the per-run MCP token without
     * mutating the input map.
     */
    readonly baseEnv: Readonly<Record<string, string | undefined>>;
    /**
     * Optional model selector forwarded as `--model <model>` when set.
     */
    readonly model?: string;
    /**
     * Optional override of the binary name. Defaults to `"copilot"`.
     * Useful in tests and when packagers ship a renamed binary.
     */
    readonly binaryName?: string;
    /**
     * Effectful ports the orchestrator depends on. Production code
     * supplies `HOST_FS`, `HOST_PROCESS`, `HOST_CRYPTO`, `HOST_CLOCK`
     * plus `createHostRegistry` / `createHostAudit`. Tests inject fakes.
     */
    readonly deps: CopilotCliDeps;
    /**
     * Observer hook invoked once per provider call with the full
     * `CopilotCliRunResult`. The chat panel uses this to mirror tool-
     * call audit entries into its tool-trace channel and to surface
     * diagnostics. The provider port itself never inspects the result
     * past projecting the `ProviderProposal`.
     */
    readonly onRunResult?: (result: CopilotCliRunResult) => void;
}
export declare function createCopilotCliProviderPort(options: CopilotCliProviderPortOptions): ProviderPort;
//# sourceMappingURL=provider-port.d.ts.map