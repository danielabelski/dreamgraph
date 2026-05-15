// Provider-agnostic tool classification tests.
//
// Verifies that the prefix-based classifiers (used by Lever 1 catalog
// narrowing and Lever 2 anchor-action binding) recognize the canonical
// host-local write/verify tools and tolerate MCP `mcp_<server>_` prefixing.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  isWriteToolName,
  isVerifyToolName,
  narrowToWriteAndVerify,
  pickPreferredWriteTool,
  APPLY_LABEL_PATTERN,
} from '../tool-classification.js';

test('isWriteToolName recognizes host-local write tools', () => {
  assert.equal(isWriteToolName('replace_string_in_file'), true);
  assert.equal(isWriteToolName('multi_replace_string_in_file'), true);
  assert.equal(isWriteToolName('create_file'), true);
  assert.equal(isWriteToolName('edit_notebook_file'), true);
  assert.equal(isWriteToolName('delete_file'), true);
});

test('isWriteToolName recognizes MCP-prefixed write tools', () => {
  assert.equal(isWriteToolName('mcp_dreamgraph_create_file'), true);
  assert.equal(isWriteToolName('mcp_dreamgraph_patch_file'), true);
  assert.equal(isWriteToolName('mcp_dreamgraph_edit_entity'), true);
  assert.equal(isWriteToolName('mcp_dreamgraph_register_ui_element'), true);
  assert.equal(isWriteToolName('mcp_dreamgraph_record_architecture_decision'), true);
});

test('isWriteToolName rejects pure-read tools', () => {
  assert.equal(isWriteToolName('read_file'), false);
  assert.equal(isWriteToolName('grep_search'), false);
  assert.equal(isWriteToolName('file_search'), false);
  assert.equal(isWriteToolName('semantic_search'), false);
  assert.equal(isWriteToolName('list_dir'), false);
  assert.equal(isWriteToolName('mcp_dreamgraph_read_source_code'), false);
  assert.equal(isWriteToolName('mcp_dreamgraph_query_resource'), false);
});

test('isVerifyToolName recognizes verification + execution tools', () => {
  assert.equal(isVerifyToolName('get_errors'), true);
  assert.equal(isVerifyToolName('runTests'), true);
  assert.equal(isVerifyToolName('run_in_terminal'), true);
  assert.equal(isVerifyToolName('run_notebook_cell'), true);
  assert.equal(isVerifyToolName('read_file'), true); // verify-after-write reads
});

test('isVerifyToolName rejects locator/search tools', () => {
  assert.equal(isVerifyToolName('grep_search'), false);
  assert.equal(isVerifyToolName('file_search'), false);
  assert.equal(isVerifyToolName('semantic_search'), false);
  assert.equal(isVerifyToolName('list_dir'), false);
});

test('narrowToWriteAndVerify keeps writes + verifies and drops pure searches', () => {
  const tools = [
    { name: 'grep_search' },
    { name: 'semantic_search' },
    { name: 'file_search' },
    { name: 'list_dir' },
    { name: 'read_file' },
    { name: 'replace_string_in_file' },
    { name: 'create_file' },
    { name: 'get_errors' },
    { name: 'run_in_terminal' },
  ];
  const narrowed = narrowToWriteAndVerify(tools);
  const names = narrowed.map((t) => t.name).sort();
  assert.deepEqual(names, [
    'create_file',
    'get_errors',
    'read_file',
    'replace_string_in_file',
    'run_in_terminal',
  ]);
});

test('narrowToWriteAndVerify falls back to full catalog when filter would be empty', () => {
  // No write or verify tools — must NOT empty out, since the loop would
  // then have nothing to call. "no failure: keep going until done".
  const tools = [{ name: 'grep_search' }, { name: 'file_search' }];
  const narrowed = narrowToWriteAndVerify(tools);
  assert.equal(narrowed.length, 2);
});

test('pickPreferredWriteTool prefers multi_replace then replace then create', () => {
  assert.equal(
    pickPreferredWriteTool([
      { name: 'create_file' },
      { name: 'replace_string_in_file' },
      { name: 'multi_replace_string_in_file' },
    ]),
    'multi_replace_string_in_file',
  );
  assert.equal(
    pickPreferredWriteTool([{ name: 'create_file' }, { name: 'replace_string_in_file' }]),
    'replace_string_in_file',
  );
  assert.equal(pickPreferredWriteTool([{ name: 'create_file' }]), 'create_file');
});

test('pickPreferredWriteTool falls back to the first write-classified tool', () => {
  assert.equal(
    pickPreferredWriteTool([{ name: 'mcp_dreamgraph_register_ui_element' }]),
    'mcp_dreamgraph_register_ui_element',
  );
});

test('pickPreferredWriteTool returns undefined when no write tools exist', () => {
  assert.equal(pickPreferredWriteTool([{ name: 'read_file' }, { name: 'grep_search' }]), undefined);
});

test('APPLY_LABEL_PATTERN matches the canonical apply/patch verbs', () => {
  for (const label of [
    'Apply the patch to chat-panel.ts',
    'Patch the autonomy module',
    'Implement the binding',
    'Write the helper',
    'Fix the regression',
    'Edit the loop',
    'Land the change',
    'Commit the file',
    'Introduce the new state field',
  ]) {
    assert.equal(APPLY_LABEL_PATTERN.test(label), true, `should match: ${label}`);
  }
});

test('APPLY_LABEL_PATTERN does NOT match pure read/locate verbs', () => {
  for (const label of [
    'Read chat-panel.ts to understand the flow',
    'Search for the call site',
    'Inspect the module',
    'Locate the function',
  ]) {
    assert.equal(APPLY_LABEL_PATTERN.test(label), false, `should not match: ${label}`);
  }
});
