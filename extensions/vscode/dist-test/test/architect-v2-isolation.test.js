"use strict";
// Architect-v2 — ADR-171 isolation guard test.
// Re-runs scripts/lint-isolation.mjs and asserts a clean (zero-violation)
// pass. This pins the invariant that no v1 import or live MCP tool name
// leaks into architect-v2 outside the allowlisted seams.
//
// ADR-171: `mcp_dreamgraph_*` symbols only inside orchestrator/adapters/dreamgraph/**
// ADR-140: no v1 imports anywhere under architect-v2/
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const node_test_1 = __importDefault(require("node:test"));
const strict_1 = __importDefault(require("node:assert/strict"));
const node_child_process_1 = require("node:child_process");
const node_path_1 = require("node:path");
const EXTENSION_ROOT = (0, node_path_1.resolve)(__dirname, '..', '..');
const LINT_SCRIPT = (0, node_path_1.resolve)(EXTENSION_ROOT, 'scripts', 'lint-isolation.mjs');
(0, node_test_1.default)('ADR-171 + ADR-140 isolation lint reports zero violations', () => {
    const result = (0, node_child_process_1.spawnSync)(process.execPath, [LINT_SCRIPT], {
        cwd: EXTENSION_ROOT,
        encoding: 'utf8',
    });
    const stdout = result.stdout ?? '';
    const stderr = result.stderr ?? '';
    strict_1.default.equal(result.status, 0, `lint:isolation exited with ${result.status}.\nSTDOUT:\n${stdout}\nSTDERR:\n${stderr}`);
    strict_1.default.match(stdout, /0 violations/, `expected "0 violations" in stdout. Got:\n${stdout}`);
});
//# sourceMappingURL=architect-v2-isolation.test.js.map