"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
// Provider-agnostic tool classification tests.
//
// Verifies that the prefix-based classifiers (used by Lever 1 catalog
// narrowing and Lever 2 anchor-action binding) recognize the canonical
// host-local write/verify tools and tolerate MCP `mcp_<server>_` prefixing.
const node_test_1 = __importDefault(require("node:test"));
const strict_1 = __importDefault(require("node:assert/strict"));
const tool_classification_js_1 = require("../tool-classification.js");
(0, node_test_1.default)('isWriteToolName recognizes host-local write tools', () => {
    strict_1.default.equal((0, tool_classification_js_1.isWriteToolName)('replace_string_in_file'), true);
    strict_1.default.equal((0, tool_classification_js_1.isWriteToolName)('multi_replace_string_in_file'), true);
    strict_1.default.equal((0, tool_classification_js_1.isWriteToolName)('create_file'), true);
    strict_1.default.equal((0, tool_classification_js_1.isWriteToolName)('edit_notebook_file'), true);
    strict_1.default.equal((0, tool_classification_js_1.isWriteToolName)('delete_file'), true);
});
(0, node_test_1.default)('isWriteToolName recognizes MCP-prefixed write tools', () => {
    strict_1.default.equal((0, tool_classification_js_1.isWriteToolName)('mcp_dreamgraph_create_file'), true);
    strict_1.default.equal((0, tool_classification_js_1.isWriteToolName)('mcp_dreamgraph_patch_file'), true);
    strict_1.default.equal((0, tool_classification_js_1.isWriteToolName)('mcp_dreamgraph_edit_entity'), true);
    strict_1.default.equal((0, tool_classification_js_1.isWriteToolName)('mcp_dreamgraph_register_ui_element'), true);
    strict_1.default.equal((0, tool_classification_js_1.isWriteToolName)('mcp_dreamgraph_record_architecture_decision'), true);
});
(0, node_test_1.default)('isWriteToolName rejects pure-read tools', () => {
    strict_1.default.equal((0, tool_classification_js_1.isWriteToolName)('read_file'), false);
    strict_1.default.equal((0, tool_classification_js_1.isWriteToolName)('grep_search'), false);
    strict_1.default.equal((0, tool_classification_js_1.isWriteToolName)('file_search'), false);
    strict_1.default.equal((0, tool_classification_js_1.isWriteToolName)('semantic_search'), false);
    strict_1.default.equal((0, tool_classification_js_1.isWriteToolName)('list_dir'), false);
    strict_1.default.equal((0, tool_classification_js_1.isWriteToolName)('mcp_dreamgraph_read_source_code'), false);
    strict_1.default.equal((0, tool_classification_js_1.isWriteToolName)('mcp_dreamgraph_query_resource'), false);
});
(0, node_test_1.default)('isVerifyToolName recognizes verification + execution tools', () => {
    strict_1.default.equal((0, tool_classification_js_1.isVerifyToolName)('get_errors'), true);
    strict_1.default.equal((0, tool_classification_js_1.isVerifyToolName)('runTests'), true);
    strict_1.default.equal((0, tool_classification_js_1.isVerifyToolName)('run_in_terminal'), true);
    strict_1.default.equal((0, tool_classification_js_1.isVerifyToolName)('run_notebook_cell'), true);
    strict_1.default.equal((0, tool_classification_js_1.isVerifyToolName)('read_file'), true); // verify-after-write reads
});
(0, node_test_1.default)('isVerifyToolName rejects locator/search tools', () => {
    strict_1.default.equal((0, tool_classification_js_1.isVerifyToolName)('grep_search'), false);
    strict_1.default.equal((0, tool_classification_js_1.isVerifyToolName)('file_search'), false);
    strict_1.default.equal((0, tool_classification_js_1.isVerifyToolName)('semantic_search'), false);
    strict_1.default.equal((0, tool_classification_js_1.isVerifyToolName)('list_dir'), false);
});
(0, node_test_1.default)('narrowToWriteAndVerify keeps writes + verifies and drops pure searches', () => {
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
    const narrowed = (0, tool_classification_js_1.narrowToWriteAndVerify)(tools);
    const names = narrowed.map((t) => t.name).sort();
    strict_1.default.deepEqual(names, [
        'create_file',
        'get_errors',
        'read_file',
        'replace_string_in_file',
        'run_in_terminal',
    ]);
});
(0, node_test_1.default)('narrowToWriteAndVerify falls back to full catalog when filter would be empty', () => {
    // No write or verify tools — must NOT empty out, since the loop would
    // then have nothing to call. "no failure: keep going until done".
    const tools = [{ name: 'grep_search' }, { name: 'file_search' }];
    const narrowed = (0, tool_classification_js_1.narrowToWriteAndVerify)(tools);
    strict_1.default.equal(narrowed.length, 2);
});
(0, node_test_1.default)('pickPreferredWriteTool prefers multi_replace then replace then create', () => {
    strict_1.default.equal((0, tool_classification_js_1.pickPreferredWriteTool)([
        { name: 'create_file' },
        { name: 'replace_string_in_file' },
        { name: 'multi_replace_string_in_file' },
    ]), 'multi_replace_string_in_file');
    strict_1.default.equal((0, tool_classification_js_1.pickPreferredWriteTool)([{ name: 'create_file' }, { name: 'replace_string_in_file' }]), 'replace_string_in_file');
    strict_1.default.equal((0, tool_classification_js_1.pickPreferredWriteTool)([{ name: 'create_file' }]), 'create_file');
});
(0, node_test_1.default)('pickPreferredWriteTool falls back to the first write-classified tool', () => {
    strict_1.default.equal((0, tool_classification_js_1.pickPreferredWriteTool)([{ name: 'mcp_dreamgraph_register_ui_element' }]), 'mcp_dreamgraph_register_ui_element');
});
(0, node_test_1.default)('pickPreferredWriteTool returns undefined when no write tools exist', () => {
    strict_1.default.equal((0, tool_classification_js_1.pickPreferredWriteTool)([{ name: 'read_file' }, { name: 'grep_search' }]), undefined);
});
(0, node_test_1.default)('APPLY_LABEL_PATTERN matches the canonical apply/patch verbs', () => {
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
        strict_1.default.equal(tool_classification_js_1.APPLY_LABEL_PATTERN.test(label), true, `should match: ${label}`);
    }
});
(0, node_test_1.default)('APPLY_LABEL_PATTERN does NOT match pure read/locate verbs', () => {
    for (const label of [
        'Read chat-panel.ts to understand the flow',
        'Search for the call site',
        'Inspect the module',
        'Locate the function',
    ]) {
        strict_1.default.equal(tool_classification_js_1.APPLY_LABEL_PATTERN.test(label), false, `should not match: ${label}`);
    }
});
//# sourceMappingURL=tool-classification.test.js.map