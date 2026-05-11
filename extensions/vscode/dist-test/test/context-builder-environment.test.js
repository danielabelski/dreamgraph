"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const node_test_1 = __importDefault(require("node:test"));
const strict_1 = __importDefault(require("node:assert/strict"));
const environment_context_1 = require("../environment-context");
function createEnvelope() {
    return {
        workspaceRoot: 'c:/workspace/dreamgraph',
        instanceId: null,
        activeFile: {
            path: 'src/tools/web-senses.ts',
            languageId: 'typescript',
            lineCount: 200,
            cursorLine: 12,
            cursorColumn: 4,
            cursorSummary: 'registerWebSensesTools',
            cursorAnchor: {
                kind: 'symbol',
                label: 'registerWebSensesTools',
                path: 'src/tools/web-senses.ts',
                symbolPath: 'registerWebSensesTools',
                source: 'heuristic',
            },
            selection: null,
        },
        visibleFiles: ['src/tools/web-senses.ts'],
        changedFiles: [],
        pinnedFiles: [],
        environmentContext: {
            workspaceRuntime: 'Monorepo with daemon/backend root and VS Code extension subpackage',
            workspacePackageManager: 'npm@10.0.0',
            entries: [
                {
                    scope: 'src/tools/',
                    runtime: 'Daemon tool runtime / Node.js',
                    moduleSystem: 'TypeScript + ESM',
                    role: 'MCP tool implementations and external capability adapters',
                    boundaries: [
                        'Tool handlers execute inside daemon runtime',
                        'May depend on web/database/CLI libraries but not VS Code host APIs',
                    ],
                    keyDependencies: ['@modelcontextprotocol/sdk', 'cheerio', 'turndown'],
                },
                {
                    scope: 'src/',
                    runtime: 'DreamGraph monorepo core / Node.js',
                    moduleSystem: 'TypeScript + ESM',
                    role: 'Core daemon/runtime codebase',
                    boundaries: ['Root src/* is backend/daemon-oriented unless a narrower scope says otherwise'],
                    keyDependencies: ['@modelcontextprotocol/sdk', 'express', 'zod'],
                },
            ],
        },
        graphContext: null,
        intentMode: 'active_file',
        intentConfidence: 0.8,
    };
}
function createFallbackPlan() {
    return {
        intentMode: 'active_file',
        taskSummary: 'src/tools/web-senses.ts',
        primaryAnchor: {
            kind: 'symbol',
            label: 'registerWebSensesTools',
            path: 'src/tools/web-senses.ts',
            symbolPath: 'registerWebSensesTools',
            source: 'heuristic',
        },
        secondaryAnchors: [],
        requiredEvidence: [],
        optionalEvidence: ['environment', 'feature', 'workflow', 'adr', 'api', 'ui', 'tension'],
        codeReadPlan: [],
        budgetPolicy: {
            maxTokens: 1200,
            reserveTokens: 240,
            reserveGraphTokens: 800,
            allowFullActiveFile: false,
            includeOptionalEvidence: true,
        },
    };
}
function estimateTokens(text) {
    return Math.ceil(text.length / 4);
}
function sortEvidence(items) {
    return [...items].sort((a, b) => {
        if (a.required !== b.required)
            return a.required ? -1 : 1;
        if (b.relevance !== a.relevance)
            return b.relevance - a.relevance;
        return (b.confidence ?? 0) - (a.confidence ?? 0);
    });
}
(0, node_test_1.default)('fallback planning contract keeps environment evidence in optional evidence', () => {
    const plan = createFallbackPlan();
    strict_1.default.ok(plan.optionalEvidence.includes('environment'));
});
(0, node_test_1.default)('environment evidence ranks ahead of low-priority notes and stays within a compact token budget', () => {
    const envelope = createEnvelope();
    const plan = createFallbackPlan();
    const environmentContent = (0, environment_context_1.renderEnvironmentContextBlock)(envelope.environmentContext, envelope.activeFile?.path);
    strict_1.default.ok(environmentContent);
    const taskItem = {
        kind: 'task',
        title: 'Task Framing',
        content: '## Task Framing\nIntent mode: active_file\nTask: src/tools/web-senses.ts\nPrimary anchor: registerWebSensesTools',
        relevance: 1,
        confidence: envelope.intentConfidence,
        anchor: plan.primaryAnchor?.label,
        tokenCost: 30,
        required: true,
    };
    const environmentItem = {
        kind: 'environment',
        title: 'Environment Context',
        content: environmentContent ?? '',
        relevance: 0.93,
        tokenCost: estimateTokens(environmentContent ?? ''),
        required: false,
    };
    const noteItem = {
        kind: 'note',
        title: 'Additional Note',
        content: 'This is a low-priority note.',
        relevance: 0.4,
        tokenCost: estimateTokens('This is a low-priority note.'),
        required: false,
    };
    const sorted = sortEvidence([noteItem, environmentItem, taskItem]);
    strict_1.default.equal(sorted[0]?.kind, 'task');
    strict_1.default.equal(sorted[1]?.kind, 'environment');
    strict_1.default.equal(sorted[2]?.kind, 'note');
    strict_1.default.match(environmentItem.content, /## Environment Context/);
    strict_1.default.match(environmentItem.content, /Scope `src\/tools\/`/);
    strict_1.default.match(environmentItem.content, /Key dependencies: @modelcontextprotocol\/sdk, cheerio, turndown/);
    strict_1.default.ok(environmentItem.tokenCost < 220, `expected compact token cost, got ${environmentItem.tokenCost}`);
});
//# sourceMappingURL=context-builder-environment.test.js.map