"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const node_test_1 = __importDefault(require("node:test"));
const strict_1 = __importDefault(require("node:assert/strict"));
const node_fs_1 = __importDefault(require("node:fs"));
const node_os_1 = __importDefault(require("node:os"));
const node_path_1 = __importDefault(require("node:path"));
const environment_context_1 = require("../environment-context");
async function withTempWorkspace(setup, run) {
    const root = node_fs_1.default.mkdtempSync(node_path_1.default.join(node_os_1.default.tmpdir(), 'dg-envctx-'));
    try {
        await setup(root);
        await run(root);
    }
    finally {
        node_fs_1.default.rmSync(root, { recursive: true, force: true });
    }
}
function writeJson(target, value) {
    node_fs_1.default.mkdirSync(node_path_1.default.dirname(target), { recursive: true });
    node_fs_1.default.writeFileSync(target, JSON.stringify(value, null, 2), 'utf8');
}
(0, node_test_1.default)('environment context selects the most specific matching scope for a file', async () => {
    await withTempWorkspace((root) => {
        writeJson(node_path_1.default.join(root, 'package.json'), {
            type: 'module',
            packageManager: 'npm@10.0.0',
            dependencies: {
                '@modelcontextprotocol/sdk': '^1.27.1',
                express: '^5.1.0',
                zod: '^4.1.5',
                sqlite3: '^5.1.7',
                cheerio: '^1.2.0',
                turndown: '^7.2.4',
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
        node_fs_1.default.mkdirSync(node_path_1.default.join(root, 'src', 'tools'), { recursive: true });
        node_fs_1.default.mkdirSync(node_path_1.default.join(root, 'src', 'cognitive'), { recursive: true });
        node_fs_1.default.mkdirSync(node_path_1.default.join(root, 'extensions', 'vscode', 'src'), { recursive: true });
    }, async (root) => {
        const snapshot = await (0, environment_context_1.buildEnvironmentContextSnapshot)(root);
        strict_1.default.ok(snapshot);
        const serverEntries = (0, environment_context_1.selectEnvironmentContextForFile)(snapshot, 'src/server/server.ts');
        strict_1.default.equal(serverEntries.length, 2);
        strict_1.default.equal(serverEntries[0]?.scope, 'src/server/');
        strict_1.default.equal(serverEntries[1]?.scope, 'src/');
        strict_1.default.match(serverEntries[0]?.role ?? '', /daemon bootstrap/i);
        strict_1.default.deepStrictEqual(serverEntries[0]?.keyDependencies, ['@modelcontextprotocol/sdk', 'express']);
        const extensionEntries = (0, environment_context_1.selectEnvironmentContextForFile)(snapshot, 'extensions/vscode/src/chat-panel.ts');
        strict_1.default.equal(extensionEntries.length, 1);
        strict_1.default.equal(extensionEntries[0]?.scope, 'extensions/vscode/src/');
        strict_1.default.match(extensionEntries[0]?.framework ?? '', /VS Code Extension API/);
    });
});
(0, node_test_1.default)('environment context rendering is stable and bounded for a given file', async () => {
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
                commander: '^14.0.1',
                chalk: '^5.6.2',
                cheerio: '^1.2.0',
                turndown: '^7.2.4',
                jsdom: '^27.0.0',
                marked: '^16.3.0',
            },
        });
        node_fs_1.default.mkdirSync(node_path_1.default.join(root, 'src', 'tools'), { recursive: true });
        node_fs_1.default.mkdirSync(node_path_1.default.join(root, 'src'), { recursive: true });
    }, async (root) => {
        const snapshot = await (0, environment_context_1.buildEnvironmentContextSnapshot)(root);
        strict_1.default.ok(snapshot);
        const first = (0, environment_context_1.renderEnvironmentContextBlock)(snapshot, 'src/tools/web-senses.ts');
        const second = (0, environment_context_1.renderEnvironmentContextBlock)(snapshot, 'src/tools/web-senses.ts');
        strict_1.default.ok(first);
        strict_1.default.equal(first, second);
        strict_1.default.match(first ?? '', /^## Environment Context/m);
        strict_1.default.match(first ?? '', /Package manager: pnpm@9\.0\.0/);
        strict_1.default.match(first ?? '', /Scope `src\/tools\/`/);
        strict_1.default.match(first ?? '', /Scope `src\/`/);
        strict_1.default.doesNotMatch(first ?? '', /Scope `src\/cli\/`/);
        strict_1.default.ok((first ?? '').length < 1200, `expected compact environment block, got ${(first ?? '').length} chars`);
        strict_1.default.ok(Math.ceil((first ?? '').length / 4) < 320, 'expected environment block to stay under ~320 tokens');
    });
});
(0, node_test_1.default)('environment context excludes non-curated dependency noise', async () => {
    await withTempWorkspace((root) => {
        writeJson(node_path_1.default.join(root, 'package.json'), {
            type: 'module',
            dependencies: {
                '@modelcontextprotocol/sdk': '^1.27.1',
                cheerio: '^1.2.0',
                turndown: '^7.2.4',
                leftpad: '^1.0.0',
                lodash: '^4.17.21',
                axios: '^1.12.2',
                express: '^5.1.0',
            },
        });
        node_fs_1.default.mkdirSync(node_path_1.default.join(root, 'src', 'tools'), { recursive: true });
        node_fs_1.default.mkdirSync(node_path_1.default.join(root, 'src'), { recursive: true });
    }, async (root) => {
        const snapshot = await (0, environment_context_1.buildEnvironmentContextSnapshot)(root);
        strict_1.default.ok(snapshot);
        const block = (0, environment_context_1.renderEnvironmentContextBlock)(snapshot, 'src/tools/web-senses.ts');
        strict_1.default.ok(block);
        strict_1.default.match(block ?? '', /Key dependencies: @modelcontextprotocol\/sdk, cheerio, turndown/);
        strict_1.default.doesNotMatch(block ?? '', /leftpad/);
        strict_1.default.doesNotMatch(block ?? '', /lodash/);
        strict_1.default.doesNotMatch(block ?? '', /axios/);
    });
});
//# sourceMappingURL=environment-context.test.js.map