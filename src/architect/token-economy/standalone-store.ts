import { BudgetCoordinator, type BudgetSnapshot, type BudgetCoordinatorSettings, type PressureLabel } from "@dreamgraph/token-economy/budget-coordinator";

export interface StandaloneBudgetSettings {
  expectedTokensPerTurn: number;
  transportCeilingTokens: number;
  debtCarryFraction: number;
  modelId: string;
}

export interface ArchitectBudgetStatus {
  session_key: string;
  turn: number;
  model_id: string;
  expected_tokens: number;
  ceiling_tokens: number;
  last_actual_tokens: number;
  delta_tokens: number;
  debt_tokens: number;
  credit_tokens: number;
  balance_tokens: number;
  pressure_label: PressureLabel;
  top_component_contributors: Array<{ component: string; tokens: number }>;
  model_switch: BudgetSnapshot["history"][number]["modelSwitch"] | null;
}

const snapshots = new Map<string, BudgetSnapshot>();

export function createStandaloneBudgetCoordinator(sessionKey: string, settings: StandaloneBudgetSettings): BudgetCoordinator {
  const previous = snapshots.get(sessionKey) ?? null;
  const coordinatorSettings: BudgetCoordinatorSettings = {
    expectedTokensPerTurn: settings.expectedTokensPerTurn,
    transportCeilingTokens: settings.transportCeilingTokens,
    debtCarryFraction: settings.debtCarryFraction,
    modelId: settings.modelId,
    turnNumber: nextTurnNumber(previous),
  };
  return new BudgetCoordinator(previous, coordinatorSettings);
}

export function persistStandaloneBudgetSnapshot(sessionKey: string, snapshot: BudgetSnapshot): void {
  snapshots.set(sessionKey, snapshot);
}

export function getStandaloneBudgetSnapshot(sessionKey: string): BudgetSnapshot | null {
  return snapshots.get(sessionKey) ?? null;
}

export function finalizeStandaloneBudgetTurn(sessionKey: string, coordinator: BudgetCoordinator, totalActualTokens?: number): BudgetSnapshot {
  const snapshot = coordinator.finalizeTurn(totalActualTokens);
  persistStandaloneBudgetSnapshot(sessionKey, snapshot);
  return snapshot;
}

export function buildArchitectBudgetStatus(sessionKey: string, snapshot: BudgetSnapshot, pressureLabel: PressureLabel): ArchitectBudgetStatus {
  const lastEntry = [...snapshot.history].reverse().find((entry) => !entry.modelSwitch) ?? null;
  const modelSwitchEntry = [...snapshot.history].reverse().find((entry) => entry.modelSwitch)?.modelSwitch ?? null;
  const components = lastEntry?.components ?? {};
  const top = Object.entries(components)
    .map(([component, tokens]) => ({ component, tokens }))
    .sort((left, right) => right.tokens - left.tokens)
    .slice(0, 5);
  return {
    session_key: sessionKey,
    turn: lastEntry?.turn ?? snapshot.history.length,
    model_id: snapshot.modelId,
    expected_tokens: snapshot.expectedTokens,
    ceiling_tokens: snapshot.ceilingTokens,
    last_actual_tokens: snapshot.lastActualTokens,
    delta_tokens: lastEntry?.delta ?? 0,
    debt_tokens: Math.max(0, Math.round(snapshot.debtTokens)),
    credit_tokens: Math.max(0, Math.round(-snapshot.debtTokens)),
    balance_tokens: Math.round(snapshot.debtTokens),
    pressure_label: pressureLabel,
    top_component_contributors: top,
    model_switch: modelSwitchEntry ?? null,
  };
}

function nextTurnNumber(previous: BudgetSnapshot | null): number {
  if (!previous) return 1;
  const turns = previous.history
    .filter((entry) => !entry.modelSwitch)
    .map((entry) => entry.turn);
  return Math.max(0, ...turns) + 1;
}
