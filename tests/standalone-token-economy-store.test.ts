import { describe, expect, it } from "vitest";

import {
  buildArchitectBudgetStatus,
  createStandaloneBudgetCoordinator,
  finalizeStandaloneBudgetTurn,
} from "../src/architect/token-economy/standalone-store.js";

describe("standalone Architect token economy store", () => {
  it("persists debt, repayment credit, and model-switch rescaling by session key", () => {
    const sessionKey = "architect-token-economy-store-test";
    const settings = {
      expectedTokensPerTurn: 16_000,
      transportCeilingTokens: 180_000,
      debtCarryFraction: 1,
      modelId: "gpt-5.4",
    };

    const first = createStandaloneBudgetCoordinator(sessionKey, settings);
    first.recordComponentActual("assistant", 18_000);
    const firstSnapshot = finalizeStandaloneBudgetTurn(sessionKey, first);
    expect(firstSnapshot.debtTokens).toBe(2_000);

    const second = createStandaloneBudgetCoordinator(sessionKey, settings);
    second.recordComponentActual("assistant", 12_000);
    const secondSnapshot = finalizeStandaloneBudgetTurn(sessionKey, second);
    expect(secondSnapshot.debtTokens).toBe(-2_000);
    expect(buildArchitectBudgetStatus(sessionKey, secondSnapshot, second.getContextPressureLabel())).toMatchObject({
      turn: 2,
      credit_tokens: 2_000,
      debt_tokens: 0,
      last_actual_tokens: 12_000,
    });

    const switched = createStandaloneBudgetCoordinator(sessionKey, { ...settings, modelId: "gpt-5.5" });
    const switchedSnapshot = finalizeStandaloneBudgetTurn(sessionKey, switched, 16_000);
    expect(switchedSnapshot.history.some((entry) => entry.modelSwitch?.from === "gpt-5.4" && entry.modelSwitch.to === "gpt-5.5")).toBe(true);
  });
});
