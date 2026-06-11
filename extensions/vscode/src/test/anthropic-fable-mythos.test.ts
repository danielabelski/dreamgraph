import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

function readRepoFile(...parts: string[]): string {
  return readFileSync(join(process.cwd(), ...parts), 'utf8');
}

test('Anthropic Fable/Mythos inventory is exposed without changing the governed default', () => {
  const architectLlm = readRepoFile('src', 'architect-llm.ts');
  const pkg = JSON.parse(readRepoFile('package.json'));

  assert.match(architectLlm, /export const ANTHROPIC_MODELS = \[[\s\S]*"claude-fable-5"[\s\S]*"claude-mythos-5"/);
  assert.match(architectLlm, /case "anthropic":\s*return "claude-opus-4-7";/);
  assert.equal(pkg.contributes.configuration.properties['dreamgraph.architect.model'].default, 'claude-opus-4-7');
  assert.match(
    pkg.contributes.configuration.properties['dreamgraph.architect.model'].description,
    /claude-fable-5[\s\S]*claude-mythos-5/,
  );
});

test('Anthropic request helpers route Fable/Mythos through effort and adaptive thinking', () => {
  const architectLlm = readRepoFile('src', 'architect-llm.ts');

  assert.match(architectLlm, /const ANTHROPIC_EFFORT_MODELS = \[[\s\S]*"claude-fable-5"[\s\S]*"claude-mythos-5"/);
  assert.match(architectLlm, /export function supportsAnthropicEffortConfig\(model: string\): boolean/);
  assert.match(architectLlm, /export function supportsAnthropicAdaptiveThinking\(model: string\): boolean \{\s*return supportsAnthropicEffortConfig\(model\);\s*\}/);
  assert.match(architectLlm, /normalized\.startsWith\("claude-fable-5"\)[\s\S]*return 128_000;/);
  assert.match(architectLlm, /if \(supportsAnthropicEffortConfig\(config\.model\)\) \{\s*body\.output_config = \{ effort: this\._getAnthropicEffort\(config\.model\) \};/);
  assert.doesNotMatch(architectLlm, /budget_tokens/);
});

test('Standalone and quarantined v2 Anthropic metadata include Fable/Mythos', () => {
  const routes = readRepoFile('..', '..', 'src', 'architect', 'routes.ts');
  const v2Anthropic = readRepoFile('_quarantine', 'architect-v2', 'providers', 'anthropic.ts');

  assert.match(routes, /anthropic: \[[^\]]*'claude-fable-5'[^\]]*'claude-mythos-5'/);
  assert.match(v2Anthropic, /id: "claude-fable-5"[\s\S]*contextWindow: 1_000_000[\s\S]*maxOutputTokens: 128_000/);
  assert.match(v2Anthropic, /id: "claude-mythos-5"[\s\S]*displayName: "Claude Mythos 5"[\s\S]*maxOutputTokens: 65_536/);
  assert.match(v2Anthropic, /defaultModelId: "claude-opus-4-7"/);
});

test('Anthropic migration docs do not claim Mythos is generally available', () => {
  const docs = readRepoFile('..', '..', 'docs', 'anthropic-opus-4-7.md');

  assert.match(docs, /Mythos 5 may require Anthropic account access/);
  assert.match(docs, /Use Mythos 5 only when the Anthropic account has access/);
  assert.match(docs, /ADR-150 locks the Anthropic default to Opus 4\.7/);
  assert.doesNotMatch(docs, /Mythos 5 is generally available/i);
});
