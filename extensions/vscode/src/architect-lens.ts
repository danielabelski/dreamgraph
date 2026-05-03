/**
 * DreamGraph Architect Lens — Phase 5 #10 / ADR-100.
 *
 * Picks a *reasoning lens* for the architect (orthogonal to IntentMode,
 * which only chooses where to look). Heuristic-only — no LLM call.
 *
 * Lenses follow ADR-100's "visible when useful, silent otherwise" rule:
 *   - For trivial requests (rename variable, fix typo) we return `generic`
 *     and mark `material = false` so the prompt assembler suppresses the
 *     "Architect Lens: …" badge entirely.
 *   - For requests where the lens materially changes the reasoning
 *     (different evidence pulled, different ADR set, different query
 *     protocol) we return one of the named lenses with `material = true`.
 *
 * @see plans/GRAPH_META_ARCHITECT_DEEP_ANALYSIS.md §8.5
 */

import type {
  ArchitectLens,
  ArchitectLensSelection,
  IntentMode,
} from "./types.js";

interface LensRule {
  lens: ArchitectLens;
  /** Words that, when present, point at this lens. Lower-case, word-boundary matched. */
  keywords: string[];
  /** Optional command sources that strongly imply this lens. */
  commandSources?: string[];
  /** Base confidence on a single keyword hit. Repeated hits add 0.1 each, capped at 0.95. */
  baseConfidence: number;
}

const LENS_RULES: LensRule[] = [
  {
    lens: "performance",
    keywords: [
      "performance", "perf", "slow", "latency", "throughput", "bottleneck",
      "optimize", "optimisation", "optimization", "n\\+1", "memory leak",
      "cpu", "profile", "benchmark", "hot path",
    ],
    baseConfidence: 0.7,
  },
  {
    lens: "security",
    keywords: [
      "security", "secure", "auth", "authentication", "authorization",
      "vulnerability", "exploit", "injection", "xss", "csrf", "sqli",
      "rls", "permission", "leak", "secret", "credential", "token",
      "owasp", "threat", "attack", "sandbox", "untrusted",
    ],
    commandSources: ["nightmareCycle"],
    baseConfidence: 0.75,
  },
  {
    lens: "reliability",
    keywords: [
      "reliability", "stability", "robust", "resilience", "retry",
      "fallback", "timeout", "race condition", "deadlock", "flaky",
      "intermittent", "crash", "panic", "outage", "data loss",
      "idempotent", "atomic",
    ],
    baseConfidence: 0.7,
  },
  {
    lens: "refactor",
    keywords: [
      "refactor", "refactoring", "clean up", "cleanup", "extract",
      "rename", "split", "merge", "deduplicate", "tech debt", "tidy",
      "rewrite", "restructure", "decompose",
    ],
    commandSources: ["refactorSelection"],
    baseConfidence: 0.65,
  },
  {
    lens: "debug",
    keywords: [
      "debug", "trace", "stack trace", "exception", "error", "broken",
      "regression", "bug", "fails", "failing", "failure", "doesn't work",
      "not working", "why isn't", "why does it",
    ],
    commandSources: ["fixCurrentFile", "diagnose"],
    baseConfidence: 0.6,
  },
  {
    lens: "review",
    keywords: [
      "review", "code review", "audit", "lgtm", "looks good", "feedback",
      "improve", "suggestions", "critique", "smell",
    ],
    commandSources: ["reviewSelection"],
    baseConfidence: 0.6,
  },
];

/**
 * Trivial-request detector. ADR-100 says rename-variable / fix-typo class
 * tasks should be silent regardless of which lens scored highest.
 */
const TRIVIAL_PATTERNS = [
  /\brename (variable|symbol|file)\b/,
  /\bfix typo\b/,
  /\bformat (the )?file\b/,
  /\badd (a )?(missing )?import\b/,
];

export interface LensDetectionInput {
  prompt: string;
  intentMode: IntentMode;
  commandSource?: string;
}

const GENERIC_SELECTION: ArchitectLensSelection = {
  lens: "generic",
  confidence: 0,
  reason: "no material lens signal",
  material: false,
};

/**
 * Score a single lens rule against the prompt.
 * Returns `null` when there are no keyword hits and no command-source bias.
 */
function scoreRule(
  rule: LensRule,
  prompt: string,
  commandSource?: string,
): { confidence: number; matched: string[] } | null {
  const matched: string[] = [];
  for (const kw of rule.keywords) {
    const re = new RegExp(`\\b${kw}\\b`, "i");
    if (re.test(prompt)) matched.push(kw);
  }
  const commandMatch = commandSource && rule.commandSources?.includes(commandSource);
  if (matched.length === 0 && !commandMatch) return null;
  let confidence = rule.baseConfidence + Math.min(0.25, (matched.length - 1) * 0.1);
  if (commandMatch) confidence = Math.max(confidence, 0.85);
  confidence = Math.min(0.95, Math.round(confidence * 100) / 100);
  return { confidence, matched };
}

/**
 * Select an ArchitectLens for the request.
 *
 * Returns a `generic` selection (with `material = false`) for trivial paths
 * or when no rule fires above threshold; the prompt assembler treats those
 * as "silent" per ADR-100.
 */
export function detectArchitectLens(input: LensDetectionInput): ArchitectLensSelection {
  const prompt = (input.prompt ?? "").trim();
  if (!prompt) return GENERIC_SELECTION;

  const lower = prompt.toLowerCase();
  if (TRIVIAL_PATTERNS.some((re) => re.test(lower))) {
    return GENERIC_SELECTION;
  }

  let best: { rule: LensRule; confidence: number; matched: string[] } | null = null;
  for (const rule of LENS_RULES) {
    const score = scoreRule(rule, prompt, input.commandSource);
    if (!score) continue;
    if (!best || score.confidence > best.confidence) {
      best = { rule, ...score };
    }
  }

  // Threshold: lens only surfaces when we are at least 0.6 confident — keeps
  // the badge from flickering for marginal keyword overlaps.
  if (!best || best.confidence < 0.6) {
    return GENERIC_SELECTION;
  }

  // ask_dreamgraph + a graph-only question (no code anchor in play) is
  // typically explanatory; downgrade unless the lens is debug/security/review,
  // which are still material for purely conceptual answers.
  const explanatoryDowngrade =
    input.intentMode === "ask_dreamgraph" &&
    !["debug", "security", "review"].includes(best.rule.lens);
  if (explanatoryDowngrade && best.confidence < 0.75) {
    return GENERIC_SELECTION;
  }

  const reason = best.matched.length > 0
    ? `keywords: ${best.matched.slice(0, 3).join(", ")}`
    : `command: ${input.commandSource ?? "unknown"}`;

  return {
    lens: best.rule.lens,
    confidence: best.confidence,
    reason,
    material: true,
  };
}

/** Display label used by prompt overlays / UI surfaces. */
export function lensLabel(lens: ArchitectLens): string {
  switch (lens) {
    case "performance": return "Performance";
    case "refactor": return "Refactor";
    case "reliability": return "Reliability";
    case "security": return "Security";
    case "review": return "Review";
    case "debug": return "Debug";
    default: return "Generic";
  }
}
