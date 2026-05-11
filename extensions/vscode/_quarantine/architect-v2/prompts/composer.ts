// STRICT ISOLATION (ADR-140 + ADR-171): no v1 imports; no mcp_dreamgraph_*
// imports anywhere in this file or its siblings.
//
// Slice 8A.2 — PromptComposer.
//
// HARD CONTRACT (Slice 8A.2 invariant — see ADR-174 below):
//   The composer is a pure formatter. It consumes an already-assembled
//   ContextEnvelope and produces PromptParts. It does NOT:
//     - retrieve graph data (no ProjectGraphReader access)
//     - read files / inspect the workspace
//     - call MCP / vscode / fs / http / any executor port
//     - infer graph richness, novelty, or relevance
//     - reorder, drop, summarize, or otherwise re-rank context sections
//
// All cognition (subgraph selection, ranking, density estimation, sparse-
// vs-rich routing) happens upstream in the ContextAssembler / RelevanceEngine
// behind the ContextBuilderPort. The composer renders what it is given.
//
// The composer IS graph-aware in shape: it knows that sections carry a
// `source` discriminator and groups them in a stable, model-friendly order.
// But it is NOT graph-active: zero side effects, zero I/O.
//
// This file is the only PromptComposerPort implementation in 8A.2; sub-slice
// 8A.5 wires it into the extension activate function.

import type { ProviderProfile } from "../providers/index.js";
import type {
  ComposePromptInput,
  PromptComposerPort,
} from "../orchestrator/ports.js";
import type {
  ContextEnvelope,
  ContextSection,
  PromptParts,
  UserAttachment,
  UserIntent,
} from "../orchestrator/types.js";
import type { ContinuationNeed } from "../autonomy/index.js";
import {
  declareContextRequirements,
  type ContextRequirementManifest,
  type DeclareRequirementsInput,
} from "./requirements.js";

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Default prompt composer. Stateless and reusable. Tests can construct
 * directly; production wires this into OrchestratorPorts via 8A.5.
 */
export class DefaultPromptComposer implements PromptComposerPort {
  /**
   * ADR-174: declare context requirements *before* the assembler runs.
   * Pure, no I/O. The orchestrator threads the resulting manifest into
   * ContextBuilderPort.buildContext, then calls composePrompt with the
   * envelope the assembler returned.
   */
  declareRequirements(
    input: DeclareRequirementsInput,
  ): ContextRequirementManifest {
    return declareContextRequirements(input);
  }

  async composePrompt(input: ComposePromptInput): Promise<PromptParts> {
    return composePromptSync(input);
  }
}

/**
 * Synchronous formatter exposed for golden-file tests. The async port
 * method delegates here. Keep this name stable: tests import it directly.
 */
export function composePromptSync(input: ComposePromptInput): PromptParts {
  const { contextEnvelope, userIntent, providerProfile, autonomyContract } =
    input;

  validateNoActiveSections(contextEnvelope);

  const system = renderSystemPrompt({
    providerProfile,
    autonomyContract,
    contextEnvelope,
  });

  const user = renderUserPrompt({
    contextEnvelope,
    userIntent,
  });

  const toolContract = renderToolContract(providerProfile);

  return Object.freeze({
    schemaVersion: 1 as const,
    system,
    user,
    toolContract,
  });
}

// ---------------------------------------------------------------------------
// Composer-side invariant checks
// ---------------------------------------------------------------------------

/**
 * The composer is a passive renderer; it must not see sentinel values that
 * indicate the upstream assembler bypassed its own ranking. This catches
 * the case where someone smuggles a "raw graph dump" through the envelope
 * expecting the composer to filter it.
 */
function validateNoActiveSections(envelope: ContextEnvelope): void {
  if (envelope.schemaVersion !== 1) {
    throw new Error(
      `PromptComposer: unsupported ContextEnvelope.schemaVersion=${envelope.schemaVersion}`,
    );
  }
  if (envelope.estimatedTokens > envelope.windowTokens) {
    // Composer never trims. If this happens, the assembler shipped an
    // oversized envelope; failing loudly here keeps the cognition layer
    // honest instead of silently truncating in the renderer.
    throw new Error(
      `PromptComposer: envelope estimatedTokens=${envelope.estimatedTokens} ` +
        `exceeds windowTokens=${envelope.windowTokens}. ` +
        `Trimming is the ContextAssembler's job, not the composer's.`,
    );
  }
}

// ---------------------------------------------------------------------------
// System prompt
// ---------------------------------------------------------------------------

interface RenderSystemInput {
  readonly providerProfile: ProviderProfile;
  readonly autonomyContract: string;
  readonly contextEnvelope: ContextEnvelope;
}

function renderSystemPrompt(input: RenderSystemInput): string {
  const { providerProfile, autonomyContract, contextEnvelope } = input;

  const lines: string[] = [];
  lines.push(
    "You are the DreamGraph Architect, an autonomous code-modification agent.",
  );
  lines.push(
    "You operate inside a host editor (VS Code today; other hosts later).",
  );
  lines.push(
    "Your job is to propose ranked next actions as tool calls, with rationale.",
  );
  lines.push("");
  lines.push("## Autonomy contract");
  lines.push(autonomyContract.trim());
  lines.push("");
  lines.push("## Operating principles");
  lines.push(
    "- Prefer one focused action over many. Quality over quantity.",
  );
  lines.push(
    "- Never invent tool names. Choose only from the inventory exposed to you.",
  );
  lines.push(
    "- When proposing a follow-up pass, name the exact next tool you will use.",
  );
  lines.push(
    "- If the context is sparse, say so plainly and propose enrichment as one of your candidates.",
  );
  lines.push("");
  lines.push("## Context provenance");
  lines.push(
    `Provider: ${providerProfile.id} (${providerProfile.displayName}).`,
  );
  lines.push(
    `Context envelope: ${contextEnvelope.sections.length} section(s), ` +
      `≈${contextEnvelope.estimatedTokens}/${contextEnvelope.windowTokens} tokens.`,
  );
  lines.push(
    "The context below was assembled by the upstream RelevanceEngine. " +
      "Treat it as the only authoritative view of the project for this pass.",
  );
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// User prompt
// ---------------------------------------------------------------------------

interface RenderUserInput {
  readonly contextEnvelope: ContextEnvelope;
  readonly userIntent: UserIntent;
}

function renderUserPrompt(input: RenderUserInput): string {
  const { contextEnvelope, userIntent } = input;
  const lines: string[] = [];

  lines.push("# Request");
  lines.push(userIntent.text.trim());

  if (userIntent.continuation) {
    lines.push("");
    lines.push("## Continuation from previous pass");
    lines.push(renderContinuation(userIntent.continuation));
  }

  if (userIntent.attachments && userIntent.attachments.length > 0) {
    lines.push("");
    lines.push("## Attachments");
    for (const att of userIntent.attachments) {
      lines.push(renderAttachment(att));
    }
  }

  lines.push("");
  lines.push("# Context");
  if (contextEnvelope.sections.length === 0) {
    lines.push(
      "(empty — the RelevanceEngine reported no usable signals for this pass)",
    );
  } else {
    // Stable group order so prompts are diff-friendly across passes.
    // Within a group, preserve the assembler's order — the composer does
    // not re-rank.
    for (const group of GROUP_ORDER) {
      const sections = contextEnvelope.sections.filter(
        (s) => s.source === group,
      );
      if (sections.length === 0) continue;
      lines.push("");
      lines.push(`## ${groupHeading(group)}`);
      for (const section of sections) {
        lines.push(renderSection(section));
      }
    }
  }

  lines.push("");
  lines.push("# Response format");
  lines.push(
    "Return ranked action candidates with rationale. Use the tool-call shape " +
      "your provider expects. If no action is appropriate, say so explicitly " +
      "and propose pause_for_user.",
  );

  return lines.join("\n");
}

function renderContinuation(c: ContinuationNeed): string {
  const lines: string[] = [];
  lines.push(`Selected action: ${c.selectedAction.label}`);
  lines.push(`Tool: ${c.selectedAction.tool}`);
  lines.push(`Rationale: ${c.reasoningTrace}`);
  if (c.alternativesConsidered.length > 0) {
    lines.push(
      `Alternatives considered: ${c.alternativesConsidered
        .map((a) => a.label)
        .join("; ")}`,
    );
  }
  return lines.join("\n");
}

function renderAttachment(att: UserAttachment): string {
  const summary = att.summary ? ` — ${att.summary}` : "";
  return `- [${att.kind}] ${att.uri}${summary}`;
}

// ---------------------------------------------------------------------------
// Section rendering
// ---------------------------------------------------------------------------

// Graph FIRST: ADRs/nodes/edges/tensions get rendered ahead of files,
// history, and environment. RULE #1 in renderSystemPrompt depends on
// this ordering being stable across passes.
const GROUP_ORDER: readonly ContextSection["source"][] = Object.freeze([
  "graph",
  "environment",
  "file",
  "history",
]);

function groupHeading(source: ContextSection["source"]): string {
  switch (source) {
    case "environment":
      return "Environment";
    case "graph":
      return "Project graph";
    case "file":
      return "Files";
    case "history":
      return "Prior passes";
    default: {
      const _exhaustive: never = source;
      return _exhaustive;
    }
  }
}

function renderSection(section: ContextSection): string {
  // Keep section content verbatim. The assembler is responsible for any
  // truncation, summarization, or formatting decisions; the composer only
  // wraps with a stable header.
  return [
    `### ${section.id}  (≈${section.tokens} tokens)`,
    section.content,
  ].join("\n");
}

// ---------------------------------------------------------------------------
// Tool contract (per-provider)
// ---------------------------------------------------------------------------

/**
 * Tool-contract fragment appended per provider conventions. The actual tool
 * inventory is injected by the Executor port at request time (Slice 4); this
 * string only describes the *shape* the model should emit.
 */
function renderToolContract(profile: ProviderProfile): string {
  switch (profile.id) {
    case "openai":
      return [
        "Emit tool calls using the OpenAI tools/function-calling shape.",
        "Each call: { type: 'function', function: { name, arguments: <json-string> } }.",
        "Return a ranked list; the orchestrator selects one to execute.",
      ].join("\n");
    case "anthropic":
      return [
        "Emit tool calls using the Anthropic tool_use content blocks.",
        "Each block: { type: 'tool_use', name, input: <json-object> }.",
        "Return a ranked list; the orchestrator selects one to execute.",
      ].join("\n");
    case "lmstudio":
    case "ollama":
      return [
        "Emit tool calls using the OpenAI-compatible tools shape.",
        "Each call: { type: 'function', function: { name, arguments: <json-string> } }.",
        "Return a ranked list; the orchestrator selects one to execute.",
      ].join("\n");
    default: {
      const _exhaustive: never = profile.id;
      return _exhaustive;
    }
  }
}
