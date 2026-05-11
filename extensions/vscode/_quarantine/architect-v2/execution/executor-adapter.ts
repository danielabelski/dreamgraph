// architect-v2/execution/executor-adapter.ts
// Milestone 3 (v10.0.0 cutover) — Real ExecutorPort implementation.
//
// STRICT ISOLATION:
//   ADR-140: no v1 imports.
//   ADR-171: this file MUST NOT name any mcp_dreamgraph_* tool. Tool
//            names flow as data from execution/catalog.ts (allowlisted)
//            into mcpClient.callTool(name, args) at runtime.
//
// Responsibilities:
//   - callProvider:   Convert a composed PromptParts into a provider call,
//                     translate the response into a ProviderProposal whose
//                     ActionCandidates each correspond to one tool_call (or
//                     a single 'reply' candidate for pure-text answers).
//   - executeCapability: Resolve a CapabilityId to a concrete tool via
//                     Slice 6 chooseCapabilityPath + Slice 4 selectExecutor,
//                     dispatch through the appropriate bridge (MCP / editor
//                     / shell), and return a canonical ToolOutcome.
//
// Bridges:
//   - McpClient (already used by the DreamGraph adapter pair) handles MCP
//     tool calls. The executor never sees a literal tool name; it just
//     forwards `descriptor.tool` from the catalog.
//   - EditorBridge / ShellBridge are optional. When omitted, the executor
//     records a failure outcome with `failureReason: 'bridge_unavailable'`
//     so the orchestrator can fall back or surface a blocker.

import type {
  ActionCandidate,
  CapabilityInventory,
} from "../autonomy/index.js";
import type { CapabilityId } from "../capabilities/index.js";
import {
  chooseCapabilityPath,
  isGap,
  isGraphAmplified,
  measureDensity,
  type DensityProbe,
  type GraphDensity,
} from "../capabilities/index.js";
import type {
  CallProviderInput,
  ClockPort,
  ExecuteCapabilityInput,
  ExecutorPort,
} from "../orchestrator/index.js";
import { SYSTEM_CLOCK } from "../orchestrator/index.js";
import type { McpClient } from "../orchestrator/index.js";
import type {
  ProviderProposal,
  PromptParts,
} from "../orchestrator/types.js";
import type {
  ChatMessage,
  ChatRequest,
  ProviderAdapter,
  ProviderConfig,
  ProviderProfile,
  ToolCall,
  ToolDefinition as ProviderToolDefinition,
} from "../providers/index.js";
import type { ModelDescriptor } from "../providers/index.js";
import { ProviderError } from "../providers/index.js";
import { NATIVE_TOOL_CATALOG, type ToolDescriptor } from "./catalog.js";
import type { Intent } from "./intents.js";
import {
  buildCapabilityInventory,
  resolveCatalog,
  type McpRosterProbe,
  type ResolvedCatalog,
  type VsCodeCapabilityProbe,
} from "./inventory.js";
import {
  failure,
  partial,
  success,
  type ArtifactRef,
  type FailureOutcome,
  type PartialOutcome,
  type SuccessOutcome,
  type ToolOutcome,
  type VerificationEvidence,
} from "./outcome.js";
import { selectExecutor, isNoExecutor, type ExecutionPlan } from "./policy.js";
import type { Tier } from "./tiers.js";

// ---------------------------------------------------------------------------
// Bridge contracts
// ---------------------------------------------------------------------------

/**
 * Editor-side bridge. The host wires this against the live `vscode`
 * namespace; Milestone 5 supplies the production implementation.
 *
 * Each method returns a serializable result object (the executor wraps
 * it into a ToolOutcome). On unrecoverable host errors the method MUST
 * throw — the executor maps the throw into a FailureOutcome.
 */
export interface EditorBridge {
  invoke(toolName: string, args: Readonly<Record<string, unknown>>): Promise<unknown>;
}

/** Shell bridge. Same contract as EditorBridge — wired by Milestone 5. */
export interface ShellBridge {
  invoke(toolName: string, args: Readonly<Record<string, unknown>>): Promise<unknown>;
}

class UnavailableBridge implements EditorBridge, ShellBridge {
  constructor(private readonly kind: "editor" | "shell") {}
  async invoke(toolName: string): Promise<never> {
    throw new BridgeUnavailableError(this.kind, toolName);
  }
}

class BridgeUnavailableError extends Error {
  constructor(public readonly bridgeKind: "editor" | "shell", public readonly tool: string) {
    super(`${bridgeKind} bridge not wired; tool '${tool}' unavailable`);
    this.name = "BridgeUnavailableError";
  }
}

// ---------------------------------------------------------------------------
// Constructor options
// ---------------------------------------------------------------------------

export interface ExecutorAdapterOptions {
  readonly providerProfile: ProviderProfile;
  readonly model: ModelDescriptor;
  readonly providerConfig: ProviderConfig;
  /** Bound MCP transport (already used by DreamGraph reader/recorder). */
  readonly mcpClient: McpClient;
  /**
   * Resolved catalog snapshot taken once at host startup. The executor
   * uses it for every capability resolution; if MCP roster changes
   * mid-session, build a new ExecutorAdapter.
   */
  readonly resolvedCatalog: ResolvedCatalog;
  /**
   * Per-pass density probe. For v10.0.0 the host supplies a single
   * static probe (from the last graph snapshot); future versions may
   * inject a probe-source that refreshes between passes.
   */
  readonly densityProbe: DensityProbe;
  /** Optional editor bridge; defaults to an unavailable stub. */
  readonly editorBridge?: EditorBridge;
  /** Optional shell bridge; defaults to an unavailable stub. */
  readonly shellBridge?: ShellBridge;
  readonly clock?: ClockPort;
  /**
   * Confidence assigned to ActionCandidates parsed from provider tool
   * calls. Default 0.7 — high enough to clear typical mode thresholds
   * but not so high that a single hallucinated call dominates ranking.
   */
  readonly toolCallConfidence?: number;
  /**
   * Confidence assigned to the synthetic 'reply' ActionCandidate when
   * the provider returns text without tool calls. Default 0.4.
   */
  readonly textReplyConfidence?: number;
}

// ---------------------------------------------------------------------------
// Helper: build a roster + capability probe from a live MCP client.
// ---------------------------------------------------------------------------

/**
 * Walk the live MCP roster once and return a frozen ResolvedCatalog. The
 * host calls this at startup and feeds the result into ExecutorAdapter.
 *
 * On listTools() failure the function returns a catalog where every MCP
 * descriptor is marked unavailable; the executor still resolves vscode/
 * shell tiers normally.
 */
export async function resolveLiveCatalog(args: {
  mcpClient: McpClient;
  vscodeCapabilities?: VsCodeCapabilityProbe;
}): Promise<ResolvedCatalog> {
  let rosterNames: string[];
  try {
    if (typeof args.mcpClient.listTools === "function") {
      // Preferred path: the bridge owns the namespace and returns names
      // already in the catalog convention (mcp_dreamgraph_* prefix).
      const tools = await args.mcpClient.listTools();
      rosterNames = Array.from(tools);
    } else {
      // Legacy fallback: probe via a synthetic tool name (no-op on real
      // servers; kept for tests that stub callTool only).
      const result = await args.mcpClient.callTool("__list_tools__", {});
      rosterNames = parseToolNames(result);
    }
  } catch {
    rosterNames = [];
  }
  const rosterSet = new Set(rosterNames);
  const mcp: McpRosterProbe = {
    has: (name) => rosterSet.has(name),
    list: () => Array.from(rosterSet).sort(),
  };
  const vscode: VsCodeCapabilityProbe =
    args.vscodeCapabilities ?? {
      has: () => false,
    };
  return resolveCatalog({ mcp, vscode });
}

function parseToolNames(raw: unknown): string[] {
  if (!raw || typeof raw !== "object") return [];
  const list = (raw as { tools?: unknown }).tools;
  if (!Array.isArray(list)) return [];
  return list
    .map((t) => (typeof t === "string" ? t : (t as { name?: unknown })?.name))
    .filter((n): n is string => typeof n === "string" && n.length > 0);
}

// ---------------------------------------------------------------------------
// ExecutorAdapter
// ---------------------------------------------------------------------------

export class ExecutorAdapter implements ExecutorPort {
  private readonly providerAdapter: ProviderAdapter;
  private readonly clock: ClockPort;
  private readonly editor: EditorBridge;
  private readonly shell: ShellBridge;
  private readonly toolCallConfidence: number;
  private readonly textReplyConfidence: number;

  constructor(private readonly opts: ExecutorAdapterOptions) {
    this.providerAdapter = opts.providerProfile.createAdapter(
      opts.model,
      opts.providerConfig,
    );
    this.clock = opts.clock ?? SYSTEM_CLOCK;
    this.editor = opts.editorBridge ?? new UnavailableBridge("editor");
    this.shell = opts.shellBridge ?? new UnavailableBridge("shell");
    // The provider committed: an explicit tool call is a deliberate
    // model decision. Default confidence MUST clear the conscientious
    // mode threshold (0.85) so a live tool dispatch is not paused
    // behind the user's "pick one" prompt every turn. Modes stricter
    // than conscientious (cautious=0.95) still pause as designed.
    this.toolCallConfidence = opts.toolCallConfidence ?? 0.9;
    this.textReplyConfidence = opts.textReplyConfidence ?? 0.4;
  }

  // -------------------------------------------------------------------------
  // callProvider
  // -------------------------------------------------------------------------

  async callProvider(input: CallProviderInput): Promise<ProviderProposal> {
    const messages = promptToMessages(input.prompt);
    const { tools, sanitizedToOriginal } = providerToolsForInventory(
      this.opts.resolvedCatalog,
      input.inventory,
    );
    const request: ChatRequest = {
      model: this.opts.model,
      messages,
      tools,
      toolChoice: tools.length > 0 ? "auto" : undefined,
    };

    let response;
    try {
      response = await this.providerAdapter.callWithTools(request);
    } catch (err) {
      if (err instanceof ProviderError) {
        return {
          candidates: [],
          rationale: `provider_error:${err.kind}:${err.message}`,
        };
      }
      throw err;
    }

    const candidates: ActionCandidate[] = [];

    for (const call of response.toolCalls) {
      // Restore the original (possibly dot-bearing) tool name before
      // dispatching: Anthropic only accepts [a-zA-Z0-9_-] tool names
      // so providerToolsForInventory rewrites '.' -> '_' (etc.) and
      // keeps a reverse map so the executor can still find the real
      // catalog descriptor.
      const originalName = sanitizedToOriginal.get(call.name) ?? call.name;
      const callForDispatch: ToolCall =
        originalName === call.name ? call : { ...call, name: originalName };
      const candidate = toolCallToCandidate(
        callForDispatch,
        this.opts.resolvedCatalog,
        this.toolCallConfidence,
      );
      candidates.push(candidate);
    }

    if (response.text.length > 0) {
      // Always surface a reply candidate when the model produced prose
      // — even when tool calls are present. Without this fallback, a
      // request that yields one ungated/illegal tool call plus prose
      // would leave the autonomy layer with zero options and stop the
      // pass before the user sees anything actionable.
      candidates.push({
        id: `reply:${this.clock.nowEpochMs()}`,
        label: "Reply with text",
        rationale: truncate(response.text, 200),
        tool: "architect.reply",
        requiresCapabilities: [],
        confidence: this.textReplyConfidence,
      });
    }

    // Trailing-notion preservation: when the model emits free-form text
    // alongside one or more tool calls (the classic "By the way, I
    // noticed X" closing remark), `response.text` carries that
    // commentary. Without forwarding it, the chat panel would only see
    // the structured tool-call cards and the user's note would vanish.
    // Prefer the visible text; fall back to the reasoning trace when
    // text is empty (some providers split the two channels strictly).
    const rationale =
      response.text.length > 0
        ? response.text
        : response.reasoning ?? undefined;

    return {
      candidates,
      rationale,
    };
  }

  // -------------------------------------------------------------------------
  // executeCapability
  // -------------------------------------------------------------------------

  async executeCapability(input: ExecuteCapabilityInput): Promise<ToolOutcome> {
    // Path A: provider explicitly named a tool — validate against catalog
    // and invoke directly (Slice 4 invariant: tool must belong to a tier
    // covering the capability's intent set).
    if (input.toolName) {
      const desc = NATIVE_TOOL_CATALOG.find((d) => d.tool === input.toolName);
      if (!desc) {
        return this.makeFailure({
          tool: input.toolName,
          tier: 5 as Tier,
          intent: "shell.run" as Intent,
          failureReason: `Tool '${input.toolName}' is not in the native catalog`,
          recoverable: false,
        });
      }
      if (!this.opts.resolvedCatalog.available.includes(desc)) {
        return this.makeFailure({
          tool: desc.tool,
          tier: desc.tier,
          intent: desc.intent,
          failureReason: `Tool '${desc.tool}' is not available in the live catalog`,
          recoverable: false,
        });
      }
      return this.invokeDescriptor(desc, input);
    }

    // Path B: orchestrator hands a CapabilityId; the executor resolves
    // the path via Slice 6 + Slice 4.
    const density = measureDensity(this.opts.densityProbe, input.capabilityId);
    const plan = chooseCapabilityPath(input.capabilityId, density);

    if (isGap(plan)) {
      return this.makeFailure({
        tool: "architect.capability_gap",
        tier: 5 as Tier,
        intent: "shell.run" as Intent,
        failureReason: `Capability '${input.capabilityId}' is graph-only and the graph is ${density}; enrichment ${plan.enrichmentQueued ?? "(none)"} queued.`,
        recoverable: false,
      });
    }

    const intents: readonly Intent[] = isGraphAmplified(plan)
      ? plan.intents.length > 0
        ? plan.intents
        : plan.allowedFallback
      : plan.intents;

    for (const intent of intents) {
      const planResult = selectExecutor(intent, this.opts.resolvedCatalog);
      if (isNoExecutor(planResult)) continue;
      return this.invokeDescriptor(planResult.chosen, input, planResult);
    }

    return this.makeFailure({
      tool: "architect.no_executor",
      tier: 5 as Tier,
      intent: intents[0] ?? ("shell.run" as Intent),
      failureReason: `No tier covers any intent for capability '${input.capabilityId}' (density=${density})`,
      recoverable: false,
    });
  }

  // -------------------------------------------------------------------------
  // Internal: dispatch a chosen descriptor through the right bridge.
  // -------------------------------------------------------------------------

  private async invokeDescriptor(
    desc: ToolDescriptor,
    input: ExecuteCapabilityInput,
    plan?: ExecutionPlan,
  ): Promise<ToolOutcome> {
    const start = this.clock.nowEpochMs();
    const args = (input.toolArgs ?? {}) as Readonly<Record<string, unknown>>;
    void plan; // alternativesByTier is recorded by callers if needed.

    try {
      let raw: unknown;
      switch (desc.kind) {
        case "mcp":
          raw = await this.opts.mcpClient.callTool(desc.tool, args);
          break;
        case "vscode":
          raw = await this.editor.invoke(desc.tool, args);
          break;
        case "shell":
          raw = await this.shell.invoke(desc.tool, args);
          break;
      }
      return this.makeSuccess(desc, raw, start, input);
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      const recoverable = !(err instanceof BridgeUnavailableError);
      return this.makeFailure({
        tool: desc.tool,
        tier: desc.tier,
        intent: desc.intent,
        failureReason: reason,
        recoverable,
        suggestedFallbackTier: suggestFallbackTier(desc.tier),
        executedAtEpochMs: start,
        durationMs: this.clock.nowEpochMs() - start,
      });
    }
  }

  // -------------------------------------------------------------------------
  // Internal: outcome construction.
  // -------------------------------------------------------------------------

  private makeSuccess(
    desc: ToolDescriptor,
    raw: unknown,
    start: number,
    input: ExecuteCapabilityInput,
  ): SuccessOutcome | PartialOutcome {
    const now = this.clock.nowEpochMs();
    const artifacts = extractArtifacts(raw, desc);
    // Keep a bounded snapshot of the raw response so the OutcomeCard can
    // render what an MCP read-tool actually returned. Without this the
    // user sees only artifact refs and never the JSON body of e.g.
    // `query_resource` / `cognitive_status`.
    const payload = capturePayload(raw);
    if (input.invocationReason.kind === "verification") {
      const evidence: VerificationEvidence = {
        kind: input.invocationReason.verificationKind,
        passed: true,
        summary: summarizeRaw(raw, 240),
      };
      return success({
        tool: desc.tool,
        tier: desc.tier,
        intent: desc.intent,
        executedAtEpochMs: start,
        durationMs: now - start,
        artifacts,
        evidence,
        payload,
      });
    }
    if (artifacts.length === 0 && rawIndicatesPartial(raw)) {
      return partial({
        tool: desc.tool,
        tier: desc.tier,
        intent: desc.intent,
        executedAtEpochMs: start,
        durationMs: now - start,
        artifacts: [],
        blockedBy: summarizeRaw(raw, 200),
        payload,
      });
    }
    return success({
      tool: desc.tool,
      tier: desc.tier,
      intent: desc.intent,
      executedAtEpochMs: start,
      durationMs: now - start,
      artifacts,
      payload,
    });
  }

  private makeFailure(args: {
    tool: string;
    tier: Tier;
    intent: Intent;
    failureReason: string;
    recoverable: boolean;
    suggestedFallbackTier?: Tier;
    executedAtEpochMs?: number;
    durationMs?: number;
  }): FailureOutcome {
    const now = this.clock.nowEpochMs();
    return failure({
      tool: args.tool,
      tier: args.tier,
      intent: args.intent,
      executedAtEpochMs: args.executedAtEpochMs ?? now,
      durationMs: args.durationMs ?? 0,
      failureReason: args.failureReason,
      recoverable: args.recoverable,
      suggestedFallbackTier: args.suggestedFallbackTier,
    });
  }
}

// ---------------------------------------------------------------------------
// Module helpers (pure)
// ---------------------------------------------------------------------------

function promptToMessages(prompt: PromptParts): ChatMessage[] {
  const out: ChatMessage[] = [];
  if (prompt.system && prompt.system.length > 0) {
    out.push({ role: "system", content: prompt.system });
  }
  if (prompt.toolContract && prompt.toolContract.length > 0) {
    // toolContract is appended as a system addendum so providers that
    // treat 'system' specially still see it as instruction (not user
    // turn). Keeps the single-system-message convention intact.
    out.push({ role: "system", content: prompt.toolContract });
  }
  out.push({ role: "user", content: prompt.user });
  return out;
}

/**
 * Project the live catalog into the provider tool list.
 *
 * Earlier revisions filtered by `inventory.has(desc.intent)`, but the
 * inventory is keyed by CapabilityId (e.g. "read.file") while
 * descriptors carry Intents (e.g. "file.read") — a vocabulary mismatch
 * that always returned empty, leaving the model with zero tools and
 * forcing it to hallucinate tool_use JSON in prose. The catalog snapshot
 * already filtered by live MCP roster, so liveness is the gate; the
 * inventory still trims candidate dispatch downstream.
 *
 * Tool descriptions are intentionally short — the catalog is a long flat
 * list and bloated descriptions push the request over the budget brake.
 */
// Anthropic / OpenAI tool naming contract: ^[a-zA-Z0-9_-]{1,128}$.
// Many of our intent-style tool ids contain '.' (shell.run, mcp.read,
// architect.reply...) which would 400 the provider call. Rewrite the
// dotted/illegal characters to '_', keep a reverse map so the executor
// can still resolve the descriptor when the model calls the sanitized
// name back. De-dupe on the sanitized name to keep the schema stable.
export function sanitizeProviderToolName(name: string): string {
  // Replace any rune outside [A-Za-z0-9_-] with '_'.
  const cleaned = name.replace(/[^a-zA-Z0-9_-]/g, "_");
  // Hard cap at 128 to honor the upstream limit.
  return cleaned.length > 128 ? cleaned.slice(0, 128) : cleaned;
}

export interface ProviderToolBundle {
  readonly tools: ProviderToolDefinition[];
  /** sanitized provider name -> original catalog tool id */
  readonly sanitizedToOriginal: Map<string, string>;
}

export function providerToolsForInventory(
  resolved: ResolvedCatalog,
  _inventory: CapabilityInventory,
): ProviderToolBundle {
  const tools: ProviderToolDefinition[] = [];
  const seenOriginal = new Set<string>();
  const seenSanitized = new Set<string>();
  const sanitizedToOriginal = new Map<string, string>();
  for (const desc of resolved.available) {
    if (seenOriginal.has(desc.tool)) continue;
    seenOriginal.add(desc.tool);
    let safeName = sanitizeProviderToolName(desc.tool);
    if (safeName.length === 0) safeName = `tool_${tools.length}`;
    // Disambiguate sanitization collisions deterministically.
    if (seenSanitized.has(safeName)) {
      let suffix = 2;
      let candidate = `${safeName.slice(0, 124)}_${suffix}`;
      while (seenSanitized.has(candidate)) {
        suffix += 1;
        candidate = `${safeName.slice(0, 124)}_${suffix}`;
      }
      safeName = candidate;
    }
    seenSanitized.add(safeName);
    sanitizedToOriginal.set(safeName, desc.tool);
    tools.push({
      name: safeName,
      description: `[T${desc.tier}/${desc.intent}] ${desc.notes ?? desc.intent}`,
      inputSchema: {
        type: "object",
        properties: {},
        additionalProperties: false,
      },
    });
  }
  return { tools, sanitizedToOriginal };
}

function toolCallToCandidate(
  call: ToolCall,
  resolved: ResolvedCatalog,
  baseConfidence: number,
): ActionCandidate {
  const desc = resolved.available.find((d) => d.tool === call.name);
  // Capability gating contract: the resolved catalog only contains live
  // tools (the MCP roster has already proved the capability). Asserting
  // a CapabilityId requirement here would force the autonomy decision
  // layer to re-prove what the executor already knows; worse, it
  // demands a vocabulary translation (Intent -> CapabilityId) that has
  // historically dropped every candidate. We surface the intent in the
  // rationale for traceability but require nothing structurally.
  const requires: string[] = [];
  let toolArgs: Record<string, unknown> | undefined;
  try {
    const parsed = JSON.parse(call.argumentsJson || "{}");
    if (parsed && typeof parsed === "object") toolArgs = parsed as Record<string, unknown>;
  } catch {
    toolArgs = undefined;
  }
  return {
    id: call.id,
    label: call.name,
    rationale: desc
      ? `T${desc.tier} ${desc.intent}`
      : `Tool '${call.name}' not in native catalog`,
    tool: call.name,
    toolArgs,
    requiresCapabilities: requires,
    confidence: baseConfidence,
  };
}

function suggestFallbackTier(current: Tier): Tier | undefined {
  if (current >= 5) return undefined;
  return (current + 1) as Tier;
}

function extractArtifacts(raw: unknown, desc: ToolDescriptor): ArtifactRef[] {
  // Best-effort: many MCP tools include a `path`, `entityId`, `cardId`,
  // or `adrId` in their result. We surface any we recognize so the
  // orchestrator's no-progress detector sees real deltas. Unknown
  // shapes return [] (no artifact claimed), which is the conservative
  // default — successive calls without artifacts trigger no-progress
  // detection deliberately.
  if (!raw || typeof raw !== "object") return [];
  const r = raw as Record<string, unknown>;
  const out: ArtifactRef[] = [];

  const path = pickString(r, ["path", "filePath", "file"]);
  if (path) out.push({ kind: "file", id: path });

  const entityId = pickString(r, ["entityId", "entity", "id"]);
  if (entityId && desc.kind === "mcp" && desc.intent.startsWith("entity")) {
    out.push({ kind: "mcp_entity", id: entityId });
  }

  const adrId = pickString(r, ["adrId", "adr_id"]);
  if (adrId) out.push({ kind: "adr", id: adrId });

  const cardId = pickString(r, ["cardId", "card_id"]);
  if (cardId) out.push({ kind: "card", id: cardId });

  const verificationId = pickString(r, ["verificationId", "verification_id"]);
  if (verificationId) out.push({ kind: "verification", id: verificationId });

  return out;
}

function pickString(r: Record<string, unknown>, keys: readonly string[]): string | undefined {
  for (const k of keys) {
    const v = r[k];
    if (typeof v === "string" && v.length > 0) return v;
  }
  return undefined;
}

function rawIndicatesPartial(raw: unknown): boolean {
  if (!raw || typeof raw !== "object") return false;
  const r = raw as Record<string, unknown>;
  return r.partial === true || typeof r.blockedBy === "string";
}

function summarizeRaw(raw: unknown, max: number): string {
  if (raw === undefined || raw === null) return "";
  let s: string;
  if (typeof raw === "string") s = raw;
  else {
    try {
      s = JSON.stringify(raw);
    } catch {
      s = String(raw);
    }
  }
  return truncate(s, max);
}

function truncate(s: string, n: number): string {
  return s.length <= n ? s : s.slice(0, n) + "…";
}

/**
 * Capture a bounded snapshot of a tool's raw response for surfacing in
 * the OutcomeCard. Strings/JSON values pass through; oversized payloads
 * are stringified-and-truncated so a multi-megabyte read tool never
 * overflows the renderer.
 */
const PAYLOAD_MAX_CHARS = 8_000;
function capturePayload(raw: unknown): unknown {
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw === "string") {
    return raw.length <= PAYLOAD_MAX_CHARS
      ? raw
      : raw.slice(0, PAYLOAD_MAX_CHARS) + "…";
  }
  try {
    const s = JSON.stringify(raw);
    if (s.length <= PAYLOAD_MAX_CHARS) return raw;
    return { _truncated: true, preview: s.slice(0, PAYLOAD_MAX_CHARS) + "…" };
  } catch {
    return String(raw).slice(0, PAYLOAD_MAX_CHARS);
  }
}

// Touch unused-import guard so TS does not complain in some configs.
void buildCapabilityInventory;
