"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.RESPONSES_RAW_ITEMS_KEY = void 0;
exports.usesOpenAIResponsesApi = usesOpenAIResponsesApi;
exports.buildOpenAIResponsesRequest = buildOpenAIResponsesRequest;
exports.toOpenAIResponsesContent = toOpenAIResponsesContent;
exports.extractOpenAIResponsesRawItems = extractOpenAIResponsesRawItems;
exports.translateRawToOpenAIResponses = translateRawToOpenAIResponses;
exports.extractOpenAIResponsesText = extractOpenAIResponsesText;
exports.extractOpenAIResponsesToolCalls = extractOpenAIResponsesToolCalls;
const request_compaction_1 = require("./request-compaction");
function usesOpenAIResponsesApi(model) {
    return model.trim().toLowerCase().startsWith("gpt-5.5");
}
function buildOpenAIResponsesRequest(messages, options) {
    const compactedMessages = (0, request_compaction_1.compactMessagesForProvider)(messages, "openai");
    const compactedRawMessages = options.rawMessages
        ? (0, request_compaction_1.compactRawMessagesForProvider)(options.rawMessages, "openai")
        : undefined;
    const compactedTools = options.tools ? (0, request_compaction_1.minifyToolDefinitions)(options.tools) : undefined;
    const body = {
        model: options.model,
        max_output_tokens: 16384,
        input: compactedRawMessages
            ? translateRawToOpenAIResponses(compactedRawMessages)
            : compactedMessages.map((m) => ({ role: m.role, content: toOpenAIResponsesContent(m.content) })),
        reasoning: { effort: options.reasoningEffort },
        text: { verbosity: options.textVerbosity },
        // Stateless multi-turn tool loops on gpt-5.5/o-series require these:
        //   * store=false: opt out of server-side state retention (we replay).
        //   * include reasoning.encrypted_content: the only way to get the
        //     opaque reasoning blob needed to echo prior `reasoning` items back
        //     on the next turn so the model doesn't re-plan from scratch.
        //   * parallel_tool_calls=false: reasoning models occasionally emit
        //     malformed parallel calls when iterating over many small tools;
        //     serial calls eliminate that failure mode.
        store: false,
        include: ["reasoning.encrypted_content"],
        parallel_tool_calls: false,
    };
    if (compactedTools?.length) {
        body.tools = compactedTools.map((t) => ({
            type: "function",
            name: t.name,
            description: t.description,
            parameters: t.inputSchema,
        }));
    }
    return body;
}
function toOpenAIResponsesContent(content) {
    if (typeof content === "string") {
        return content;
    }
    if (!Array.isArray(content)) {
        return "";
    }
    const blocks = [];
    for (const block of content) {
        if (!isRecord(block)) {
            continue;
        }
        if (block.type === "text" && typeof block.text === "string") {
            blocks.push({ type: "input_text", text: block.text });
            continue;
        }
        if (block.type === "image") {
            const image = toInputImageBlock(block);
            if (image) {
                blocks.push(image);
            }
        }
    }
    return blocks;
}
/** Marker key used by chat-panel to store the verbatim Responses output[]
 * items for an assistant turn (including `reasoning` items). When present,
 * `translateRawToOpenAIResponses` emits these items 1:1 instead of trying to
 * synthesize them from Anthropic-shaped blocks — preserving the encrypted
 * reasoning blob across the next turn. */
exports.RESPONSES_RAW_ITEMS_KEY = "__responsesItems";
function extractOpenAIResponsesRawItems(data) {
    return Array.isArray(data.output) ? data.output : [];
}
function translateRawToOpenAIResponses(raw) {
    const out = [];
    for (const msg of raw) {
        if (!isRecord(msg)) {
            continue;
        }
        // Fast path: a previously captured Responses-API assistant turn. Emit its
        // output[] items verbatim so reasoning replay keeps gpt-5.5 stateful
        // across tool round-trips without server-side `previous_response_id`.
        const stored = msg[exports.RESPONSES_RAW_ITEMS_KEY];
        if (msg.role === "assistant" && Array.isArray(stored)) {
            for (const item of stored) {
                if (isRecord(item)) {
                    out.push(item);
                }
            }
            continue;
        }
        const role = typeof msg.role === "string" ? msg.role : "";
        const content = msg.content;
        if (typeof content === "string") {
            if (role === "system" || role === "user" || role === "assistant") {
                out.push({ role, content });
            }
            continue;
        }
        if (!Array.isArray(content)) {
            continue;
        }
        const blocks = content.filter(isRecord);
        if (role === "assistant") {
            const textParts = blocks
                .filter((b) => b.type === "text" && typeof b.text === "string")
                .map((b) => b.text);
            if (textParts.length > 0) {
                out.push({ role: "assistant", content: (0, request_compaction_1.compactAssistantText)(textParts.join("")) });
            }
            for (const block of blocks) {
                if (block.type !== "tool_use") {
                    continue;
                }
                if (typeof block.id !== "string" || block.id.length === 0) {
                    continue;
                }
                if (typeof block.name !== "string" || block.name.length === 0) {
                    continue;
                }
                out.push({
                    type: "function_call",
                    call_id: block.id,
                    name: block.name,
                    arguments: typeof block.input === "string" ? block.input : JSON.stringify(block.input ?? {}),
                });
            }
            continue;
        }
        if (role === "user") {
            const contentBlocks = [];
            for (const block of blocks) {
                if (block.type === "tool_result") {
                    continue;
                }
                if (block.type === "text" && typeof block.text === "string") {
                    contentBlocks.push({ type: "input_text", text: block.text });
                    continue;
                }
                if (block.type === "image") {
                    const image = toInputImageBlock(block);
                    if (image) {
                        contentBlocks.push(image);
                    }
                }
            }
            if (contentBlocks.length > 0) {
                out.push({ role: "user", content: contentBlocks });
            }
            for (const tr of blocks) {
                if (tr.type !== "tool_result") {
                    continue;
                }
                if (typeof tr.tool_use_id !== "string" || tr.tool_use_id.length === 0) {
                    continue;
                }
                out.push({
                    type: "function_call_output",
                    call_id: tr.tool_use_id,
                    // Tool-result content has already been compacted upstream by
                    // applySharedRequestCompaction at the budget-chosen level. Re-running
                    // compactToolResultContent here at the default level 1 would
                    // double-compact and destroy file contents that fit cleanly under the
                    // 16k soft budget. Pass through verbatim; stringify only if needed.
                    output: typeof tr.content === "string" ? tr.content : JSON.stringify(tr.content),
                });
            }
        }
    }
    return out;
}
function extractOpenAIResponsesText(data) {
    if (typeof data.output_text === "string" && data.output_text.length > 0) {
        return data.output_text;
    }
    // Collect text in two granularities:
    //   - within a single message item, sub-blocks are streamed chunks of the
    //     same paragraph and are concatenated tightly (no separator).
    //   - between top-level items (message / text), insert a paragraph break
    //     when neither boundary already provides whitespace, so verbose-mode
    //     responses don't run sentences together
    //     ("...stale references.Autonomy counters: steps=54...").
    const groups = [];
    for (const item of data.output ?? []) {
        if (!isRecord(item)) {
            continue;
        }
        if (item.type === "message" && Array.isArray(item.content)) {
            const blocks = [];
            for (const block of item.content) {
                if (!isRecord(block)) {
                    continue;
                }
                if ((block.type === "output_text" || block.type === "text") && typeof block.text === "string") {
                    blocks.push(block.text);
                }
            }
            if (blocks.length > 0) {
                groups.push(blocks.join(""));
            }
            continue;
        }
        if ((item.type === "output_text" || item.type === "text") && typeof item.text === "string") {
            groups.push(item.text);
        }
    }
    let out = "";
    for (const group of groups) {
        if (out.length === 0) {
            out = group;
            continue;
        }
        const prevEndsWS = /\s$/.test(out);
        const nextStartsWS = /^\s/.test(group);
        const prevEndsInline = /[,:;([{\-–—]$/.test(out);
        const nextStartsInline = /^[)\]}.!?,:;\-–—]/.test(group);
        const nextLooksLikeCounter = /^(Autonomy counters:|steps=\d+\b|writes=\d+\b|stalls=\d+\b)/.test(group);
        const prevEndsSentence = /[.!?]["')\]]?$/.test(out);
        const shouldParagraphBreak = !(prevEndsWS || nextStartsWS || prevEndsInline || nextStartsInline)
            && (prevEndsSentence || nextLooksLikeCounter);
        out += shouldParagraphBreak ? `\n\n${group}` : group;
    }
    return out;
}
function extractOpenAIResponsesToolCalls(data) {
    const toolCalls = [];
    for (const item of data.output ?? []) {
        if (!isRecord(item) || item.type !== "function_call") {
            continue;
        }
        if (typeof item.name !== "string" || item.name.length === 0) {
            continue;
        }
        const id = typeof item.call_id === "string" && item.call_id.length > 0
            ? item.call_id
            : typeof item.id === "string" && item.id.length > 0
                ? item.id
                : "";
        if (!id) {
            continue;
        }
        const rawArguments = typeof item.arguments === "string" ? item.arguments : "{}";
        let input = {};
        try {
            const parsed = JSON.parse(rawArguments);
            input = isRecord(parsed) ? parsed : { arguments: parsed };
        }
        catch {
            input = { arguments: rawArguments };
        }
        toolCalls.push({ id, name: item.name, input });
    }
    return toolCalls;
}
function toInputImageBlock(block) {
    const source = isRecord(block.source) ? block.source : undefined;
    if (source && source.type === "base64" && typeof source.media_type === "string" && typeof source.data === "string") {
        return {
            type: "input_image",
            image_url: `data:${source.media_type};base64,${source.data}`,
        };
    }
    if (typeof block.mimeType === "string" && typeof block.dataBase64 === "string") {
        return {
            type: "input_image",
            image_url: `data:${block.mimeType};base64,${block.dataBase64}`,
        };
    }
    return undefined;
}
function isRecord(value) {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}
//# sourceMappingURL=openai-responses-adapter.js.map