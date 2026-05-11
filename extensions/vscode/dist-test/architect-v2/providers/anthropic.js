"use strict";
// architect-v2/providers/anthropic.ts
// Slice 2 — Anthropic provider profile (static model list).
//
// STRICT ISOLATION (ADR-140): no import from v1.
// Default model + reasoning effort locked by ADR-150 (cloud defaults).
Object.defineProperty(exports, "__esModule", { value: true });
exports.anthropicProfile = void 0;
const anthropic_adapter_1 = require("./transports/anthropic-adapter");
const ANTHROPIC_MODELS = [
    {
        id: "claude-opus-4-7",
        displayName: "Claude Opus 4.7",
        contextWindow: 200_000,
        capabilities: {
            api: "anthropic-messages",
            streaming: true,
            toolCallShape: "anthropic",
            attachments: { text: true, image: true, pdf: true },
            reasoning: {
                supported: true,
                effortLevels: ["low", "medium", "high", "xhigh", "max"],
                defaultEffort: "xhigh", // ADR-150 lock
            },
            maxOutputTokens: 16_384,
        },
    },
    {
        id: "claude-opus-4-6",
        displayName: "Claude Opus 4.6",
        contextWindow: 200_000,
        capabilities: {
            api: "anthropic-messages",
            streaming: true,
            toolCallShape: "anthropic",
            attachments: { text: true, image: true, pdf: true },
            reasoning: {
                supported: true,
                effortLevels: ["low", "medium", "high", "xhigh", "max"],
                defaultEffort: "high",
            },
            maxOutputTokens: 16_384,
        },
    },
    {
        id: "claude-sonnet-4-6",
        displayName: "Claude Sonnet 4.6",
        contextWindow: 200_000,
        capabilities: {
            api: "anthropic-messages",
            streaming: true,
            toolCallShape: "anthropic",
            attachments: { text: true, image: true, pdf: true },
            reasoning: {
                supported: true,
                effortLevels: ["low", "medium", "high"],
                defaultEffort: "medium",
            },
            maxOutputTokens: 16_384,
        },
    },
    {
        id: "claude-haiku-4-5",
        displayName: "Claude Haiku 4.5",
        contextWindow: 200_000,
        capabilities: {
            api: "anthropic-messages",
            streaming: true,
            toolCallShape: "anthropic",
            attachments: { text: true, image: true, pdf: true },
            reasoning: {
                supported: false,
                effortLevels: [],
            },
            maxOutputTokens: 8_192,
        },
    },
];
exports.anthropicProfile = {
    id: "anthropic",
    displayName: "Anthropic",
    modelSource: "static",
    defaultModelId: "claude-opus-4-7", // ADR-150 lock
    async listModels() {
        return ANTHROPIC_MODELS.slice();
    },
    createAdapter(model, config) {
        return new anthropic_adapter_1.AnthropicAdapter(model, config);
    },
};
//# sourceMappingURL=anthropic.js.map