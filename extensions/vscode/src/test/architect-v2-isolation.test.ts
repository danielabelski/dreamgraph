// Architect-v2 — ADR-171 isolation guard test.
// Re-runs scripts/lint-isolation.mjs and asserts a clean (zero-violation)
// pass. This pins the invariant that no v1 import or live MCP tool name
// leaks into architect-v2 outside the allowlisted seams.
//
// ADR-171: `mcp_dreamgraph_*` symbols only inside orchestrator/adapters/dreamgraph/**
// ADR-140: no v1 imports anywhere under architect-v2/

import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';

// Compiled into dist/test/. Walk up to the extension root.
// `__dirname` is provided by the CommonJS wrapper at runtime.
declare const __dirname: string;
const EXTENSION_ROOT = resolve(__dirname, '..', '..');
const LINT_SCRIPT = resolve(EXTENSION_ROOT, 'scripts', 'lint-isolation.mjs');

test('ADR-171 + ADR-140 isolation lint reports zero violations', () => {
  const result = spawnSync(process.execPath, [LINT_SCRIPT], {
    cwd: EXTENSION_ROOT,
    encoding: 'utf8',
  });

  const stdout = result.stdout ?? '';
  const stderr = result.stderr ?? '';

  assert.equal(
    result.status,
    0,
    `lint:isolation exited with ${result.status}.\nSTDOUT:\n${stdout}\nSTDERR:\n${stderr}`,
  );
  assert.match(stdout, /0 violations/, `expected "0 violations" in stdout. Got:\n${stdout}`);
});
