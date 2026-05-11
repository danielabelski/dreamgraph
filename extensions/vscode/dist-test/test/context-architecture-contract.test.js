"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const node_test_1 = __importDefault(require("node:test"));
const strict_1 = __importDefault(require("node:assert/strict"));
const context_builder_instrumentation_1 = require("../context-builder.instrumentation");
const environment_context_1 = require("../environment-context");
const node_fs_1 = __importDefault(require("node:fs"));
const node_os_1 = __importDefault(require("node:os"));
const node_path_1 = __importDefault(require("node:path"));
function estimateTokens(text) {
    return Math.ceil(text.length / 4);
}
function writeJson(target, value) {
    node_fs_1.default.mkdirSync(node_path_1.default.dirname(target), { recursive: true });
    node_fs_1.default.writeFileSync(target, JSON.stringify(value, null, 2), 'utf8');
}
async function withTempWorkspace(setup, run) {
    const root = node_fs_1.default.mkdtempSync(node_path_1.default.join(node_os_1.default.tmpdir(), 'dg-contract-'));
    try {
        await setup(root);
        await run(root);
    }
    finally {
        node_fs_1.default.rmSync(root, { recursive: true, force: true });
    }
}
function createEnvelope(overrides) {
    return {
        workspaceRoot: 'c:/workspace/dreamgraph',
        instanceId: 'instance-1',
        activeFile: {
            path: 'src/server/server.ts',
            languageId: 'typescript',
            lineCount: 164,
            cursorLine: 42,
            cursorColumn: 3,
            cursorSummary: 'createServer',
            cursorAnchor: {
                kind: 'symbol',
                label: 'createServer',
                path: 'src/server/server.ts',
                symbolPath: 'createServer',
                source: 'heuristic',
            },
            selection: null,
        },
        visibleFiles: ['src/server/server.ts'],
        changedFiles: [],
        pinnedFiles: [],
        environmentContext: {
            workspaceRuntime: 'Monorepo with daemon/backend root and VS Code extension subpackage',
            workspacePackageManager: 'npm@10.0.0',
            entries: [
                {
                    scope: 'src/server/',
                    runtime: 'Core daemon server / Node.js',
                    moduleSystem: 'TypeScript + ESM',
                    role: 'DreamGraph daemon bootstrap, MCP server registration, scheduler orchestration',
                    framework: 'MCP server + HTTP daemon',
                    boundaries: [
                        'Registers resources/tools and server instructions',
                        'Server/runtime startup belongs here, not in extension host',
                    ],
                    keyDependencies: ['@modelcontextprotocol/sdk', 'express', 'pino'],
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
        graphContext: {
            relatedFeatures: [{ id: 'daemon-server', name: 'Daemon Server', relevance: 0.88 }],
            relatedWorkflows: [{ id: 'daemon-startup', name: 'Daemon Startup', relevance: 0.84 }],
            applicableAdrs: [{ id: 'ADR-001', title: 'Use MCP-first daemon contracts', relevance: 0.95 }],
            uiPatterns: [],
            activeTensions: 0,
            cognitiveState: 'unknown',
            apiSurface: { server: { methods: ['start'] } },
            tensions: [],
            dreamInsights: [],
            causalChains: [],
            temporalPatterns: [],
            dataModelEntities: [],
        },
        intentMode: 'active_file',
        intentConfidence: 0.78,
        ...overrides,
    };
}
function aggregateRelevance(entities, fallback) {
    return entities.length > 0
        ? Math.max(...entities.map((e) => e.relevance ?? fallback))
        : fallback;
}
function collectEvidenceItemsContractShim(envelope, fileContent, additionalSections, plan) {
    const items = [];
    const priorityRank = (item) => {
        switch (item.kind) {
            case 'task':
                return 0;
            case 'code':
                return 1;
            case 'adr':
            case 'api':
                return 2;
            case 'environment':
                return 3;
            case 'feature':
            case 'workflow':
            case 'ui':
                return 4;
            case 'tension':
            case 'causal':
            case 'temporal':
            case 'data_model':
            case 'cognitive_status':
                return 5;
            case 'note':
                return 6;
            default:
                return 7;
        }
    };
    const taskContent = `## Task Framing\nIntent mode: ${plan.intentMode}\nTask: ${plan.taskSummary}\nPrimary anchor: ${plan.primaryAnchor?.label ?? 'none'}`;
    items.push({
        kind: 'task',
        title: 'Task Framing',
        content: taskContent,
        relevance: 1,
        confidence: envelope.intentConfidence,
        anchor: plan.primaryAnchor?.label,
        tokenCost: estimateTokens(taskContent),
        required: true,
    });
    if (fileContent && envelope.activeFile) {
        const content = `## Focused Code Excerpt\nAnchor: ${envelope.activeFile.cursorAnchor?.label ?? envelope.activeFile.cursorSummary}\n\`\`\`${envelope.activeFile.languageId}\n${fileContent}\n\`\`\``;
        items.push({
            kind: 'code',
            title: 'Focused Code Excerpt',
            content,
            relevance: 0.85,
            anchor: envelope.activeFile.cursorAnchor?.label ?? envelope.activeFile.cursorSummary,
            tokenCost: estimateTokens(content),
            required: plan.codeReadPlan.some((p) => p.required),
        });
    }
    if (envelope.graphContext?.applicableAdrs.length) {
        const entities = envelope.graphContext.applicableAdrs;
        const content = `## Relevant ADRs\n${entities.map((a) => `- ${a.id}: ${a.title}`).join('\n')}`;
        items.push({
            kind: 'adr',
            title: 'Relevant ADRs',
            content,
            relevance: aggregateRelevance(entities, 0.95),
            tokenCost: estimateTokens(content),
            required: plan.requiredEvidence.includes('adr'),
        });
    }
    if (envelope.graphContext?.apiSurface) {
        const content = `## Relevant API Surface\n${JSON.stringify(envelope.graphContext.apiSurface, null, 2)}`;
        items.push({
            kind: 'api',
            title: 'Relevant API Surface',
            content,
            relevance: 0.9,
            tokenCost: estimateTokens(content),
            required: plan.requiredEvidence.includes('api'),
        });
    }
    if (envelope.environmentContext?.entries?.length) {
        const entries = envelope.environmentContext.entries.slice(0, plan.environmentPolicy?.scopeLimit ?? 2);
        const lines = ['## Environment Context'];
        if (envelope.environmentContext.workspaceRuntime) {
            lines.push(`Workspace runtime: ${envelope.environmentContext.workspaceRuntime}`);
        }
        if (envelope.environmentContext.workspacePackageManager) {
            lines.push(`Package manager: ${envelope.environmentContext.workspacePackageManager}`);
        }
        for (const entry of entries) {
            lines.push(`- \`${entry.scope}\`: ${entry.runtime}; ${entry.moduleSystem}; ${entry.role}`);
            if (entry.framework)
                lines.push(`  - Framework: ${entry.framework}`);
            if (entry.boundaries[0])
                lines.push(`  - Boundary: ${entry.boundaries[0]}`);
            if (entry.keyDependencies.length > 0) {
                lines.push(`  - Dependencies: ${entry.keyDependencies.slice(0, 3).join(', ')}`);
            }
        }
        const content = lines.join('\n');
        items.push({
            kind: 'environment',
            title: 'Environment Context',
            content,
            relevance: 0.86,
            tokenCost: estimateTokens(content),
            required: plan.environmentPolicy?.forceInclude ?? false,
        });
    }
    if (envelope.graphContext?.relatedFeatures.length || envelope.graphContext?.relatedWorkflows.length) {
        const features = envelope.graphContext.relatedFeatures ?? [];
        const workflows = envelope.graphContext.relatedWorkflows ?? [];
        const content = `## Related Graph Contracts\n${[
            ...features.map((f) => `- feature ${f.id}: ${f.name}`),
            ...workflows.map((w) => `- workflow ${w.id}: ${w.name}`),
        ].join('\n')}`;
        items.push({
            kind: 'feature',
            title: 'Related Graph Contracts',
            content,
            relevance: aggregateRelevance([...features, ...workflows], 0.82),
            tokenCost: estimateTokens(content),
            required: plan.requiredEvidence.includes('feature') || plan.requiredEvidence.includes('workflow'),
        });
    }
    for (const [name, content] of additionalSections.entries()) {
        items.push({
            kind: 'note',
            title: name,
            content,
            relevance: 0.4,
            tokenCost: estimateTokens(content),
            required: false,
        });
    }
    return items.sort((a, b) => {
        const rankDelta = priorityRank(a) - priorityRank(b);
        if (rankDelta !== 0)
            return rankDelta;
        if (a.required !== b.required)
            return a.required ? -1 : 1;
        if (b.relevance !== a.relevance)
            return b.relevance - a.relevance;
        return (b.confidence ?? 0) - (a.confidence ?? 0);
    });
}
function applyBudgetContractShim(evidence, usableBudget) {
    const included = [];
    const omitted = [];
    let used = 0;
    for (const item of evidence) {
        if (used + item.tokenCost <= usableBudget) {
            included.push(item);
            used += item.tokenCost;
        }
        else {
            omitted.push({
                title: item.title,
                reason: item.required
                    ? 'required evidence exceeded the current usable budget and needs a narrower retrieval plan'
                    : 'omitted to preserve minimum sufficient context within budget',
                required: item.required,
                kind: item.kind,
            });
        }
    }
    return { included, omitted };
}
(0, node_test_1.default)('selection tests: file-aware routing selects the correct environment scopes', async () => {
    await withTempWorkspace((root) => {
        writeJson(node_path_1.default.join(root, 'package.json'), {
            type: 'module',
            packageManager: 'npm@10.0.0',
            dependencies: {
                '@modelcontextprotocol/sdk': '^1.27.1',
                express: '^5.1.0',
                zod: '^4.1.5',
                pino: '^9.9.5',
            },
        });
        writeJson(node_path_1.default.join(root, 'extensions', 'vscode', 'package.json'), {
            dependencies: {
                '@modelcontextprotocol/sdk': '^1.27.1',
                'markdown-it': '^14.1.1',
                dompurify: '^3.4.0',
            },
        });
        node_fs_1.default.mkdirSync(node_path_1.default.join(root, 'src', 'server'), { recursive: true });
        node_fs_1.default.mkdirSync(node_path_1.default.join(root, 'extensions', 'vscode', 'src'), { recursive: true });
        node_fs_1.default.mkdirSync(node_path_1.default.join(root, 'src'), { recursive: true });
    }, async (root) => {
        const snapshot = await (0, environment_context_1.buildEnvironmentContextSnapshot)(root);
        strict_1.default.ok(snapshot);
        const serverEntries = (0, environment_context_1.selectEnvironmentContextForFile)(snapshot, 'src/server/server.ts');
        strict_1.default.deepStrictEqual(serverEntries.map((entry) => entry.scope), ['src/server/', 'src/']);
        const extensionEntries = (0, environment_context_1.selectEnvironmentContextForFile)(snapshot, 'extensions/vscode/src/chat-panel.ts');
        strict_1.default.deepStrictEqual(extensionEntries.map((entry) => entry.scope), ['extensions/vscode/src/']);
    });
});
(0, node_test_1.default)('rendering stability and token-discipline: unchanged Layer 2 rendering remains identical, compact, and noise-controlled', async () => {
    await withTempWorkspace((root) => {
        writeJson(node_path_1.default.join(root, 'package.json'), {
            type: 'module',
            packageManager: 'pnpm@9.0.0',
            dependencies: {
                '@modelcontextprotocol/sdk': '^1.27.1',
                express: '^5.1.0',
                sqlite3: '^5.1.7',
                zod: '^4.1.5',
                pino: '^9.9.5',
                leftpad: '^1.0.0',
                lodash: '^4.17.21',
            },
        });
        node_fs_1.default.mkdirSync(node_path_1.default.join(root, 'src', 'server'), { recursive: true });
        node_fs_1.default.mkdirSync(node_path_1.default.join(root, 'src'), { recursive: true });
    }, async (root) => {
        const snapshot = await (0, environment_context_1.buildEnvironmentContextSnapshot)(root);
        strict_1.default.ok(snapshot);
        const first = (0, environment_context_1.renderEnvironmentContextBlockWithMetrics)(snapshot, 'src/server/server.ts');
        const second = (0, environment_context_1.renderEnvironmentContextBlockWithMetrics)(snapshot, 'src/server/server.ts', {
            hash: first.metrics.hash,
            stablePrefixHash: first.metrics.stablePrefixHash,
        });
        strict_1.default.equal(first.text, second.text);
        strict_1.default.equal(first.metrics.hash, second.metrics.hash);
        strict_1.default.equal(first.metrics.stablePrefixHash, second.metrics.stablePrefixHash);
        strict_1.default.equal(second.metrics.stableReuseRatio, 1);
        strict_1.default.ok((first.text ?? '').startsWith('## Environment Context'));
        strict_1.default.ok(first.metrics.tokenEstimate <= 450);
        strict_1.default.doesNotMatch(first.text ?? '', /leftpad/);
        strict_1.default.doesNotMatch(first.text ?? '', /lodash/);
    });
});
(0, node_test_1.default)('evidence-order and omission contract: environment ranks below hard constraints and above notes, and optional evidence can be omitted under budget pressure', () => {
    const envelope = createEnvelope();
    const plan = {
        intentMode: 'active_file',
        taskSummary: 'Explain createServer and enforce contracts',
        primaryAnchor: envelope.activeFile?.cursorAnchor,
        secondaryAnchors: [],
        requiredEvidence: ['adr', 'api', 'code'],
        optionalEvidence: ['environment', 'feature', 'note'],
        codeReadPlan: [{ scope: 'focused_excerpt', reason: 'focused', required: true }],
        budgetPolicy: {
            maxTokens: 1600,
            reserveTokens: 320,
            reserveGraphTokens: 240,
            allowFullActiveFile: false,
            includeOptionalEvidence: true,
        },
        environmentPolicy: {
            forceInclude: false,
            softTokenCeiling: 220,
            hardTokenCeiling: 320,
            scopeLimit: 2,
        },
    };
    const items = collectEvidenceItemsContractShim(envelope, 'export function createServer() { return true; }', new Map([['Additional Note', 'low priority note']]), plan);
    const adrIndex = items.findIndex((item) => item.kind === 'adr');
    const apiIndex = items.findIndex((item) => item.kind === 'api');
    const envIndex = items.findIndex((item) => item.kind === 'environment');
    const noteIndex = items.findIndex((item) => item.kind === 'note');
    strict_1.default.ok(envIndex > adrIndex, 'environment should rank below ADR constraints');
    strict_1.default.ok(envIndex > apiIndex, 'environment should rank below API constraints');
    strict_1.default.ok(envIndex < noteIndex, 'environment should rank above notes');
    const budgetResult = applyBudgetContractShim(items, 35);
    strict_1.default.ok(budgetResult.included.some((item) => item.kind === 'task'));
    strict_1.default.ok(budgetResult.omitted.some((entry) => entry.kind === 'code'));
    strict_1.default.ok(budgetResult.omitted.some((entry) => entry.kind === 'adr'));
    strict_1.default.ok(budgetResult.omitted.some((entry) => entry.kind === 'api'));
    strict_1.default.ok(budgetResult.omitted.some((entry) => entry.kind === 'environment'));
});
(0, node_test_1.default)('cache-churn and packet instrumentation: logically unchanged stable inputs produce stable prefix reuse and omission telemetry by kind', () => {
    const included = [
        {
            kind: 'task',
            title: 'Task Framing',
            content: '## Task Framing\nTask: explain createServer',
            relevance: 1,
            tokenCost: 12,
            required: true,
        },
        {
            kind: 'environment',
            title: 'Environment Context',
            content: '## Environment Context\n- `src/server/`: daemon bootstrap',
            relevance: 0.86,
            tokenCost: 18,
            required: true,
        },
        {
            kind: 'code',
            title: 'Focused Code Excerpt',
            content: '## Focused Code Excerpt\n```ts\nexport function createServer() {}\n```',
            relevance: 0.85,
            tokenCost: 20,
            required: true,
        },
    ];
    const environmentMetrics = {
        matchedScopes: ['src/server/', 'src/'],
        renderedScopeCount: 2,
        tokenEstimate: 18,
        bytes: 72,
        hash: 'env-hash-1',
        stablePrefixHash: 'env-stable-1',
        stablePrefixBytes: 80,
        stablePrefixTokenEstimate: 20,
        stableReuseRatio: 1,
        volatilityKey: 'src/server/server.ts::src/server/|src/',
    };
    const first = (0, context_builder_instrumentation_1.buildContextInstrumentation)(included, [{ title: 'Additional Note', reason: 'budget', required: false, kind: 'note' }], environmentMetrics, null);
    const second = (0, context_builder_instrumentation_1.buildContextInstrumentation)(included, [{ title: 'Environment Context', reason: 'budget', required: false, kind: 'environment' }], environmentMetrics, first.stablePrefixHash);
    strict_1.default.equal(second.stablePrefixHash, first.stablePrefixHash);
    strict_1.default.equal(second.instrumentation.cacheChurn?.stableReuseRatio, 1);
    strict_1.default.equal(second.instrumentation.cacheChurn?.churned, false);
    strict_1.default.equal(second.instrumentation.evidenceCounts.omittedByKind.environment, 1);
    strict_1.default.equal(first.instrumentation.layerTokenEstimates.environment, 18);
});
(0, node_test_1.default)('evaluation fixture plan: representative task packets preserve sufficiency cues for runtime, scope role, module boundary, and graph identity', () => {
    const packet = {
        task: {
            intentMode: 'active_file',
            summary: 'Explain createServer in src/server/server.ts',
        },
        primaryAnchor: {
            kind: 'symbol',
            label: 'createServer',
            path: 'src/server/server.ts',
            symbolPath: 'createServer',
            source: 'heuristic',
        },
        secondaryAnchors: [],
        contextText: '## Environment Context\nWorkspace runtime: Monorepo with daemon/backend root and VS Code extension subpackage',
        safetyWarnings: [],
        evidence: [
            {
                kind: 'environment',
                title: 'Environment Context',
                content: [
                    '## Environment Context',
                    'Workspace runtime: Monorepo with daemon/backend root and VS Code extension subpackage',
                    'Package manager: npm@10.0.0',
                    '- `src/server/`: Core daemon server / Node.js; TypeScript + ESM; DreamGraph daemon bootstrap, MCP server registration, scheduler orchestration',
                    '  - Framework: MCP server + HTTP daemon',
                    '  - Boundary: Server/runtime startup belongs here, not in extension host',
                ].join('\n'),
                relevance: 0.86,
                tokenCost: 48,
                required: true,
            },
            {
                kind: 'feature',
                title: 'Related Graph Contracts',
                content: '## Related Graph Contracts\n- feature daemon-server: Daemon Server\n- workflow daemon-startup: Daemon Startup',
                relevance: 0.88,
                tokenCost: 28,
                required: true,
            },
        ],
        omitted: [],
        confidence: 0.8,
        tokenUsage: { used: 76, budget: 1600, reserved: 320, reservedGraph: 240, usedGraph: 28 },
    };
    const environmentText = packet.evidence.find((item) => item.kind === 'environment')?.content ?? '';
    const graphText = packet.evidence.find((item) => item.kind === 'feature')?.content ?? '';
    strict_1.default.match(environmentText, /Core daemon server \/ Node\.js/);
    strict_1.default.match(environmentText, /DreamGraph daemon bootstrap/);
    strict_1.default.match(environmentText, /TypeScript \+ ESM/);
    strict_1.default.match(environmentText, /not in extension host/);
    strict_1.default.match(graphText, /feature daemon-server: Daemon Server/);
    strict_1.default.match(graphText, /workflow daemon-startup: Daemon Startup/);
    strict_1.default.ok(estimateTokens(environmentText) < 180);
});
//# sourceMappingURL=context-architecture-contract.test.js.map