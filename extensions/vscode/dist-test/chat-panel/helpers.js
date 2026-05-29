"use strict";
/**
 * Pure helper functions extracted from chat-panel.ts.
 *
 * These are stateless utilities — no `this`, no I/O, no side effects beyond
 * what their inputs declare. Kept here so chat-panel.ts can stay focused on
 * webview lifecycle, streaming orchestration, and message persistence, and so
 * the helpers can be unit-tested directly without instantiating ChatPanel.
 *
 * Part of F-06 sub-batch 3b/3 (chat-panel.ts split). See
 * plans/SYSTEM_FINDINGS.md for the rationale and scope.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.TOOL_TIMEOUT_MS = exports.SECRET_PATTERNS = exports.MAX_ENTITY_LINKS_PER_MESSAGE = exports.MAX_RENDERED_MESSAGE_CHARS = void 0;
exports.summarizeToolArgs = summarizeToolArgs;
exports.stringifyToolResult = stringifyToolResult;
exports.safeStringifyForOutcome = safeStringifyForOutcome;
exports.summarizeOutcomePayload = summarizeOutcomePayload;
exports.deriveVerdict = deriveVerdict;
exports.extractFilesAffected = extractFilesAffected;
exports.detectImplicitEntities = detectImplicitEntities;
exports.formatImplicitEntityNotice = formatImplicitEntityNotice;
exports.redactSecrets = redactSecrets;
exports.stripStructuredEnvelope = stripStructuredEnvelope;
exports.formatStopContextBlock = formatStopContextBlock;
exports.formatAnchorFooterStatus = formatAnchorFooterStatus;
exports.createMessageId = createMessageId;
exports.applyRenderLimits = applyRenderLimits;
exports.toolTimeoutMs = toolTimeoutMs;
// ---------- Constants ----------
exports.MAX_RENDERED_MESSAGE_CHARS = 100_000;
exports.MAX_ENTITY_LINKS_PER_MESSAGE = 100;
/** Patterns used to redact secrets from any model-visible text or chunk. */
exports.SECRET_PATTERNS = [
    /(?:api[_-]?key|secret|token|password|passwd|auth)\s*[:=]\s*\S+/gi,
    /(?:sk-|pk-|ghp_|gho_|github_pat_)\S+/g,
    /-----BEGIN (?:RSA |EC )?PRIVATE KEY-----[\s\S]*?-----END/g,
];
// ---------- Pure helpers ----------
function summarizeToolArgs(input) {
    if (!input || typeof input !== 'object')
        return 'no args';
    const keys = Object.keys(input).slice(0, 4);
    return keys.length > 0 ? keys.join(', ') : 'no args';
}
function stringifyToolResult(result) {
    if (typeof result === 'string') {
        return result;
    }
    if (result === undefined) {
        return 'undefined';
    }
    try {
        return JSON.stringify(result, null, 2);
    }
    catch {
        return String(result);
    }
}
/**
 * Patch #1 (renderer invariant): payload-safe stringifier for OutcomeCards.
 * Same shape as stringifyToolResult but with a hard length ceiling so a
 * runaway tool result cannot blow past the chat render limit. The full
 * payload is still recoverable via the underlying tool trace.
 */
const OUTCOME_PAYLOAD_MAX_CHARS = 8_000;
function safeStringifyForOutcome(result) {
    const raw = stringifyToolResult(result);
    if (raw.length <= OUTCOME_PAYLOAD_MAX_CHARS)
        return raw;
    const head = raw.slice(0, OUTCOME_PAYLOAD_MAX_CHARS);
    return `${head}\n\n[... ${(raw.length - OUTCOME_PAYLOAD_MAX_CHARS).toLocaleString()} chars omitted from outcome payload ...]`;
}
/**
 * Derive a one-line summary for an OutcomeCard subtitle. Prefers a top-level
 * `summary`/`message`/`status` field on the parsed payload, falls back to a
 * single-line snippet of the payload text. Always returns at most 200 chars
 * with no embedded newlines so it is safe to splat onto the fence header.
 */
function summarizeOutcomePayload(payloadText) {
    if (!payloadText)
        return '';
    // Try to pull a structured summary out of a JSON payload.
    const trimmed = payloadText.trim();
    if (trimmed.startsWith('{')) {
        try {
            const parsed = JSON.parse(trimmed);
            for (const key of ['summary', 'message', 'status', 'description']) {
                const v = parsed[key];
                if (typeof v === 'string' && v.trim()) {
                    return v.replace(/\s+/g, ' ').trim().slice(0, 200);
                }
            }
        }
        catch {
            // not JSON — fall through to text snippet
        }
    }
    const firstLine = trimmed.split(/\r?\n/, 1)[0] ?? '';
    return firstLine.replace(/\s+/g, ' ').trim().slice(0, 200);
}
function deriveVerdict(content, trace) {
    const normalized = (content ?? '').toLowerCase();
    // Count effective failures only: when the same (tool, argsSummary,
    // filesAffected) was retried and the LATEST attempt completed, the
    // earlier failure no longer counts against the verdict. This avoids
    // marking a turn "partial" when, e.g., `dreamgraph:run_command`
    // failed once with a bad flag and then succeeded on the corrected
    // retry — the user-visible outcome was success.
    const latestStatusByKey = new Map();
    for (const t of trace) {
        const key = `${t.tool}\u0000${t.argsSummary}\u0000${t.filesAffected.join('|')}`;
        latestStatusByKey.set(key, t.status);
    }
    let failedCount = 0;
    for (const status of latestStatusByKey.values()) {
        if (status === 'failed')
            failedCount++;
    }
    const goalStatusMatch = normalized.match(/["']?goal_status["']?\s*:\s*["']?(complete|partial|blocked)\b/);
    const goalStatus = goalStatusMatch?.[1];
    const terminalIncomplete = /\bpass aborted\b|\brequest failed before completion\b|\bcodex cli run was cancelled\b|\bwas cancelled by the host\b|\bcancelled by the host\b|\bcanceled by the host\b|\bdid not complete\b|\bdid not proceed\b|\bnot completed successfully\b|\bremains incomplete\b|\bassessment remains incomplete\b|\bprogress has stalled\b|\bstopped: progress has stalled\b|\byou've hit your usage limit\b|\busage limit\b|\brate limit\b|\bunsupported model\b|\bblocked by policy\b|\bcould not generate wrap-up summary\b|\btool call failed\b/.test(normalized);
    const explicitCompletion = /(?:^|\s)(?:verified:|confirmed:)|\bdone and verified\b|\bcompleted successfully\b|\bgoal sufficiently reached\b|\bready for commit\b/.test(normalized);
    if (goalStatus === 'partial' || goalStatus === 'blocked' || terminalIncomplete) {
        return {
            level: 'partial',
            summary: failedCount > 0
                ? `Partial confidence: ${failedCount} tool call${failedCount === 1 ? '' : 's'} failed during evidence gathering.`
                : trace.length > 0
                    ? `Partial progress: ${trace.length} executed tool call${trace.length === 1 ? '' : 's'}, but final completion was not established.`
                    : 'Partial confidence: the response did not complete the requested outcome.',
        };
    }
    if (goalStatus === 'complete' || explicitCompletion) {
        if (failedCount > 0) {
            return {
                level: 'partial',
                summary: `Partial confidence: ${failedCount} tool call${failedCount === 1 ? '' : 's'} failed during evidence gathering.`,
            };
        }
        return {
            level: 'verified',
            summary: trace.length > 0
                ? `Verified with ${trace.length} executed tool call${trace.length === 1 ? '' : 's'}.`
                : 'Verified based on explicit evidence in the response.',
        };
    }
    if (failedCount > 0 || trace.length > 0 || normalized.includes('likely') || normalized.includes('partial')) {
        return {
            level: 'partial',
            summary: failedCount > 0
                ? `Partial confidence: ${failedCount} tool call${failedCount === 1 ? '' : 's'} failed during evidence gathering.`
                : trace.length > 0
                    ? `Partial progress: ${trace.length} executed tool call${trace.length === 1 ? '' : 's'}, but final completion was not established.`
                    : 'Partial confidence: the response includes uncertainty or incomplete evidence.',
        };
    }
    return {
        level: 'speculative',
        summary: 'Speculative synthesis: no strong verification signals were detected.',
    };
}
/**
 * Extract file paths referenced by tool inputs (or, if none, results).
 *
 * Two-arity signature kept compatible with the previous private method:
 * `extractFilesAffected(input, result?)` or
 * `extractFilesAffected(toolName, input, result?)` (toolName is ignored).
 */
function extractFilesAffected(toolNameOrInput, inputOrResult, maybeResult) {
    const input = typeof toolNameOrInput === 'string' ? inputOrResult : toolNameOrInput;
    const result = typeof toolNameOrInput === 'string'
        ? (maybeResult ?? '')
        : (typeof inputOrResult === 'string' ? inputOrResult : '');
    const found = new Set();
    const visit = (value) => {
        if (typeof value === 'string') {
            if (/^[A-Za-z]:\\|^\.|^src\/|^extensions\//.test(value) || /\.(ts|tsx|js|jsx|json|md|css|html)$/i.test(value)) {
                found.add(value);
            }
            return;
        }
        if (Array.isArray(value)) {
            value.forEach(visit);
            return;
        }
        if (value && typeof value === 'object') {
            Object.values(value).forEach(visit);
        }
    };
    visit(input);
    if (found.size === 0)
        visit(result);
    return Array.from(found).slice(0, 5);
}
function detectImplicitEntities(content, maxLinks = exports.MAX_ENTITY_LINKS_PER_MESSAGE) {
    const explicitUris = new Set(Array.from(content.matchAll(/\b[a-z-]+:\/\/([A-Za-z0-9._/-]+)/g)).map((match) => match[1]));
    const candidates = Array.from(content.matchAll(/\b(?:feature|workflow|ADR|tension|entity|data model)\s+([A-Z][A-Za-z0-9._-]{1,80})\b/g))
        .map((match) => match[1])
        .filter((name) => !explicitUris.has(name));
    const deduped = Array.from(new Set(candidates));
    return {
        names: deduped.slice(0, maxLinks),
        truncated: deduped.length > maxLinks,
    };
}
function formatImplicitEntityNotice(result) {
    if (result.names.length === 0) {
        return '';
    }
    const prefix = 'Implicit entity references detected: ';
    const body = result.names.join(', ');
    const suffix = result.truncated ? ' … [Entity link cap reached]' : '';
    return `${prefix}${body}${suffix}`;
}
function redactSecrets(content) {
    return exports.SECRET_PATTERNS.reduce((text, pattern) => text.replace(pattern, (match) => {
        const sepMatch = match.match(/[:=]\s*/);
        if (sepMatch && typeof sepMatch.index === 'number') {
            return match.slice(0, sepMatch.index + sepMatch[0].length) + '****';
        }
        return match.slice(0, 8) + '****';
    }), content);
}
/**
 * Strip the structured autonomy envelope (a ```json``` fenced block containing
 * `goal_status`) so it never renders in chat. The envelope is consumed by the
 * autonomy loop instead.
 */
function stripStructuredEnvelope(content) {
    return content
        .replace(/```json[\r\n][\s\S]*?"goal_status"[\s\S]*?```/g, '')
        .replace(/\n{3,}/g, '\n\n')
        .trim();
}
/**
 * Format a stop-context block for injection into the next turn's system
 * prompt, so that "resume" re-enters from a known task position rather than
 * starting fresh.
 */
function formatStopContextBlock(ctx) {
    const lines = ['## Task Continuation Context'];
    lines.push('The previous autonomy pass stopped. The following context describes where the task left off.');
    if (ctx.summary) {
        lines.push(`\n**Last progress summary:** ${ctx.summary}`);
    }
    if (ctx.nextSteps.length > 0) {
        lines.push('\n**Recommended next steps when resuming:**');
        for (const step of ctx.nextSteps) {
            lines.push(`- ${step.label}${step.rationale ? ` — ${step.rationale}` : ''}`);
        }
    }
    lines.push('\nIf the user says "resume", "continue", or similar, re-enter the task from the above context rather than starting fresh.');
    return lines.join('\n');
}
function formatAnchorFooterStatus(anchor) {
    const status = anchor.migrationStatus ?? 'native';
    const label = anchor.canonicalId
        ? `${anchor.canonicalKind ?? 'entity'}:${anchor.canonicalId}`
        : anchor.symbolPath ?? anchor.label;
    // Embed a sentinel token that renderContextFooter() in the webview will
    // parse into a styled badge. Format: [anchor-status:STATE:LABEL].
    const sentinel = `[anchor-status:${status}:${label ?? ''}]`;
    switch (status) {
        case 'promoted':
            return `Anchor: promoted to ${label} ${sentinel}`;
        case 'rebound':
            return `Anchor: rebound to ${label} ${sentinel}`;
        case 'drifted':
            return `Anchor: drifted near ${label} ${sentinel}`;
        case 'archived':
            return `Anchor: archived (${label}) ${sentinel}`;
        case 'native':
        default:
            return anchor.canonicalId
                ? `Anchor: canonical ${label} ${sentinel}`
                : `Anchor: native ${label} ${sentinel}`;
    }
}
// ---------- Render-output utilities ----------
function createMessageId() {
    return `msg_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}
function applyRenderLimits(content, maxChars = exports.MAX_RENDERED_MESSAGE_CHARS) {
    if (content.length <= maxChars) {
        return { content, truncated: false };
    }
    const clipped = content.slice(0, maxChars);
    return {
        content: `${clipped}\n\n[Response truncated]`,
        truncated: true,
    };
}
// ---------- Tool result handling ----------
// Phase 4 of NEVER_FAIL_BUDGET_DEBT_PLAN — the legacy `truncateToolResult`
// hard char cap and `dreamgraph.architect.maxToolResultChars` setting were
// removed. Tool-result trimming now lives in `tool-result-compression.ts`
// where it is driven by the per-turn `BudgetCoordinator`.
// ---------- Per-tool timeout table ----------
/** Per-tool MCP-call timeouts (ms). Tools not listed use _default. */
exports.TOOL_TIMEOUT_MS = {
    dream_cycle: 120_000,
    nightmare_cycle: 120_000,
    metacognitive_analysis: 120_000,
    run_command: 60_000,
    write_file: 30_000,
    edit_file: 30_000,
    patch_file: 30_000,
    edit_markdown_section: 30_000,
    patch_markdown_chapter: 30_000,
    list_markdown_chapters: 15_000,
    read_markdown_chapter: 30_000,
    append_to_file: 15_000,
    read_source_code: 30_000,
    read_local_file: 30_000,
    search_source_code: 45_000,
    _default: 60_000,
};
function toolTimeoutMs(toolName) {
    return exports.TOOL_TIMEOUT_MS[toolName] ?? exports.TOOL_TIMEOUT_MS._default;
}
//# sourceMappingURL=helpers.js.map