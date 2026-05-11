// Slice 8A.3 — public surface for the context sub-module.

export {
  DefaultContextBuilder,
  allocateBudget,
  type DefaultContextBuilderDeps,
} from "./builder.js";
export {
  NullFallbackSignalProvider,
  NULL_ENVIRONMENT,
  NULL_RECENT_HISTORY,
  type DiagnosticSnapshot,
  type EnvironmentSnapshot,
  type FallbackSignalProvider,
  type FileExcerpt,
  type ProjectEntry,
  type ReadFileExcerptsInput,
  type RecentHistorySnapshot,
} from "./fallback-signals.js";

// Slice 8A.4 — ContextDiscoveryRecorder port (ADR-177)
export {
  NullContextDiscoveryRecorder,
  type ContextDiscovery,
  type ContextDiscoveryRecorder,
} from "./discovery-recorder.js";
