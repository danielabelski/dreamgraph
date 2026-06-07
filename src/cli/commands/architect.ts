/**
 * `dg architect` - terminal entrypoint for daemon-owned Architect contracts.
 *
 * Terminal commands stay thin over daemon-owned Architect contracts.
 */

import React, { useState } from "react";
import { Box, Text, render, useApp, useInput, useStdout } from "ink";
import type { ParsedArgs } from "../dg.js";
import {
  isProcessAlive,
  readServerMeta,
  resolveInstanceForCommand,
  validateOwnership,
} from "../utils/daemon.js";
import {
  archiveArchitectPlan,
  createArchitectPlan,
  decideArchitectFutureReview,
  getArchitectAdr,
  getArchitectConfig,
  getArchitectEvents,
  getArchitectFutureReview,
  getArchitectPlan,
  getArchitectProviderReadiness,
  getArchitectPulse,
  getArchitectSchedules,
  listArchitectAdrs,
  listArchitectPlans,
  postArchitectChat,
  postArchitectCommand,
  postArchitectScheduleAction,
  redactArchitectValue,
  selectArchitectPlan,
  setArchitectConfig,
  type ArchitectClientOptions,
  type SetArchitectConfigInput,
} from "../utils/architect-client.js";
import { mcpCallTool } from "../utils/mcp-call.js";

type ArchitectTopCommand = "status" | "plans" | "plan" | "config" | "chat" | "run" | "trace" | "adr" | "graph" | "schedule" | "future" | "tui" | "help";

export interface ArchitectInvocation {
  instance?: string;
  command: ArchitectTopCommand;
  args: string[];
}

const TOP_COMMANDS = new Set<string>(["status", "plans", "plan", "config", "chat", "run", "trace", "adr", "graph", "schedule", "future", "tui", "help"]);

export function parseArchitectInvocation(positional: string[]): ArchitectInvocation {
  const first = positional[0];
  if (!first) return { command: "status", args: [] };
  if (TOP_COMMANDS.has(first)) return { command: first as ArchitectTopCommand, args: positional.slice(1) };

  const second = positional[1];
  if (second && TOP_COMMANDS.has(second)) {
    return { instance: first, command: second as ArchitectTopCommand, args: positional.slice(2) };
  }

  return { instance: first, command: "status", args: positional.slice(1) };
}

function printArchitectUsage(): void {
  console.log(`
dg architect - Terminal Architect daemon client

Usage:
  dg architect [<instance>] status [--json]
  dg architect [<instance>] plans [--json]
  dg architect [<instance>] plan show <plan-id> [--section summary|slices|log|adrs|graph|all] [--json]
  dg architect [<instance>] plan create --title <title> [--id <id>] [--json]
  dg architect [<instance>] plan select <plan-id|null> [--json]
  dg architect [<instance>] plan archive <plan-id> [--reason <text>] [--json]
  dg architect [<instance>] config get [--json]
  dg architect [<instance>] config set [--adapter <id>] [--provider <id>] [--model <id>] [--autonomy <mode>] [--json]
  dg architect [<instance>] chat --message <text> [--plan <id>] [--scope project|plan] [--stream] [--json-events] [--json]
  dg architect [<instance>] run cancel|pause|resume [--session <id>] [--json]
  dg architect [<instance>] trace [--raw-events] [--json]
  dg architect [<instance>] adr list|show|bindings [<adr-id>] [--plan <id>] [--json]
  dg architect [<instance>] graph search|workflow|data-model <query> [--json]
  dg architect [<instance>] schedule list|history|run|pause|resume [<schedule-id>] [--plan <id>] [--json]
  dg architect [<instance>] future <plan-id> [--decide accept|reject|defer|supersede] [--reason <text>] [--json]
  dg architect [<instance>] tui [--json]

Options:
  --instance <uuid|name>    Target instance when not given positionally
  --master-dir <path>       Override master directory
  --json                    Output daemon JSON envelope
  --section <name>          Plan detail section for plan show
  --title <text>            Title for plan create
  --id <id>                 Requested safe id for plan create
  --reason <text>           Audit reason for plan archive
  --adapter <id>            Architect adapter, e.g. native_api_tool_loop or codex-cli
  --provider <id>           Provider for native API routes, or none for CLI adapters
  --model <id>              Model id to persist through daemon runtime config
  --autonomy <mode>         Architect autonomy mode
  --message <text>          Chat prompt body; never sent in URL/query parameters
  --plan <id>               Selected plan id for chat, ADR bindings, future review, or audited actions
  --scope <mode>            Chat scope: project or plan
  --stream                  Request daemon SSE transport for chat
  --json-events             Print normalized JSON event records for streaming/chat automation
  --raw-events              Include raw daemon event details where supported
  --decide <decision>       Future-review decision: accept, reject, defer, supersede

Lifecycle and config commands call daemon endpoints; they never edit plan markdown,
engine.env, provider keys, or selection state directly from the terminal client.
`);
}

function flagString(flags: ParsedArgs["flags"], key: string): string | undefined {
  const value = flags[key];
  return typeof value === "string" ? value : undefined;
}

function planIdFromSelection(value: string | undefined): string | null | undefined {
  if (!value) return undefined;
  const normalized = value.trim().toLowerCase();
  return normalized === "null" || normalized === "none" || normalized === "clear" ? null : value;
}

async function resolveArchitectClient(
  invocation: ArchitectInvocation,
  flags: ParsedArgs["flags"],
): Promise<ArchitectClientOptions> {
  const query = invocation.instance ?? flagString(flags, "instance") ?? process.env.DREAMGRAPH_INSTANCE_UUID;
  const { entry, instanceRoot } = await resolveInstanceForCommand(query, flags);
  const meta = await readServerMeta(instanceRoot);

  if (!meta || !isProcessAlive(meta.pid) || meta.port == null || !validateOwnership(meta, entry.uuid)) {
    throw new Error(`Instance '${entry.name}' is not running. Start it first: dg start ${entry.name}`);
  }

  return { port: meta.port, timeoutMs: 30_000, chatTimeoutMs: 30 * 60_000 };
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? value as Record<string, unknown> : {};
}

function text(value: unknown, fallback = "-"): string {
  return typeof value === "string" && value.length > 0 ? value : fallback;
}

function printJson(payload: unknown): void {
  console.log(JSON.stringify(payload, null, 2));
}

export function runtimeFromStatusPayload(payload: Record<string, unknown>): Record<string, unknown> {
  const pulse = asRecord(payload.pulse);
  return asRecord(payload.runtime ?? payload.architect_runtime ?? pulse.runtime ?? pulse.architect_runtime ?? payload.architect_llm ?? pulse.architect_llm);
}

function projectFromStatusPayload(payload: Record<string, unknown>): Record<string, unknown> {
  const pulse = asRecord(payload.pulse);
  return asRecord(payload.project_scope ?? payload.project ?? pulse.project_scope ?? pulse.project);
}

function planFromStatusPayload(payload: Record<string, unknown>): Record<string, unknown> {
  const pulse = asRecord(payload.pulse);
  return asRecord(payload.selected_plan ?? payload.plan ?? pulse.selected_plan ?? pulse.plan);
}

function selectedPlanIdFromStatusPayload(payload: Record<string, unknown>): unknown {
  const pulse = asRecord(payload.pulse);
  const plan = planFromStatusPayload(payload);
  return plan.id ?? plan.plan_id ?? payload.selected_plan_id ?? pulse.selected_plan_id;
}

function printStatus(payload: Record<string, unknown>): void {
  const runtime = runtimeFromStatusPayload(payload);
  const project = projectFromStatusPayload(payload);

  console.log("Architect status");
  console.log(`  Authority: ${text(payload.contract)} ${text(payload.version)}`);
  console.log(`  Adapter:   ${text(runtime.adapter)}`);
  console.log(`  Provider:  ${text(runtime.provider)}`);
  console.log(`  Model:     ${text(runtime.model)}`);
  console.log(`  Autonomy:  ${text(runtime.autonomy_mode ?? runtime.mode)}`);
  console.log(`  Route:     ${text(runtime.route ?? runtime.execution_route)}`);
  console.log(`  Session:   ${text(runtime.session_id)}`);
  console.log(`  Scope:     ${text(project.mode ?? project.scope)}`);
  console.log(`  Plan:      ${text(selectedPlanIdFromStatusPayload(payload), "(none)")}`);
}

function printPlans(payload: Record<string, unknown>): void {
  const plans = Array.isArray(payload.plans) ? payload.plans as Record<string, unknown>[] : [];
  const selected = text(payload.selected_plan_id ?? asRecord(payload.architect_selection).selected_plan_id, "(none)");
  if (plans.length === 0) {
    console.log(`No Architect plans found. Selected plan: ${selected}`);
    return;
  }

  console.log(`Architect plans (${plans.length}); selected: ${selected}`);
  for (const plan of plans) {
    const id = text(plan.id ?? plan.plan_id);
    const title = text(plan.title ?? plan.name);
    const status = text(plan.status);
    const operational = asRecord(plan.operational_state);
    const next = asRecord(operational.next_slice);
    const marker = selected !== "(none)" && id === selected ? "*" : " ";
    const lifecycle = text(operational.plan_lifecycle ?? status);
    const execution = text(operational.execution_state);
    const nextTitle = text(next.title ?? next.id, "none");
    console.log(`${marker} ${id.padEnd(36)} ${lifecycle.padEnd(12)} ${execution.padEnd(10)} next: ${nextTitle}  ${title}`);
  }
}

function printPlanDetail(payload: Record<string, unknown>, section: string): void {
  const plan = asRecord(payload.plan);
  const operational = asRecord(plan.operational_state);
  const living = asRecord(plan.living_state);
  const registry = asRecord(plan.registry);
  const resume = asRecord(registry.resume_state ?? plan.resume_state);
  if (section === "all" || section === "summary") {
    console.log(`Plan: ${text(plan.title ?? plan.name)}`);
    console.log(`  ID:        ${text(plan.id ?? plan.plan_id)}`);
    console.log(`  Status:    ${text(plan.status)}`);
    console.log(`  Lifecycle: ${text(operational.plan_lifecycle)}`);
    console.log(`  Execution: ${text(operational.execution_state)}`);
    console.log(`  Active:    ${text(asRecord(operational.active_slice).title ?? operational.current_slice_title, "none")}`);
    console.log(`  Next:      ${text(asRecord(operational.next_slice).title ?? asRecord(operational.next_slice).id, "none")}`);
    console.log(`  Review:    ${text(living.review_state ?? operational.review_state, "unknown")}`);
    console.log(`  Blockers:  ${Array.isArray(living.blockers) && living.blockers.length > 0 ? living.blockers.join("; ") : "none"}`);
    console.log(`  Path:      ${text(plan.path)}`);
    console.log(`  Log:       ${text(plan.implementation_log_path ?? plan.log_path)}`);
  }

  if (section === "all" || section === "slices") {
    const slices = Array.isArray(plan.slices) ? plan.slices as Record<string, unknown>[] : [];
    if (slices.length > 0) {
      console.log("Slices");
      for (const slice of slices) {
        console.log(`  ${text(slice.id).padEnd(36)} ${text(slice.status).padEnd(14)} ${text(slice.title ?? slice.name)}`);
      }
    }
  }

  if (section === "all" || section === "log") {
    const checkpoints = Array.isArray(plan.checkpoints) ? plan.checkpoints as Record<string, unknown>[] : [];
    const latest = checkpoints.slice(-5);
    console.log("Implementation log state");
    console.log(`  Latest event: ${text(resume.last_log_heading ?? operational.last_checkpoint_at, "none")}`);
    console.log(`  Resume note:  ${text(resume.last_resume_note ?? operational.resume_note, "none")}`);
    if (latest.length > 0) {
      console.log("Latest checkpoints");
      for (const entry of latest) {
        console.log(`  ${text(entry.timestamp ?? entry.date, "unknown")} ${text(entry.status)} ${text(entry.slice_id ?? entry.slice)} ${text(entry.action ?? entry.summary)}`);
      }
    }
  }

  if (section === "all" || section === "adrs") {
    const adrs = Array.isArray(plan.adr_bindings) ? plan.adr_bindings : [];
    console.log(`ADR bindings: ${adrs.length > 0 ? adrs.join(", ") : "none"}`);
  }

  if (section === "all" || section === "graph") {
    const bindings = Array.isArray(plan.graph_bindings) ? plan.graph_bindings as Record<string, unknown>[] : [];
    console.log("Graph bindings");
    if (bindings.length === 0) {
      console.log("  none");
    } else {
      for (const binding of bindings.slice(0, 12)) {
        console.log(`  ${text(binding.kind)}:${text(binding.id)} ${text(binding.label, "")}`);
      }
    }
  }
}

function printPlanLifecycleResult(payload: Record<string, unknown>): void {
  const result = asRecord(payload.result);
  console.log(`Plan ${text(result.status, "updated")}: ${text(result.title ?? result.selected_plan_title ?? result.plan_id ?? result.selected_plan_id, "Project Scope")}`);
  console.log(`  Plan ID:   ${text(result.plan_id ?? result.selected_plan_id, "(none)")}`);
  console.log(`  Selected:  ${text(result.selected_plan_id, "(none)")}`);
  console.log(`  Persisted: ${String(result.persisted ?? "unknown")}`);
  console.log(`  Path:      ${text(result.plan_path ?? result.archived_path, "-")}`);
  console.log(`  Log:       ${text(result.log_path ?? result.archived_log_path, "-")}`);
}

function printConfig(payload: Record<string, unknown>): void {
  const runtime = asRecord(payload.runtime ?? payload.architect_runtime ?? asRecord(payload.result).runtime);
  const result = asRecord(payload.result);
  const readiness = asRecord(payload.readiness);
  console.log("Architect config");
  console.log(`  Adapter:       ${text(runtime.adapter ?? result.adapter)}`);
  console.log(`  Provider:      ${text(runtime.provider ?? result.provider)}`);
  console.log(`  Model:         ${text(runtime.model ?? result.model)}`);
  console.log(`  Autonomy:      ${text(runtime.autonomy_mode ?? result.autonomy_mode ?? result.mode)}`);
  console.log(`  Route:         ${text(runtime.execution_route ?? runtime.route)}`);
  console.log(`  Session:       ${text(runtime.session_id)}`);
  console.log(`  Persisted:     ${String(result.persisted ?? "unknown")}`);
  console.log(`  Engine env:    ${text(result.engine_env_path, "(none)")}`);
  if (Object.keys(readiness).length > 0) {
    console.log(`  Readiness:     ${readiness.ready === true ? "ready" : "needs_attention"}`);
    console.log(`  Key status:    ${readiness.kind === "api" && readiness.ready !== true ? "missing_or_unavailable" : "not_exposed"}`);
    console.log(`  Detail:        ${text(readiness.detail)}`);
  }
}

function printChatPayload(payload: Record<string, unknown>): void {
  const result = asRecord(payload.result);
  const route = asRecord(result.route ?? payload.route);
  const runtime = asRecord(result.runtime ?? payload.runtime ?? payload.architect_runtime);
  const trace = Array.isArray(result.tool_trace) ? result.tool_trace as Record<string, unknown>[] : [];
  console.log("Architect chat");
  console.log(`  Route:    ${text(route.execution_route ?? runtime.execution_route ?? runtime.route)}`);
  console.log(`  Adapter:  ${text(route.adapter ?? runtime.adapter)}`);
  console.log(`  Provider: ${text(route.provider ?? runtime.provider)}`);
  console.log(`  Model:    ${text(route.completion_model ?? route.model ?? runtime.model)}`);
  console.log(`  Session:  ${text(route.session_id ?? runtime.session_id)}`);
  console.log(`  Scope:    ${text(result.chat_scope)}`);
  if (trace.length > 0) {
    console.log("Tool trace");
    for (const entry of trace) {
      console.log(`  ${text(entry.status).padEnd(10)} ${text(entry.tool).padEnd(28)} ${text(entry.duration_ms, "-")}ms ${text(entry.result_preview ?? entry.error_preview ?? entry.args_summary, "")}`);
    }
  }
  console.log("Response");
  console.log(text(result.content, ""));
  const fallback = text(route.fallback_reason, "");
  if (fallback) console.log(`Fallback: ${fallback}`);
}

function printJsonEvents(events: Array<{ type: string; data: unknown }>): void {
  for (const event of events) {
    console.log(JSON.stringify({ type: event.type, data: redactArchitectValue(event.data) }));
  }
}

function printTrace(payload: Record<string, unknown>): void {
  const events = Array.isArray(payload.events) ? payload.events as Record<string, unknown>[] : [];
  if (events.length === 0) {
    console.log("No Architect events available from daemon projection.");
    return;
  }
  for (const event of events.slice(-40)) {
    const kind = text(event.kind ?? event.type);
    if (kind.includes("heartbeat") || kind.includes("noop")) continue;
    console.log(`${text(event.created_at ?? event.timestamp, "-")} ${kind} ${text(event.summary ?? event.message ?? event.seq, "")}`);
  }
}

function printAdrList(payload: Record<string, unknown>): void {
  const adrs = Array.isArray(payload.adrs) ? payload.adrs as Record<string, unknown>[] : [];
  console.log(`ADRs (${adrs.length})`);
  for (const adr of adrs) {
    console.log(`  ${text(adr.id ?? adr.adr_id).padEnd(12)} ${text(adr.status).padEnd(10)} ${text(adr.title ?? adr.name)}`);
  }
}

function printFutureReview(payload: Record<string, unknown>): void {
  const review = asRecord(payload.future_review);
  const model = asRecord(review.model_provenance);
  const candidates = Array.isArray(review.candidates) ? review.candidates as Record<string, unknown>[] : [];
  console.log("Adaptive Future Review");
  console.log(`  Status:   ${text(review.status)}`);
  console.log(`  Route:    ${text(model.route ?? model.execution_route)}`);
  console.log(`  Model:    ${text(model.model)}`);
  console.log(`  Fallback: ${text(model.fallback_reason, "none")}`);
  for (const candidate of candidates) {
    console.log(`  ${text(candidate.id).padEnd(24)} score=${text(candidate.score, "-")} ${text(candidate.label ?? candidate.title ?? candidate.action)}`);
  }
}

function printSchedules(payload: Record<string, unknown>): void {
  const scheduler = asRecord(payload.scheduler);
  const schedules = Array.isArray(payload.schedules) ? payload.schedules as Record<string, unknown>[] : [];
  console.log(`Architect schedules (${text(scheduler.total, String(schedules.length))}); enabled: ${text(scheduler.enabled, "-")}`);
  for (const schedule of schedules) {
    console.log(`  ${text(schedule.id).padEnd(32)} ${text(schedule.status).padEnd(10)} ${text(schedule.name ?? schedule.label)}`);
  }
}

interface ArchitectTuiAppProps {
  client: ArchitectClientOptions;
  status: Record<string, unknown>;
  plans: Record<string, unknown>;
}

function ArchitectTuiApp({ client, status, plans }: ArchitectTuiAppProps): React.ReactElement {
  const { exit } = useApp();
  const { stdout } = useStdout();
  const [focus, setFocus] = useState<"chat" | "runtime" | "plans">("chat");
  const [prompt, setPrompt] = useState("");
  const [isSending, setIsSending] = useState(false);
  const [messages, setMessages] = useState<Array<{ role: "system" | "user" | "assistant"; content: string }>>([
    { role: "system", content: "Chat is focused. Type a prompt and press Enter." },
  ]);
  const runtime = runtimeFromStatusPayload(status);
  const project = projectFromStatusPayload(status);
  const planRows = Array.isArray(plans.plans) ? plans.plans as Record<string, unknown>[] : [];
  const selected = text(plans.selected_plan_id ?? selectedPlanIdFromStatusPayload(status), "(none)");
  const width = Math.max(stdout.columns ?? 100, 80);
  const height = Math.max(stdout.rows ?? 28, 20);
  const transcriptHeight = Math.max(height - 13, 7);
  const promptLine = `${focus === "chat" ? ">" : " "} ${prompt}${focus === "chat" && !isSending ? "_" : ""}`;

  async function submitPrompt(): Promise<void> {
    const message = prompt.trim();
    if (!message || isSending) return;
    setPrompt("");
    setIsSending(true);
    setMessages((current) => [...current, { role: "user", content: message }, { role: "system", content: "Sending through daemon chat contract..." }]);
    try {
      const payload = await postArchitectChat(client, {
        message,
        planId: typeof selected === "string" && selected !== "(none)" ? selected : undefined,
        scope: "project",
        stream: false,
      });
      const chatPayload = "result" in payload && payload.result && typeof payload.result === "object"
        ? payload.result as Record<string, unknown>
        : payload as Record<string, unknown>;
      const content = text(chatPayload.content, "(no response content returned)");
      setMessages((current) => [...current.filter((entry) => entry.content !== "Sending through daemon chat contract..."), { role: "assistant", content }]);
    } catch (error) {
      const messageText = error instanceof Error ? error.message : String(error);
      setMessages((current) => [...current.filter((entry) => entry.content !== "Sending through daemon chat contract..."), { role: "system", content: `Chat failed: ${messageText}` }]);
    } finally {
      setIsSending(false);
      setFocus("chat");
    }
  }

  useInput((input, key) => {
    if (key.ctrl && input === "c") exit();
    if (input === "q" && focus !== "chat") exit();
    if (key.escape) {
      setFocus("chat");
      return;
    }
    if (key.tab) {
      setFocus((current) => current === "chat" ? "runtime" : current === "runtime" ? "plans" : "chat");
      return;
    }
    if (input === "1") {
      setFocus("chat");
      return;
    }
    if (input === "2") {
      setFocus("runtime");
      return;
    }
    if (input === "3") {
      setFocus("plans");
      return;
    }
    if (focus !== "chat" || isSending) return;
    if (key.return) {
      void submitPrompt();
      return;
    }
    if (key.backspace || key.delete) {
      setPrompt((current) => current.slice(0, -1));
      return;
    }
    if (input && !key.ctrl && !key.meta) {
      setPrompt((current) => `${current}${input}`);
    }
  });

  const visibleMessages = messages.slice(-transcriptHeight);

  return React.createElement(Box, { flexDirection: "column", borderStyle: "round", paddingX: 1, width, height },
    React.createElement(Box, { justifyContent: "space-between" },
      React.createElement(Text, { bold: true }, "DreamGraph Architect"),
      React.createElement(Text, { color: "cyan" }, text(runtime.execution_route ?? runtime.route)),
    ),
    React.createElement(Box, { marginTop: 1, flexGrow: 1 },
      React.createElement(Box, { flexDirection: "column", flexGrow: 1, paddingRight: 1 },
        React.createElement(Text, { color: focus === "chat" ? "cyan" : "gray", bold: focus === "chat" }, "1 Chat"),
        React.createElement(Box, { flexDirection: "column", height: transcriptHeight },
          ...(visibleMessages.map((entry, index) => {
            const label = entry.role === "user" ? "you" : entry.role === "assistant" ? "architect" : "status";
            const color = entry.role === "user" ? "green" : entry.role === "assistant" ? "white" : "gray";
            return React.createElement(Text, { key: `${entry.role}-${index}`, color, wrap: "truncate-end" }, `${label}: ${entry.content}`);
          })),
        ),
        React.createElement(Box, { borderStyle: "single", paddingX: 1, marginTop: 1 },
          React.createElement(Text, { color: isSending ? "yellow" : "white" }, isSending ? "Sending..." : promptLine),
        ),
      ),
      React.createElement(Box, { flexDirection: "column", width: 34 },
        React.createElement(Text, { color: focus === "runtime" ? "cyan" : "gray", bold: focus === "runtime" }, "2 Runtime"),
        React.createElement(Text, null, `Adapter  ${text(runtime.adapter)}`),
        React.createElement(Text, null, `Provider ${text(runtime.provider)}`),
        React.createElement(Text, null, `Model    ${text(runtime.model)}`),
        React.createElement(Text, null, `Mode     ${text(runtime.autonomy_mode ?? runtime.mode)}`),
        React.createElement(Text, null, `Scope    ${text(project.mode ?? project.scope)}`),
        React.createElement(Text, null, `Selected ${selected}`),
        React.createElement(Text, { color: focus === "plans" ? "cyan" : "gray", bold: focus === "plans", wrap: "truncate-end" }, `3 Plans (${planRows.length})`),
        ...(planRows.length > 0 ? planRows.slice(0, Math.max(3, height - 15)).map((plan) => {
          const id = text(plan.id ?? plan.plan_id);
          const marker = id === selected ? "*" : " ";
          const operational = asRecord(plan.operational_state);
          return React.createElement(Text, { key: id, wrap: "truncate-end" }, `${marker} ${text(operational.plan_lifecycle ?? plan.status)} ${text(plan.title ?? plan.name)}`);
        }) : [React.createElement(Text, { key: "none" }, "No plans found.")]),
      ),
    ),
    React.createElement(Box, { justifyContent: "space-between" },
      React.createElement(Text, { color: "gray" }, "Enter send  Tab focus  1 chat  2 runtime  3 plans"),
      React.createElement(Text, { color: "gray" }, "Ctrl-C quit"),
    ),
  );
}

async function renderArchitectRichTui(client: ArchitectClientOptions, status: Record<string, unknown>, plans: Record<string, unknown>): Promise<void> {
  const instance = render(React.createElement(ArchitectTuiApp, { client, status, plans }));
  await instance.waitUntilExit();
}

function mcpTextPayload(payload: { content?: Array<{ text?: string }> }): string {
  return payload.content?.map((entry) => entry.text ?? "").filter(Boolean).join("\n") ?? "";
}

async function callArchitectMcp(client: ArchitectClientOptions, tool: string, args: Record<string, unknown>, jsonOutput: boolean): Promise<void> {
  const result = await mcpCallTool(client.port, tool, args, 60_000);
  const content = mcpTextPayload(result);
  if (jsonOutput) {
    console.log(content || JSON.stringify(result, null, 2));
    return;
  }
  console.log(content || "No MCP result content returned.");
}

function configInputFromFlags(flags: ParsedArgs["flags"]): SetArchitectConfigInput {
  return {
    adapter: flagString(flags, "adapter"),
    provider: flagString(flags, "provider"),
    model: flagString(flags, "model"),
    autonomyMode: flagString(flags, "autonomy"),
  };
}

function hasConfigSetInput(input: SetArchitectConfigInput): boolean {
  return input.adapter != null || input.provider != null || input.model != null || input.autonomyMode != null;
}

async function getArchitectStatusWithRuntime(client: ArchitectClientOptions): Promise<Record<string, unknown>> {
  const status = await getArchitectPulse(client);
  if (Object.keys(runtimeFromStatusPayload(status)).length > 0) return status;

  const config = await getArchitectConfig(client);
  const result = asRecord(config.result);
  return {
    ...status,
    runtime: config.runtime ?? config.architect_runtime ?? result.runtime,
    architect_runtime: config.architect_runtime ?? config.runtime ?? result.runtime,
    architect_llm: config.architect_llm,
  };
}

export async function cmdArchitect(
  positional: string[],
  flags: ParsedArgs["flags"],
): Promise<void> {
  const invocation = parseArchitectInvocation(positional);
  const jsonOutput = flags.json === true;

  if (flags.help || flags.h || invocation.command === "help") {
    printArchitectUsage();
    return;
  }

  const client = await resolveArchitectClient(invocation, flags);

  if (invocation.command === "status") {
    const payload = await getArchitectStatusWithRuntime(client);
    jsonOutput ? printJson(payload) : printStatus(payload);
    return;
  }

  if (invocation.command === "plans") {
    const payload = await listArchitectPlans(client);
    jsonOutput ? printJson(payload) : printPlans(payload);
    return;
  }

  if (invocation.command === "chat") {
    const message = flagString(flags, "message") ?? invocation.args.join(" ").trim();
    if (!message) throw new Error("Usage: dg architect chat --message <text> [--plan <id>] [--scope project|plan] [--stream] [--json-events] [--json]");
    const stream = flags.stream === true || flags["json-events"] === true || !jsonOutput;
    const payload = await postArchitectChat(client, {
      ...configInputFromFlags(flags),
      message,
      planId: flagString(flags, "plan"),
      scope: flagString(flags, "scope") === "plan" ? "plan" : flagString(flags, "scope") === "project" ? "project" : undefined,
      continuationToken: flagString(flags, "continuation-token") ?? flagString(flags, "continuationToken"),
      stream,
      rawEvents: flags["raw-events"] === true,
    });
    if (flags["json-events"] === true && "events" in payload) {
      printJsonEvents(payload.events as Array<{ type: string; data: unknown }>);
      return;
    }
    const chatPayload = "result" in payload && payload.result && typeof payload.result === "object"
      ? payload.result as Record<string, unknown>
      : payload as Record<string, unknown>;
    jsonOutput ? printJson(redactArchitectValue(payload)) : printChatPayload(chatPayload);
    return;
  }

  if (invocation.command === "run") {
    const [subcommand] = invocation.args;
    const action = subcommand === "cancel" ? "stop" : subcommand;
    if (!action || !["stop", "pause", "resume"].includes(action)) {
      throw new Error("Usage: dg architect run cancel|pause|resume [--session <id>] [--json]");
    }
    const payload = await postArchitectCommand(client, {
      command: action,
      args: flagString(flags, "session") ? [flagString(flags, "session") as string] : [],
      planId: flagString(flags, "plan"),
      auditReason: flagString(flags, "reason"),
    });
    jsonOutput ? printJson(payload) : printPlanLifecycleResult({ result: asRecord(payload.result ?? payload) });
    return;
  }

  if (invocation.command === "trace") {
    const payload = await getArchitectEvents(client);
    jsonOutput || flags["raw-events"] === true ? printJson(redactArchitectValue(payload)) : printTrace(payload);
    return;
  }

  if (invocation.command === "adr") {
    const [subcommand, adrId] = invocation.args;
    if (subcommand === "list" || !subcommand) {
      const payload = await listArchitectAdrs(client);
      jsonOutput ? printJson(payload) : printAdrList(payload);
      return;
    }
    if (subcommand === "show" && adrId) {
      const payload = await getArchitectAdr(client, adrId);
      jsonOutput ? printJson(payload) : printJson(redactArchitectValue(payload));
      return;
    }
    if (subcommand === "bindings") {
      const planId = flagString(flags, "plan") ?? adrId;
      if (!planId) throw new Error("Usage: dg architect adr bindings --plan <plan-id> [--json]");
      const payload = await getArchitectPlan(client, planId);
      if (jsonOutput) printJson(payload);
      else printPlanDetail(payload, "adrs");
      return;
    }
    throw new Error("Usage: dg architect adr list|show|bindings [<adr-id>] [--plan <id>] [--json]");
  }

  if (invocation.command === "graph") {
    const [subcommand, ...rest] = invocation.args;
    const query = rest.join(" ").trim() || flagString(flags, "query") || flagString(flags, "name");
    if (subcommand === "search") {
      if (!query) throw new Error("Usage: dg architect graph search <query> [--json]");
      await callArchitectMcp(client, "query_resource", { uri: "system://index", filter: { name: query } }, jsonOutput);
      return;
    }
    if (subcommand === "workflow") {
      if (!query) throw new Error("Usage: dg architect graph workflow <workflow-id> [--json]");
      await callArchitectMcp(client, "get_workflow", { name: query }, jsonOutput);
      return;
    }
    if (subcommand === "data-model" || subcommand === "data") {
      await callArchitectMcp(client, "query_resource", { uri: "system://data-model", ...(query ? { filter: { name: query } } : {}) }, jsonOutput);
      return;
    }
    throw new Error("Usage: dg architect graph search|workflow|data-model <query> [--json]");
  }

  if (invocation.command === "schedule") {
    const [subcommand, scheduleId] = invocation.args;
    if (!subcommand || subcommand === "list" || subcommand === "history") {
      const payload = await getArchitectSchedules(client);
      jsonOutput ? printJson(payload) : printSchedules(payload);
      return;
    }
    const action = subcommand === "run" ? "run_now" : subcommand;
    if (!scheduleId || !["run_now", "pause", "resume"].includes(action)) {
      throw new Error("Usage: dg architect schedule list|history|run|pause|resume [<schedule-id>] [--plan <id>] [--json]");
    }
    const payload = await postArchitectScheduleAction(client, scheduleId, {
      action: action as "run_now" | "pause" | "resume",
      planId: flagString(flags, "plan"),
      sliceId: flagString(flags, "slice"),
      auditReason: flagString(flags, "reason") ?? `Operator requested scheduler ${action} from dg architect schedule.`,
    });
    jsonOutput ? printJson(payload) : printPlanLifecycleResult(payload);
    return;
  }

  if (invocation.command === "future") {
    const [planId] = invocation.args;
    if (!planId) throw new Error("Usage: dg architect future <plan-id> [--decide accept|reject|defer|supersede] [--reason <text>] [--json]");
    const decision = flagString(flags, "decide");
    if (decision) {
      const reason = flagString(flags, "reason");
      if (!reason) throw new Error("Future-review decisions require --reason <text>");
      const payload = await decideArchitectFutureReview(client, planId, decision, reason);
      jsonOutput ? printJson(payload) : printPlanLifecycleResult(payload);
      return;
    }
    const payload = await getArchitectFutureReview(client, planId);
    jsonOutput ? printJson(payload) : printFutureReview(payload);
    return;
  }

  if (invocation.command === "tui") {
    const status = await getArchitectStatusWithRuntime(client);
    const plans = await listArchitectPlans(client);
    if (jsonOutput) {
      printJson({ ok: true, mode: "ink-rich-tui", status, plans });
      return;
    }
    if (process.stdout.isTTY) {
      await renderArchitectRichTui(client, status, plans);
      return;
    }
    console.log("Architect terminal shell (log mode)");
    printStatus(status);
    printPlans(plans);
    console.log("Use dg architect chat --message <text> --stream for live daemon chat output.");
    return;
  }

  if (invocation.command === "plan") {
    const [subcommand, planId] = invocation.args;
    if (subcommand === "show" && planId) {
      const payload = await getArchitectPlan(client, planId);
      if (jsonOutput) {
        printJson(payload);
        return;
      }
      const section = flagString(flags, "section") ?? "summary";
      printPlanDetail(payload, section);
      return;
    }

    if (subcommand === "create") {
      const title = flagString(flags, "title") ?? invocation.args.slice(1).join(" ").trim();
      if (!title) throw new Error("Usage: dg architect plan create --title <title> [--id <id>] [--json]");
      const payload = await createArchitectPlan(client, { title, id: flagString(flags, "id") });
      jsonOutput ? printJson(payload) : printPlanLifecycleResult(payload);
      return;
    }

    if (subcommand === "select") {
      const selection = planIdFromSelection(planId);
      if (selection === undefined) throw new Error("Usage: dg architect plan select <plan-id|null> [--json]");
      const payload = await selectArchitectPlan(client, selection);
      jsonOutput ? printJson(payload) : printPlanLifecycleResult(payload);
      return;
    }

    if (subcommand === "archive" && planId) {
      const payload = await archiveArchitectPlan(client, planId, { auditReason: flagString(flags, "reason") });
      jsonOutput ? printJson(payload) : printPlanLifecycleResult(payload);
      return;
    }

    throw new Error("Usage: dg architect plan <show|create|select|archive> ... [--json]");
  }

  if (invocation.command === "config") {
    const [subcommand] = invocation.args;
    if (subcommand === "get") {
      const payload = await getArchitectConfig(client);
      jsonOutput ? printJson(payload) : printConfig(payload);
      return;
    }

    if (subcommand === "set") {
      const input = configInputFromFlags(flags);
      if (!hasConfigSetInput(input)) {
        throw new Error("Usage: dg architect config set [--adapter <id>] [--provider <id>] [--model <id>] [--autonomy <mode>] [--json]");
      }
      const payload = await setArchitectConfig(client, input);
      const result = asRecord(payload.result);
      const runtime = asRecord(payload.runtime ?? payload.architect_runtime ?? result.runtime);
      const readinessPayload = await getArchitectProviderReadiness(client, {
        adapter: text(runtime.adapter ?? result.adapter, input.adapter),
        provider: text(runtime.provider ?? result.provider, input.provider),
        model: text(runtime.model ?? result.model, input.model),
      });
      const combined = { ...payload, readiness: readinessPayload.readiness };
      jsonOutput ? printJson(combined) : printConfig(combined);
      return;
    }

    throw new Error("Usage: dg architect config <get|set> ... [--json]");
  }

  printArchitectUsage();
}
