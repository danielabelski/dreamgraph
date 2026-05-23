export type AutonomyMode = 'cautious' | 'conscientious' | 'eager' | 'autonomous';
export type UncertaintyLevel = 'low' | 'medium' | 'high';
export type ProgressStatus = 'advancing' | 'slowing' | 'stalled';
export type SelectionMode = 'user' | 'self' | 'none';

export interface AutonomyState {
  mode: AutonomyMode;
  remainingAutoPasses: number;
  completedAutoPasses: number;
  totalAuthorizedPasses?: number;
  /** Wall-clock budget total, in ms. Optional — when absent the bar shows '—'. */
  timeBudgetTotalMs?: number;
  /** Epoch ms when the current time budget started counting. Optional — only set when timeBudgetTotalMs is set. */
  timeBudgetStartedAtEpochMs?: number;
  /** Number of consecutive passes that produced no real work
   * (no tool calls, no file edits, no envelope summary text). Used to
   * break out of pathological counter-spam loops where the model keeps
   * "continuing" without ever doing anything. */
  consecutiveEmptyPasses?: number;
  /** True once the architect has identified a concrete patch anchor or
   * actually performed a write — i.e. the "what to change" question is
   * answered. After this point, additional pure-read passes count as
   * non-progress (see analyzePass). Cleared whenever a write tool runs
   * successfully so a follow-up edit cycle can re-discover its own anchor. */
  patchAnchorEstablished?: boolean;
  /** Concrete file paths the architect named as the patch site in the
   * most recent pass that established or re-confirmed the anchor.
   * Compared across passes by the two-strike token-economy stop rule:
   * if a follow-up locate-only pass names a *different* set of paths,
   * that counts as legitimate re-anchoring (anchor moved) and the loop
   * is allowed to continue; same-set re-locates count as waste. */
  lastAnchorPaths?: readonly string[];
  /** True when the previous pass executed only read tool calls and made
   * no file edits. Together with the same flag for the current pass and
   * the lastAnchorPaths comparison, this drives the two-strike
   * token-economy stop rule in `shouldContinueAfterPass`. */
  lastPassWasLocateOnly?: boolean;
}

export interface PassOutcomeSignal {
  hasClearNextStep: boolean;
  uncertainty: UncertaintyLevel;
  hasBlockingFailure: boolean;
  nextStepWithinScope: boolean;
  goalSufficientlyReached: boolean;
  progressStatus: ProgressStatus;
  nextStepIsNearTrivial?: boolean;
  nextStepIsDefining?: boolean;
  /** True when the pass produced no tool calls, no file edits, no
   * envelope summary, and no recommended actions — i.e. the model
   * "reported" only autonomy counters. */
  isEmptyPass?: boolean;
  /** True when the assistant's final text addresses the user with a
   * choice / confirmation prompt (e.g. "let me know if you want X",
   * "should I proceed with Y?", "would you like me to..."). The
   * autonomy loop must NOT auto-continue past such a prompt — that
   * would talk over the user and discard their authority. */
  awaitingUserInput?: boolean;
}

export interface RecommendedAction {
  id: string;
  label: string;
  rationale?: string;
  priority: number;
  eligible: boolean;
  withinScope: boolean;
  mutuallyExclusiveWith?: string[];
  batchGroup?: string;
  requiresTools?: string[];
  requiresSecrets?: string[];
  blockers?: RecommendedActionBlocker[];
  /** Exact MCP/local tool name to run for this action, when applicable. */
  tool?: string;
  /** Pre-bound arguments for `tool`. */
  toolArgs?: Record<string, unknown>;
}

export interface RecommendedActionBlocker {
  id: string;
  label: string;
  kind: 'missing_tool' | 'missing_secret' | 'external';
}

export interface RecommendedActionCapabilityContext {
  availableToolNames?: readonly string[];
  env?: Record<string, string | undefined>;
}

export interface RecommendedActionSet {
  actions: RecommendedAction[];
  doAllEligible: boolean;
  topActionId?: string;
}

export interface ContinuationDecision {
  shouldContinue: boolean;
  reason: string;
  selectionMode: SelectionMode;
}

export interface AutonomyStatusView {
  mode: AutonomyMode;
  countingActive: boolean;
  completed: number;
  remaining: number;
  totalAuthorized?: number;
  /** Wall-clock budget total in ms (per ADR-153). Optional. */
  timeBudgetTotalMs?: number;
  /** Epoch ms when the time budget started ticking. Optional, paired with totalMs. */
  timeBudgetStartedAtEpochMs?: number;
  summary: string;
}

export interface AutonomyInstructionState extends AutonomyState {
  enabled?: boolean;
}

export function createAutonomyState(
  mode: AutonomyMode = 'cautious',
  totalAuthorizedPasses?: number,
  timeBudgetTotalMs?: number,
  timeBudgetStartedAtEpochMs?: number,
): AutonomyState {
  const remaining = typeof totalAuthorizedPasses === 'number' && totalAuthorizedPasses > 0 ? totalAuthorizedPasses : 0;
  const hasTime = typeof timeBudgetTotalMs === 'number' && timeBudgetTotalMs > 0;
  return {
    mode,
    remainingAutoPasses: remaining,
    completedAutoPasses: 0,
    totalAuthorizedPasses: totalAuthorizedPasses && totalAuthorizedPasses > 0 ? totalAuthorizedPasses : undefined,
    timeBudgetTotalMs: hasTime ? timeBudgetTotalMs : undefined,
    timeBudgetStartedAtEpochMs: hasTime ? (timeBudgetStartedAtEpochMs ?? Date.now()) : undefined,
  };
}

export function isPassCountingActive(state: AutonomyState | undefined): boolean {
  return !!state && ((state.totalAuthorizedPasses ?? 0) > 0 || state.completedAutoPasses > 0 || state.remainingAutoPasses > 0);
}

export function decrementPassBudget(state: AutonomyState): AutonomyState {
  const hadBudget = typeof state.totalAuthorizedPasses === 'number' && state.totalAuthorizedPasses > 0;
  return {
    ...state,
    completedAutoPasses: state.completedAutoPasses + 1,
    remainingAutoPasses: hadBudget ? Math.max(0, state.remainingAutoPasses - 1) : state.remainingAutoPasses,
  };
}

export function deriveAutonomyStatusView(state: AutonomyState): AutonomyStatusView {
  const countingActive = isPassCountingActive(state);
  const total = state.totalAuthorizedPasses;
  const summary = countingActive
    ? `Mode: ${state.mode} · Passes: ${state.completedAutoPasses}/${total ?? state.completedAutoPasses + state.remainingAutoPasses} · Remaining: ${state.remainingAutoPasses}`
    : `Mode: ${state.mode}`;
  return {
    mode: state.mode,
    countingActive,
    completed: state.completedAutoPasses,
    remaining: state.remainingAutoPasses,
    totalAuthorized: total,
    timeBudgetTotalMs: state.timeBudgetTotalMs,
    timeBudgetStartedAtEpochMs: state.timeBudgetStartedAtEpochMs,
    summary,
  };
}

// ---------------------------------------------------------------------------
// Mode profiles (per ADR-152) — modes differ ONLY by these data values.
// Provider-agnostic: identical for OpenAI, Anthropic, or any future provider.
// Ported from architect-v2/autonomy/modes.ts so the v1 architect inherits
// the same calibration without depending on v2 code.
// ---------------------------------------------------------------------------

export interface ModeProfile {
  readonly mode: AutonomyMode;
  /** Default pass budget for this mode (ADR-153 PassBudget total). */
  readonly defaultPassBudget: number;
  /** Default wall-clock budget in ms (ADR-153 TimeBudget totalMs). */
  readonly defaultTimeBudgetMs: number;
}

export const MODE_PROFILES: Readonly<Record<AutonomyMode, ModeProfile>> = Object.freeze({
  cautious:      Object.freeze({ mode: 'cautious',      defaultPassBudget: 3,  defaultTimeBudgetMs:  2 * 60 * 1000 }),
  conscientious: Object.freeze({ mode: 'conscientious', defaultPassBudget: 8,  defaultTimeBudgetMs:  5 * 60 * 1000 }),
  eager:         Object.freeze({ mode: 'eager',         defaultPassBudget: 20, defaultTimeBudgetMs: 10 * 60 * 1000 }),
  autonomous:    Object.freeze({ mode: 'autonomous',    defaultPassBudget: 50, defaultTimeBudgetMs: 30 * 60 * 1000 }),
});

export function getModeProfile(mode: AutonomyMode): ModeProfile {
  return MODE_PROFILES[mode];
}

/**
 * Build a fresh `AutonomyState` from a mode's profile (pass budget + time
 * budget started now). Used when the user explicitly switches mode via the
 * header dropdown — explicit selection means "start a new session under this
 * mode's policy".
 */
export function applyModeProfileToState(mode: AutonomyMode, nowEpochMs: number = Date.now()): AutonomyState {
  const profile = getModeProfile(mode);
  return createAutonomyState(mode, profile.defaultPassBudget, profile.defaultTimeBudgetMs, nowEpochMs);
}

export function rankRecommendedActions(actions: RecommendedAction[]): RecommendedActionSet {
  const eligible = actions.filter((action) => isRecommendedActionRunnable(action));
  const sorted = [...eligible].sort((a, b) => a.priority - b.priority || a.label.localeCompare(b.label));
  return {
    actions: sorted,
    doAllEligible: computeDoAllEligibility(sorted),
    topActionId: sorted[0]?.id,
  };
}

export function computeDoAllEligibility(actions: RecommendedAction[]): boolean {
  if (actions.length < 2) return false;
  for (const action of actions) {
    if (!isRecommendedActionRunnable(action)) return false;
    const mutex = new Set(action.mutuallyExclusiveWith ?? []);
    for (const other of actions) {
      if (other.id === action.id) continue;
      if (mutex.has(other.id)) return false;
    }
  }
  return true;
}

export function isRecommendedActionRunnable(action: RecommendedAction): boolean {
  return action.eligible && action.withinScope && (action.blockers?.length ?? 0) === 0;
}

export function applyRecommendedActionCapabilityGuards(
  actions: readonly RecommendedAction[],
  context: RecommendedActionCapabilityContext = {},
): RecommendedAction[] {
  const availableTools = new Set((context.availableToolNames ?? []).map((name) => name.toLowerCase()));
  const hasTool = (name: string): boolean => availableTools.has(name.toLowerCase()) || availableTools.has(`dreamgraph:${name}`.toLowerCase());
  const hasSecret = (name: string): boolean => {
    const value = context.env?.[name];
    return typeof value === 'string' && value.trim().length > 0;
  };

  return actions.map((action) => {
    const label = action.label.trim();
    const blockers = [...(action.blockers ?? [])];
    const requiresTools = new Set(action.requiresTools ?? []);
    const requiresSecrets = new Set(action.requiresSecrets ?? []);

    if (requiresGraphReleaseWrite(label, action)) {
      requiresTools.add('enrich_seed_data');
    }
    if (requiresMarketplacePublishSecret(label)) {
      requiresSecrets.add('VSCE_PAT');
    }
    if (looksLikeExternalCredentialSetup(label)) {
      blockers.push({
        id: 'external_secret_setup',
        kind: 'external',
        label: 'Requires user-side credential setup outside this chat surface.',
      });
    }

    for (const toolName of requiresTools) {
      if (!hasTool(toolName)) {
        blockers.push({
          id: `missing_tool:${toolName}`,
          kind: 'missing_tool',
          label: `Requires MCP tool ${toolName}; the current tool surface cannot perform this action.`,
        });
      }
    }

    const marketplaceSecretSatisfied = hasSecret('VSCE_PAT') || hasSecret('AZURE_DEVOPS_EXT_PAT');
    for (const secretName of requiresSecrets) {
      if (secretName === 'VSCE_PAT' && marketplaceSecretSatisfied) continue;
      if (!hasSecret(secretName)) {
        blockers.push({
          id: `missing_secret:${secretName}`,
          kind: 'missing_secret',
          label: `Requires ${secretName} in the host environment before this action can run.`,
        });
      }
    }

    const uniqueBlockers = dedupeBlockers(blockers);
    return {
      ...action,
      requiresTools: requiresTools.size > 0 ? [...requiresTools] : action.requiresTools,
      requiresSecrets: requiresSecrets.size > 0 ? [...requiresSecrets] : action.requiresSecrets,
      blockers: uniqueBlockers.length > 0 ? uniqueBlockers : undefined,
      eligible: uniqueBlockers.length > 0 ? false : action.eligible,
    };
  });
}

function dedupeBlockers(blockers: readonly RecommendedActionBlocker[]): RecommendedActionBlocker[] {
  const seen = new Set<string>();
  const out: RecommendedActionBlocker[] = [];
  for (const blocker of blockers) {
    const key = blocker.id || `${blocker.kind}:${blocker.label}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(blocker);
  }
  return out;
}

function requiresGraphReleaseWrite(label: string, action: RecommendedAction): boolean {
  const text = `${label} ${action.rationale ?? ''}`.toLowerCase();
  if (text.includes('enrich_seed_data')) return true;
  const mentionsRelease = /\brelease\b|\bvsix\b|\bv\d+\.\d+\.\d+\b/.test(text);
  const mentionsGraph = /\bknowledge graph\b|\bdreamgraph graph\b|\bgraph\b/.test(text);
  const writeIntent = /\brecord\b|\bwrite\b|\badd\b|\bpatch\b|\bcurate\b|\benrich\b|\binvoke\b/.test(text);
  return mentionsRelease && mentionsGraph && writeIntent;
}

function requiresMarketplacePublishSecret(label: string): boolean {
  const text = label.toLowerCase();
  return /\bpublish\b/.test(text)
    && (/\bvsix\b/.test(text) || /\bmarketplace\b/.test(text) || /\bvs code marketplace\b/.test(text));
}

function looksLikeExternalCredentialSetup(label: string): boolean {
  const text = label.toLowerCase();
  return /\b(configure|generate|create|set)\b/.test(text)
    && (/\bvsce_pat\b/.test(text) || /\bpersonal access token\b/.test(text) || /\bpat\b/.test(text))
    && !/\bretry\b|\brun\b|\bpublish\b/.test(text);
}

export function chooseActionForMode(
  mode: AutonomyMode,
  actionSet: RecommendedActionSet,
  signal: PassOutcomeSignal,
): string | undefined {
  if (!actionSet.topActionId) return undefined;
  if (mode === 'cautious') return signal.nextStepIsNearTrivial ? actionSet.topActionId : undefined;
  if (mode === 'conscientious') return signal.uncertainty === 'low' ? actionSet.topActionId : undefined;
  if (mode === 'eager') return signal.uncertainty === 'high' ? undefined : actionSet.topActionId;
  return signal.uncertainty === 'high' ? undefined : actionSet.topActionId;
}

export function shouldContinueAfterPass(
  state: AutonomyState,
  signal: PassOutcomeSignal,
  actionSet?: RecommendedActionSet,
): ContinuationDecision {
  if (signal.goalSufficientlyReached) {
    return { shouldContinue: false, reason: 'Stopped: original goal sufficiently reached.', selectionMode: 'none' };
  }
  if (signal.awaitingUserInput) {
    // The assistant explicitly handed control back to the user (asked
    // a confirmation question, presented a final report and offered
    // follow-up options, etc.). Auto-continuation here would talk
    // over the user and run another full pass while they are still
    // composing a reply. Surface action chips if any were broadcast,
    // but do NOT spawn the next pass.
    return { shouldContinue: false, reason: 'Paused: assistant is awaiting user input.', selectionMode: 'user' };
  }
  if (signal.progressStatus === 'stalled') {
    return { shouldContinue: false, reason: 'Stopped: progress has stalled.', selectionMode: 'none' };
  }
  if (signal.hasBlockingFailure) {
    return { shouldContinue: false, reason: 'Stopped: blocking failure encountered.', selectionMode: 'none' };
  }
  // NOTE: post-anchor re-reading is NOT a stop condition. The token-economy
  // remedy at task level is structural pressure (write-reservation prompt in
  // the inner agentic loop, anchor-aware continuation prompt, write-tool
  // binding on apply/patch actions, and tool-catalog narrowing toward
  // write+verify on the second sticky-anchor locate-only pass) — not a hard
  // halt. The architect's design is "no failure: keep going until done";
  // stopping the loop just because the model has not yet selected a write
  // tool would punish the model instead of giving it what it needs to
  // succeed. See chat-panel.ts (Phase A write reservation, Lever 1 narrowing,
  // Lever 2 action binding) and autonomy-loop.ts (anchor-aware prompt).
  // Counter-spam guard: two passes in a row that produced no tool calls,
  // no file edits, and no real report — force user confirmation rather
  // than burning more pass budget on a model that is silently failing.
  if ((state.consecutiveEmptyPasses ?? 0) >= 2) {
    return { shouldContinue: false, reason: 'Paused: two empty passes in a row — select an action or type "resume" to continue.', selectionMode: 'user' };
  }
  if (!signal.hasClearNextStep) {
    // Pause for user selection rather than hard-stopping. The webview will show
    // any action chips that were broadcast; the user can select one or type "resume".
    return { shouldContinue: false, reason: 'Paused: no clear next step identified — select an action or type "resume" to continue.', selectionMode: 'user' };
  }
  if (!signal.nextStepWithinScope) {
    return { shouldContinue: false, reason: 'Stopped: next step is outside current scope.', selectionMode: 'none' };
  }
  if (state.totalAuthorizedPasses && state.remainingAutoPasses <= 0) {
    return { shouldContinue: false, reason: 'Stopped: pass budget exhausted.', selectionMode: 'none' };
  }
  if (signal.uncertainty === 'high') {
    return { shouldContinue: false, reason: 'Stopped: uncertainty too high for safe continuation.', selectionMode: 'none' };
  }

  if (state.mode === 'cautious') {
    if (signal.uncertainty !== 'low' || !signal.nextStepIsNearTrivial) {
      return { shouldContinue: false, reason: 'Paused: cautious mode prefers user confirmation.', selectionMode: 'user' };
    }
    return { shouldContinue: true, reason: 'Continuing automatically: near-trivial next step with low uncertainty.', selectionMode: 'self' };
  }

  if (state.mode === 'conscientious') {
    if (signal.uncertainty === 'low') {
      const selected = chooseActionForMode(state.mode, actionSet ?? { actions: [], doAllEligible: false }, signal);
      return { shouldContinue: true, reason: 'Continuing automatically: clear bounded next step.', selectionMode: selected ? 'self' : 'user' };
    }
    return { shouldContinue: false, reason: 'Paused: conscientious mode requires clearer bounds.', selectionMode: 'user' };
  }

  if (state.mode === 'eager') {
    if (signal.uncertainty === 'medium' && !signal.nextStepIsDefining) {
      return { shouldContinue: false, reason: 'Paused: eager mode needs a defining or lower-risk next step.', selectionMode: 'user' };
    }
    return { shouldContinue: true, reason: 'Continuing automatically: strong aligned next step available.', selectionMode: 'self' };
  }

  return { shouldContinue: true, reason: 'Continuing automatically: autonomous mode with bounded in-scope next step.', selectionMode: 'self' };
}

export function getAutonomyInstructionBlock(state?: AutonomyInstructionState): string {
  if (!state?.enabled) return '';
  const status = deriveAutonomyStatusView(state);
  return [
    '## Autonomy Contract',
    `- **Autonomy mode:** ${state.mode}`,
    status.countingActive ? `- **Pass counters:** completed ${status.completed}, remaining ${status.remaining}, total authorized ${status.totalAuthorized ?? status.completed + status.remaining}` : '- **Pass counters:** inactive',
    '- In all modes, DreamGraph must output into chat after each pass.',
    '- Continue automatically only when host policy allows and the next step is clear, in scope, and safe for the current mode.',
    '- Stop when the original goal has sufficiently been reached.',
    '- Stop when progress has stalled.',
    '- When pass counting is active, counters must remain visible.',
    '- Emit recommended next steps in a structured/selectable form when available.',
    '- In higher-autonomy modes, self-select the strongest eligible next action when policy allows; otherwise pause for user selection.',
  ].join('\n');
}
