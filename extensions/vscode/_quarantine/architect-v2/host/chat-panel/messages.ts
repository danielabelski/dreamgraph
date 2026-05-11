// Slice 8A.5 / M7 — Typed messages exchanged between the v2 ChatPanel
// extension host and its webview.
//
// STRICT ISOLATION (ADR-140 + ADR-171): no v1 imports.
//
// The webview NEVER sees provider output directly. It receives only:
//   - rendered markdown (from renderPass({cards, trailingNote}))
//   - high-level state transitions (idle / running / error / waiting)
//   - explicit user actions echoed back for confirmation
//
// All extension-side state (TaskState, PassResult, raw provider
// responses) stays on the host side of this seam. Cards are pre-rendered
// to deterministic markdown (see cards/render.ts) before crossing.

/**
 * Messages the webview sends TO the extension host.
 */
export type WebviewToHost =
  | { kind: "ready" }
  | { kind: "submit"; text: string }
  | { kind: "cancel" }
  | { kind: "reset" }
  | { kind: "open-settings" }
  | { kind: "set-autonomy-mode"; mode: AutonomyModeId }
  | { kind: "set-provider"; providerId: string }
  | { kind: "set-model"; modelId: string }
  | { kind: "diagnostic"; scope: WebviewDiagnosticScope; sample: string };

/**
 * Render-side diagnostics. The webview reports any output it could not
 * type/classify so the host can record it (telemetry / dream cycle).
 * Enforces the invariant: visible \u21d2 typed \u21d2 recordable \u21d2 rendered.
 */
export type WebviewDiagnosticScope =
  | "render-unknown"
  | "render-empty"
  | "render-error";

/**
 * Messages the extension host sends TO the webview.
 */
export type HostToWebview =
  | { kind: "init"; state: PanelInitState }
  | { kind: "status"; status: PanelStatus; detail?: string }
  | {
      kind: "pass-rendered";
      /** Concatenated markdown (legacy; kept for back-compat). */
      markdown: string;
      passIndex: number;
      /**
       * Pre-typed per-card chunks. Each entry carries the deterministic
       * card kind (or "note" for the trailing model note) plus the
       * markdown for that single chunk. The webview renders one DOM
       * card per chunk and uses the `kind` field directly for
       * classification, eliminating the H3-text inference path that
       * could produce "unclassified renderer output".
       */
      chunks: readonly RenderedChunk[];
    }
  | { kind: "user-echo"; text: string }
  | { kind: "trace"; entries: readonly TraceEntry[] }
  | { kind: "autonomy"; mode: AutonomyModeId; passBudget: BudgetView }
  | {
      kind: "settings";
      hasApiKey: boolean;
      providerId: string;
      modelId: string;
      models: readonly ModelOption[];
    }
  | { kind: "cleared" }
  | { kind: "activity"; current: ActivityItem | null; recent: readonly ActivityItem[] }
  | { kind: "error"; message: string };

export type AutonomyModeId =
  | "cautious"
  | "conscientious"
  | "eager"
  | "autonomous";

export type PanelStatus =
  | "idle"
  | "running"
  | "waiting-for-user"
  | "error";

export interface ProviderOption {
  readonly id: string;
  readonly displayName: string;
}

export interface ModelOption {
  readonly id: string;
  readonly displayName: string;
}

export interface PanelInitState {
  readonly providerId: string;
  readonly modelId: string;
  readonly hasApiKey: boolean;
  readonly mode: AutonomyModeId;
  readonly passBudget: BudgetView;
  readonly providers: readonly ProviderOption[];
  readonly models: readonly ModelOption[];
  /** Persisted user/assistant transcript replayed on webview hydration. */
  readonly transcript: readonly PersistedTranscriptEntry[];
}

export type PersistedTranscriptEntry =
  | {
      readonly kind: "user-echo";
      readonly text: string;
      readonly atEpochMs: number;
    }
  | {
      readonly kind: "pass-rendered";
      readonly markdown: string;
      readonly passIndex: number;
      readonly chunks: readonly RenderedChunk[];
      readonly atEpochMs: number;
    };

export interface BudgetView {
  readonly remaining: number;
  readonly total: number;
}

/**
 * Pre-typed card chunk crossing the host -> webview seam. The host
 * renders each Card individually and tags it with its kind so the
 * webview never has to infer the card type from rendered HTML. The
 * trailing model note (renderTrailingNote) is carried with kind
 * `"note"`. Empty cards arrays produce zero chunks.
 */
export interface RenderedChunk {
  readonly kind: RenderedChunkKind;
  readonly markdown: string;
}

export type RenderedChunkKind =
  | "goal"
  | "plan"
  | "context"
  | "decision"
  | "edit"
  | "verification"
  | "blocker"
  | "next-step"
  | "completion"
  | "fallback"
  | "outcome"
  | "note";

/**
 * One row in the tool-trace view. Derived from the host-side
 * PassResult.outcomes — the webview only sees the projection.
 */
export interface TraceEntry {
  readonly tool: string;
  readonly succeeded: boolean;
  readonly summary: string;
  readonly atEpochMs: number;
}

/**
 * One entry in the live activity ticker. Pushed by the host as the
 * orchestrator's executor calls capabilities so the user can feel the
 * pass progressing instead of staring at a single "Working..." label.
 */
export interface ActivityItem {
  readonly capabilityId: string;
  readonly toolName: string;
  readonly label: string;
  readonly atEpochMs: number;
}
