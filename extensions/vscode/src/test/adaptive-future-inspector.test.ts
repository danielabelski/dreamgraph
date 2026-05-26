/**
 * Source-level contract tests for Adaptive Future Engine Slice 6.
 *
 * These stay source-based because ContextInspector binds to VS Code APIs and
 * ContextBuilder construction requires live extension services.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const typesSource = fs.readFileSync(
  path.resolve(process.cwd(), 'src/types.ts'),
  'utf8',
);

const contextBuilderSource = fs.readFileSync(
  path.resolve(process.cwd(), 'src/context-builder.ts'),
  'utf8',
);

const inspectorSource = fs.readFileSync(
  path.resolve(process.cwd(), 'src/context-inspector.ts'),
  'utf8',
);

test('ReasoningPacket carries task preamble and adaptive future diagnostics', () => {
  assert.match(typesSource, /taskPreamble\?:\s*TaskPreambleCompilerDiagnostic/);
  assert.match(typesSource, /adaptiveFutureJudgment\?:\s*AdaptiveFutureJudgmentDiagnostic/);
  assert.match(typesSource, /omit_not_economical/);
  assert.match(typesSource, /validation_failed/);
});

test('ContextBuilder compiles bounded task preamble metadata into rendered context', () => {
  assert.match(contextBuilderSource, /const\s+taskPreambleCandidates\s*=\s*included\.filter/);
  assert.match(contextBuilderSource, /maxPreambleTokens\s*=\s*Math\.min\(300/);
  assert.match(contextBuilderSource, /## Task Preamble Compiler/);
  assert.match(contextBuilderSource, /## Adaptive Future Judgment/);
  assert.match(contextBuilderSource, /bounded evidence exceeded task preamble budget/);
});

test('ContextInspector exposes compact compiler and judgment diagnostics', () => {
  assert.match(inspectorSource, /Task Preamble Compiler:/);
  assert.match(inspectorSource, /Adaptive Future Judgment:/);
  assert.match(inspectorSource, /omitted-context reasons:/);
  assert.match(inspectorSource, /future objections:/);
  assert.match(inspectorSource, /selected model layer:/);
});
