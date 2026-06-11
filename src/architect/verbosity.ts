export const ARCHITECT_VERBOSITY_MODE_OPTIONS = ["concise", "balanced", "detailed"] as const;

export type ArchitectVerbosityMode = typeof ARCHITECT_VERBOSITY_MODE_OPTIONS[number];
export type ArchitectProviderTextVerbosity = "low" | "medium" | "high";
export type ArchitectStoryVisibility = "hidden" | "compact" | "expanded";
export type ArchitectPromptProfile = "compact" | "standard" | "diagnostic";

export interface ArchitectNarrativeDensity {
  verbosity_mode: ArchitectVerbosityMode;
  provider_text_verbosity: ArchitectProviderTextVerbosity;
  story_visibility: ArchitectStoryVisibility;
  prompt_profile: ArchitectPromptProfile;
}

const ARCHITECT_NARRATIVE_DENSITY_BY_MODE: Record<ArchitectVerbosityMode, ArchitectNarrativeDensity> = {
  concise: {
    verbosity_mode: "concise",
    provider_text_verbosity: "low",
    story_visibility: "hidden",
    prompt_profile: "compact",
  },
  balanced: {
    verbosity_mode: "balanced",
    provider_text_verbosity: "medium",
    story_visibility: "compact",
    prompt_profile: "standard",
  },
  detailed: {
    verbosity_mode: "detailed",
    provider_text_verbosity: "high",
    story_visibility: "expanded",
    prompt_profile: "diagnostic",
  },
};

export function normalizeArchitectVerbosityMode(
  value: unknown,
  fallback: ArchitectVerbosityMode = "balanced",
): ArchitectVerbosityMode {
  if (typeof value !== "string") return fallback;
  const normalized = value.trim().toLowerCase().replace(/_/g, "-");
  if (normalized === "concise") return "concise";
  if (normalized === "balanced" || normalized === "default") return "balanced";
  if (normalized === "detailed" || normalized === "detail") return "detailed";
  return fallback;
}

export function resolveArchitectNarrativeDensity(value: unknown): ArchitectNarrativeDensity {
  const mode = normalizeArchitectVerbosityMode(value);
  return ARCHITECT_NARRATIVE_DENSITY_BY_MODE[mode];
}
