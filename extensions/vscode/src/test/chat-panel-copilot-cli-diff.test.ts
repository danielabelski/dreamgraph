// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Source-level audit for Plan A: turn-level workspace snapshot bookend
// around copilot-cli runs, so the change-review pending list (and thus
// the architect Diff view) populates for copilot-cli the same way it
// does for the native API adapters.
//
// Plan A's correctness rests on three things being present in
// chat-panel.ts:
//
//   1. Both copilot-cli call sites (`handleUserMessage` and
//      `_runAutonomyContinuationPass`) capture a snapshot via
//      `changeReviewService.captureWorkspaceSnapshot()` BEFORE
//      `runPassViaCopilotCli` runs, gated on `copilotCliRoute`.
//   2. The capture is paired with `recordWorkspaceChanges` in a
//      `finally` so the pending list is reconciled even on errors.
//   3. When recorded paths exist, the webview is notified via
//      `_postPendingReviews()` so the Diff button lights up.
//
// Live integration testing requires the vscode module (chat-panel
// can't be loaded outside the host), so we audit the source the same
// way slice5-audit does.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const chatPanelSource = readFileSync(
  join(process.cwd(), 'src', 'chat-panel.ts'),
  'utf8',
);

test('Plan A: copilot-cli turn captures a workspace snapshot before runPassViaCopilotCli', () => {
  // Snapshot var must be declared and gated on copilotCliRoute, with
  // the captureWorkspaceSnapshot call as the right-hand side.
  const occurrences = chatPanelSource.match(
    /const copilotCliReviewSnapshot = copilotCliRoute\s*\?\s*await changeReviewService\.captureWorkspaceSnapshot\(\)\s*:\s*null;/g,
  );
  assert.ok(
    occurrences && occurrences.length === 2,
    `expected 2 captureWorkspaceSnapshot bookends (handleUserMessage + autonomy continuation), found ${occurrences?.length ?? 0}`,
  );
});

test('Plan A: copilot-cli turn reconciles via recordWorkspaceChanges in finally', () => {
  const occurrences = chatPanelSource.match(
    /if \(copilotCliReviewSnapshot\) \{[\s\S]*?changeReviewService\.recordWorkspaceChanges\(copilotCliReviewSnapshot\)/g,
  );
  assert.ok(
    occurrences && occurrences.length === 2,
    `expected 2 recordWorkspaceChanges reconciliation blocks, found ${occurrences?.length ?? 0}`,
  );
});

test('Plan A: when changed paths exist the pending-review webview push fires', () => {
  // Anchor on the copilot-cli bookend specifically: the
  // recordWorkspaceChanges call must be immediately followed by the
  // post-pending sequence in the same block. Both bookend sites
  // (handleUserMessage + autonomy continuation) must satisfy this.
  const occurrences = chatPanelSource.match(
    /changeReviewService\.recordWorkspaceChanges\(copilotCliReviewSnapshot\);\s*if \(changedReviewPaths\.length > 0\) \{\s*this\._pendingReviewsCollapsed = true;\s*await this\._postPendingReviews\(\);\s*\}/g,
  );
  assert.ok(
    occurrences && occurrences.length === 2,
    `expected 2 copilot-cli pending-review post sites, found ${occurrences?.length ?? 0}`,
  );
});

test('Plan A: review reconciliation errors are swallowed (do not break the turn)', () => {
  // Both reconciliation blocks must wrap the record/post pair in a
  // try/catch that only warns — review-tracking failures must never
  // tear down a copilot-cli turn.
  const occurrences = chatPanelSource.match(
    /catch \(reviewErr\) \{\s*console\.warn\(\s*'\[DreamGraph\] Failed to record pending review changes for copilot-cli/g,
  );
  assert.ok(
    occurrences && occurrences.length === 2,
    `expected 2 swallowed-error sites, found ${occurrences?.length ?? 0}`,
  );
});
