"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.minifyToolDefinitions = minifyToolDefinitions;
exports.applySharedRequestCompaction = applySharedRequestCompaction;
exports.compactMessagesForProvider = compactMessagesForProvider;
exports.compactRawMessagesForProvider = compactRawMessagesForProvider;
exports.compactSystemPrompt = compactSystemPrompt;
exports.compactAssistantText = compactAssistantText;
exports.compactToolResultContent = compactToolResultContent;
const TOOL_RESULT_MAX_CHARS = 12_000;
const TOOL_RESULT_STRUCTURED_ITEMS = 5;
const TOOL_RESULT_RAW_PREVIEW_CHARS = 240;
const SYSTEM_PROMPT_MAX_CHARS = 5000;
const SOFT_BUDGET_TARGET_TOKENS = 16_000;
const SOFT_BUDGET_STRETCH_TOKENS = 22_000;
const TOOL_RESULT_BUDGET_FRACTION = 0.14;
const ASSISTANT_BUDGET_FRACTION = 0.18;
const SYSTEM_BUDGET_FRACTION = 0.32;
const CONTEXT_BUDGET_FRACTION = 0.12;
const MIN_SECTION_CHARS = 600;
const ASSISTANT_SECTION_LABELS = [
    "summary",
    "decision",
    "decisions",
    "remaining issues",
    "unresolved",
    "next step",
    "recommended next step",
    "findings",
];
function minifyToolDefinitions(tools) {
    return tools.map((tool) => ({
        ...tool,
        description: compactToolDescription(tool.description),
        inputSchema: minifyToolSchema(tool.inputSchema),
    }));
}
function applySharedRequestCompaction(input) {
    const bestQuality = shapeCompactionLevel(input, 0);
    const estimatedTokens = estimateRequestTokens(bestQuality);
    if (estimatedTokens <= SOFT_BUDGET_TARGET_TOKENS) {
        return {
            ...bestQuality,
            budget: {
                level: 0,
                targetTokens: SOFT_BUDGET_TARGET_TOKENS,
                estimatedTokens,
                overflowAccepted: false,
                reason: "within_target",
            },
        };
    }
    let candidate = bestQuality;
    let candidateTokens = estimatedTokens;
    for (const level of [1, 2, 3]) {
        candidate = shapeCompactionLevel(input, level);
        candidateTokens = estimateRequestTokens(candidate);
        if (candidateTokens <= SOFT_BUDGET_TARGET_TOKENS) {
            return {
                ...candidate,
                budget: {
                    level,
                    targetTokens: SOFT_BUDGET_TARGET_TOKENS,
                    estimatedTokens: candidateTokens,
                    overflowAccepted: false,
                    reason: `fit_after_level_${level}`,
                },
            };
        }
    }
    return {
        ...candidate,
        budget: {
            level: 3,
            targetTokens: SOFT_BUDGET_TARGET_TOKENS,
            estimatedTokens: candidateTokens,
            overflowAccepted: true,
            reason: candidateTokens <= SOFT_BUDGET_STRETCH_TOKENS ? "quality_preserving_overflow" : "above_stretch_budget",
        },
    };
}
function compactMessagesForProvider(messages, _provider, level = 1) {
    return messages.map((message) => {
        if (message.role === "assistant" && typeof message.content === "string") {
            return { ...message, content: compactAssistantText(message.content, level) };
        }
        if (message.role === "system" && typeof message.content === "string") {
            return { ...message, content: compactSystemPrompt(message.content, level) };
        }
        return message;
    });
}
function compactRawMessagesForProvider(raw, _provider, level = 1) {
    return raw.map((message) => {
        if (!isRecord(message)) {
            return message;
        }
        const role = typeof message.role === "string" ? message.role : "";
        const content = message.content;
        if (typeof content === "string") {
            if (role === "assistant") {
                return { ...message, content: compactAssistantText(content, level) };
            }
            if (role === "system") {
                return { ...message, content: compactSystemPrompt(content, level) };
            }
            return message;
        }
        if (!Array.isArray(content)) {
            return message;
        }
        if (role === "assistant") {
            const nextContent = content.map((block) => {
                if (!isRecord(block)) {
                    return block;
                }
                if (block.type === "text" && typeof block.text === "string") {
                    return { ...block, text: compactAssistantText(block.text, level) };
                }
                return block;
            });
            return { ...message, content: nextContent };
        }
        if (role === "user") {
            const nextContent = content.map((block) => {
                if (!isRecord(block)) {
                    return block;
                }
                if (block.type === "tool_result") {
                    return {
                        ...block,
                        content: compactToolResultContent(block.content, level),
                    };
                }
                return block;
            });
            return { ...message, content: nextContent };
        }
        return message;
    });
}
function compactSystemPrompt(system, level = 1) {
    const normalized = normalizeWhitespace(system);
    const maxChars = budgetCharsForLevel(SYSTEM_PROMPT_MAX_CHARS, SYSTEM_BUDGET_FRACTION, level);
    if (normalized.length <= maxChars) {
        return normalized;
    }
    const sections = extractMarkdownSections(normalized, [
        "identity",
        "constraint hierarchy",
        "tool preference hierarchy",
        "build verification",
        "knowledge graph sync policy",
        "uncertainty policy",
        "output policy",
        "task",
        "context",
        "reporting contract",
        "autonomy contract",
        "structured continuation contract",
    ]);
    const compact = joinWithinLimit(sections, maxChars);
    return compact.length > 0 ? compact : truncateWithEllipsis(normalized, maxChars);
}
function compactAssistantText(text, level = 1) {
    const normalized = normalizeWhitespace(text);
    const maxChars = budgetCharsForLevel(TOOL_RESULT_MAX_CHARS, ASSISTANT_BUDGET_FRACTION, level);
    if (normalized.length <= maxChars) {
        return normalized;
    }
    const sections = extractLabeledSections(normalized, ASSISTANT_SECTION_LABELS);
    if (sections.length > 0) {
        const compact = joinWithinLimit(sections, maxChars);
        if (compact.length > 0) {
            return compact;
        }
    }
    return truncateWithEllipsis(normalized, maxChars);
}
function compactToolResultContent(content, _level = 1) {
    // Per the never-fail philosophy: tool results are sacred. Never summarize
    // them regardless of compaction level — the LLM must see exactly what the
    // tool returned. Compaction may still tighten system prompts, assistant
    // text, and older history (handled elsewhere), but a fresh tool_result is
    // the ground truth the model is reasoning over and is passed through verbatim.
    return normalizeWhitespace(typeof content === "string" ? content : safeJsonStringify(content));
}
function minifyToolSchema(schema) {
    if (Array.isArray(schema)) {
        return schema.map((item) => minifyToolSchema(item));
    }
    if (!isRecord(schema)) {
        return schema;
    }
    const out = {};
    for (const [key, value] of Object.entries(schema)) {
        if (value === undefined) {
            continue;
        }
        if (key === "description" || key === "$comment" || key === "examples" || key === "default") {
            continue;
        }
        out[key] = minifyToolSchema(value);
    }
    return out;
}
function compactToolDescription(description) {
    return truncateWithEllipsis(normalizeWhitespace(description), 240);
}
function summarizeStructuredValue(value, depth, level) {
    if (depth > 3) {
        return { summary: [], entities: [] };
    }
    const structuredItems = Math.max(2, TOOL_RESULT_STRUCTURED_ITEMS - level);
    if (Array.isArray(value)) {
        const summary = [`- items: ${value.length}`];
        const entities = value
            .slice(0, structuredItems)
            .map((item) => extractEntityLabel(item))
            .filter((item) => Boolean(item));
        return { summary, entities: dedupe(entities).slice(0, structuredItems) };
    }
    if (!isRecord(value)) {
        return { summary: [], entities: [] };
    }
    const summary = [];
    const entities = [];
    for (const [key, entry] of Object.entries(value).slice(0, structuredItems)) {
        if (Array.isArray(entry)) {
            summary.push(`- ${key}: ${entry.length}`);
            for (const item of entry.slice(0, structuredItems)) {
                const label = extractEntityLabel(item);
                if (label) {
                    entities.push(label);
                }
            }
            continue;
        }
        if (isRecord(entry)) {
            const label = extractEntityLabel(entry);
            summary.push(`- ${key}: object`);
            if (label) {
                entities.push(label);
            }
            continue;
        }
        if (typeof entry === "string" || typeof entry === "number" || typeof entry === "boolean") {
            summary.push(`- ${key}: ${String(entry)}`);
        }
    }
    return {
        summary: summary.slice(0, structuredItems),
        entities: dedupe(entities).slice(0, structuredItems),
    };
}
function extractEntityLabel(value) {
    if (!isRecord(value)) {
        return typeof value === "string" ? value : undefined;
    }
    const id = typeof value.id === "string" ? value.id : undefined;
    const name = typeof value.name === "string" ? value.name : undefined;
    const filePath = typeof value.filePath === "string" ? value.filePath : undefined;
    const path = typeof value.path === "string" ? value.path : undefined;
    if (id && name) {
        return `${id} (${name})`;
    }
    return id ?? name ?? filePath ?? path;
}
function extractLabeledSections(text, labels) {
    const matches = [];
    for (const label of labels) {
        const regex = new RegExp(`(^|\\n)${escapeRegex(label)}\\s*:`, "ig");
        let match;
        while ((match = regex.exec(text)) !== null) {
            matches.push({ index: match.index + (match[1]?.length ?? 0), label });
        }
    }
    matches.sort((a, b) => a.index - b.index);
    if (matches.length === 0) {
        return [];
    }
    const sections = [];
    for (let i = 0; i < matches.length; i += 1) {
        const start = matches[i].index;
        const end = i + 1 < matches.length ? matches[i + 1].index : text.length;
        const section = text.slice(start, end).trim();
        if (section.length > 0) {
            sections.push(section);
        }
    }
    return dedupe(sections);
}
function extractMarkdownSections(text, headings) {
    const lines = text.split(/\r?\n/);
    const wanted = new Set(headings.map((heading) => heading.toLowerCase()));
    const sections = [];
    let current = [];
    let capturing = false;
    for (const line of lines) {
        const headingMatch = /^(#+)\s+(.*)$/.exec(line.trim());
        if (headingMatch) {
            const title = headingMatch[2].trim().toLowerCase();
            if (capturing && current.length > 0) {
                sections.push(current.join("\n").trim());
                current = [];
            }
            capturing = wanted.has(title);
        }
        if (capturing) {
            current.push(line);
        }
    }
    if (capturing && current.length > 0) {
        sections.push(current.join("\n").trim());
    }
    return dedupe(sections);
}
function joinWithinLimit(parts, limit) {
    const out = [];
    let length = 0;
    for (const part of parts) {
        const addition = part.length + (out.length > 0 ? 2 : 0);
        if (length + addition > limit) {
            break;
        }
        out.push(part);
        length += addition;
    }
    return out.join("\n\n");
}
function shapeCompactionLevel(input, level) {
    return {
        system: input.system ? compactSystemPrompt(input.system, level) : undefined,
        messages: compactMessagesForProvider(input.messages, input.provider, level),
        rawMessages: input.rawMessages ? compactRawMessagesForProvider(input.rawMessages, input.provider, level) : undefined,
        tools: input.tools ? minifyToolDefinitions(input.tools) : undefined,
    };
}
function estimateRequestTokens(input) {
    const serialized = safeJsonStringify({
        system: input.system,
        messages: input.messages,
        rawMessages: input.rawMessages,
        tools: input.tools,
    });
    return Math.ceil(serialized.length / 4);
}
function budgetCharsForLevel(baseChars, fraction, level) {
    if (level === 0) {
        return baseChars;
    }
    const budgetChars = Math.floor((SOFT_BUDGET_TARGET_TOKENS * 4) * fraction);
    const tightened = Math.floor(budgetChars * (1 - ((level - 1) * 0.18)));
    return Math.max(MIN_SECTION_CHARS, Math.min(baseChars, tightened));
}
function normalizeWhitespace(text) {
    // NOTE: Do NOT collapse internal runs of spaces/tabs — that destroys source
    // code indentation when this helper is applied to tool results carrying file
    // contents. We only normalize line endings and excessive blank lines.
    return text.replace(/\r\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
}
function truncateWithEllipsis(text, limit) {
    if (text.length <= limit) {
        return text;
    }
    return `${text.slice(0, Math.max(0, limit - 1)).trimEnd()}…`;
}
function safeJsonStringify(value) {
    try {
        return JSON.stringify(value);
    }
    catch {
        return String(value ?? "");
    }
}
function dedupe(items) {
    return [...new Set(items.filter((item) => item.trim().length > 0))];
}
function escapeRegex(value) {
    return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
function isRecord(value) {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}
//# sourceMappingURL=request-compaction.js.map