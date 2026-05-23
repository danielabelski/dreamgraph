import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { getCardRendererScript } from '../webview/card-renderer.js';

function renderEnvelope(envelope: Record<string, unknown>): string {
  const context: { window: { renderEnvelope?: (env: Record<string, unknown>) => string } } = { window: {} };
  vm.runInNewContext(getCardRendererScript(), context);
  const fn = context.window.renderEnvelope;
  if (typeof fn !== 'function') throw new Error('renderEnvelope was not installed');
  return fn(envelope);
}

test('summary renderer disables privileged actions and suppresses mixed Do all', () => {
  const html = renderEnvelope({
    summary: 'Release is live.',
    recommended_next_steps: [
      { id: 'record', label: 'Record v10.6.0 release in DreamGraph knowledge graph' },
      { id: 'publish', label: 'Publish VSIX to VS Code Marketplace' },
    ],
  });

  assert.match(html, /data-blocked="true"/);
  assert.match(html, /Requires MCP graph-write tool enrich_seed_data/);
  assert.match(html, /Requires VSCE_PAT/);
  assert.doesNotMatch(html, />Do all</);
});

test('summary renderer trusts host capability checks', () => {
  const html = renderEnvelope({
    summary: 'Safe follow-ups.',
    doAllEligible: true,
    recommended_next_steps: [
      { id: 'a', label: 'Run focused tests', capabilityChecked: true },
      { id: 'b', label: 'Open release notes', capabilityChecked: true },
    ],
  });

  assert.doesNotMatch(html, /data-blocked="true"/);
  assert.match(html, />Do all</);
});
