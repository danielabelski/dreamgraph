/**
 * Tests for the timeout-diagnostics logging contract.
 *
 * The previous test relied on multi-line regex matches against chat-panel.ts
 * which broke whenever method bodies were refactored. This rewrite asserts:
 *
 *   - the ContextInspector format strings (small, stable, IS the contract)
 *   - that ChatPanel still wires diagnostics through (presence-only checks)
 *
 * ContextInspector is not instantiated directly because its constructor
 * binds to the `vscode` module, which the node:test harness does not load.
 */
export {};
//# sourceMappingURL=timeout-diagnostics.test.d.ts.map