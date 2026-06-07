import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { describe, expect, it } from "vitest";

import { parseArchitectInvocation, runtimeFromStatusPayload } from "../src/cli/commands/architect.js";
import {
  ArchitectDaemonError,
  architectRequest,
  archiveArchitectPlan,
  createArchitectPlan,
  decideArchitectFutureReview,
  getArchitectConfig,
  getArchitectFutureReview,
  getArchitectPlan,
  getArchitectProviderReadiness,
  getArchitectPulse,
  getArchitectSchedules,
  listArchitectAdrs,
  listArchitectPlans,
  parseArchitectSse,
  postArchitectChat,
  postArchitectCommand,
  postArchitectScheduleAction,
  redactArchitectValue,
  selectArchitectPlan,
  setArchitectConfig,
} from "../src/cli/utils/architect-client.js";

async function withMockServer<T>(
  handler: Parameters<typeof createServer>[0],
  run: (port: number) => Promise<T>,
): Promise<T> {
  const server: Server = createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address() as AddressInfo;
    return await run(address.port);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
}

describe("dg architect invocation parser", () => {
  it("extracts status runtime from current and legacy pulse payload shapes", () => {
    expect(runtimeFromStatusPayload({
      ok: true,
      runtime: { adapter: "codex-cli", provider: "none", model: "gpt-5.5", execution_route: "codex-cli" },
      pulse: {},
    })).toMatchObject({ adapter: "codex-cli", provider: "none", model: "gpt-5.5", execution_route: "codex-cli" });

    expect(runtimeFromStatusPayload({
      ok: true,
      pulse: { runtime: { adapter: "copilot-cli", provider: "none", model: "gpt-5.4", execution_route: "copilot-cli" } },
    })).toMatchObject({ adapter: "copilot-cli", provider: "none", model: "gpt-5.4", execution_route: "copilot-cli" });
  });

  it("defaults to status when no subcommand is supplied", () => {
    expect(parseArchitectInvocation([])).toEqual({ command: "status", args: [] });
    expect(parseArchitectInvocation(["project-a"])).toEqual({ instance: "project-a", command: "status", args: [] });
  });

  it("supports command-first and instance-first routing", () => {
    expect(parseArchitectInvocation(["plans"])).toEqual({ command: "plans", args: [] });
    expect(parseArchitectInvocation(["project-a", "plans", "--ignored-by-parser"])).toEqual({
      instance: "project-a",
      command: "plans",
      args: ["--ignored-by-parser"],
    });
    expect(parseArchitectInvocation(["plan", "show", "architect-cli"])).toEqual({
      command: "plan",
      args: ["show", "architect-cli"],
    });
    expect(parseArchitectInvocation(["project-a", "plan", "create"])).toEqual({
      instance: "project-a",
      command: "plan",
      args: ["create"],
    });
    expect(parseArchitectInvocation(["chat", "hello"])).toEqual({ command: "chat", args: ["hello"] });
    expect(parseArchitectInvocation(["tui"])).toEqual({ command: "tui", args: [] });
    expect(parseArchitectInvocation(["project-a", "tui"])).toEqual({ instance: "project-a", command: "tui", args: [] });
    expect(parseArchitectInvocation(["project-a", "future", "architect-cli"])).toEqual({
      instance: "project-a",
      command: "future",
      args: ["architect-cli"],
    });
  });
});

describe("Architect daemon client", () => {
  it("calls Architect read and lifecycle endpoints with daemon-owned payloads", async () => {
    const seen: Array<{ method: string; url: string; body: string }> = [];
    await withMockServer((req, res) => {
      let body = "";
      req.setEncoding("utf8");
      req.on("data", (chunk) => { body += chunk; });
      req.on("end", () => {
        seen.push({ method: req.method ?? "", url: req.url ?? "", body });
        res.setHeader("content-type", "application/json; charset=utf-8");
        if (req.url === "/api/architect/v1/pulse") res.end(JSON.stringify({ ok: true, pulse: { runtime: { adapter: "codex-cli" } } }));
        else if (req.url === "/api/architect/v1/plans" && req.method === "GET") res.end(JSON.stringify({ ok: true, plans: [{ id: "architect-cli" }] }));
        else if (req.url === "/api/architect/v1/plans/architect-cli" && req.method === "GET") res.end(JSON.stringify({ ok: true, plan: { id: "architect-cli" } }));
        else if (req.url === "/api/architect/v1/plans" && req.method === "POST") res.end(JSON.stringify({ ok: true, result: { plan_id: "long-title", status: "created" } }));
        else if (req.url === "/api/architect/v1/selection") res.end(JSON.stringify({ ok: true, result: { selected_plan_id: null } }));
        else if (req.url === "/api/architect/v1/plans/architect-cli/archive") res.end(JSON.stringify({ ok: true, result: { plan_id: "architect-cli", status: "archived" } }));
        else if (req.url === "/api/architect/v1/config") res.end(JSON.stringify({ ok: true, runtime: { adapter: "codex-cli" } }));
        else if (req.url === "/api/architect/v1/provider-readiness") res.end(JSON.stringify({ ok: true, readiness: { ready: true, kind: "api" } }));
        else if (req.url === "/api/architect/v1/chat") res.end(JSON.stringify({ ok: true, result: { content: "hello", tool_trace: [], route: { execution_route: "codex-cli" } } }));
        else if (req.url === "/api/architect/v1/commands") res.end(JSON.stringify({ ok: true, result: { status: "recorded", action: "pause" } }));
        else if (req.url === "/api/architect/v1/adrs") res.end(JSON.stringify({ ok: true, adrs: [{ id: "ADR-001" }] }));
        else if (req.url === "/api/architect/v1/plans/architect-cli/future-review") res.end(JSON.stringify({ ok: true, future_review: { status: "ready", candidates: [] } }));
        else if (req.url === "/api/architect/v1/plans/architect-cli/review-gates") res.end(JSON.stringify({ ok: true, result: { status: "recorded", decision: "accept" } }));
        else if (req.url === "/api/architect/v1/schedules") res.end(JSON.stringify({ ok: true, scheduler: { total: 1 }, schedules: [{ id: "nightly" }] }));
        else if (req.url === "/api/architect/v1/schedules/nightly/actions") res.end(JSON.stringify({ ok: true, result: { schedule_id: "nightly", action: "run_now" } }));
        else {
          res.statusCode = 404;
          res.end(JSON.stringify({ ok: false, error: "not_found", message: "missing" }));
        }
      });
    }, async (port) => {
      const client = { port };
      await expect(getArchitectPulse(client)).resolves.toMatchObject({ pulse: { runtime: { adapter: "codex-cli" } } });
      await expect(listArchitectPlans(client)).resolves.toMatchObject({ plans: [{ id: "architect-cli" }] });
      await expect(getArchitectPlan(client, "architect-cli")).resolves.toMatchObject({ plan: { id: "architect-cli" } });
      await expect(createArchitectPlan(client, { title: "A very long plan title with spaces", id: "long-title" })).resolves.toMatchObject({ result: { status: "created" } });
      await expect(selectArchitectPlan(client, "architect-cli")).resolves.toMatchObject({ result: { selected_plan_id: null } });
      await expect(selectArchitectPlan(client, null)).resolves.toMatchObject({ result: { selected_plan_id: null } });
      await expect(archiveArchitectPlan(client, "architect-cli", { auditReason: "retired from CLI" })).resolves.toMatchObject({ result: { status: "archived" } });
      await expect(getArchitectConfig(client)).resolves.toMatchObject({ runtime: { adapter: "codex-cli" } });
      await expect(setArchitectConfig(client, { adapter: "native_api_tool_loop", provider: "openai", model: "gpt-5.5", autonomyMode: "autonomous" })).resolves.toMatchObject({ runtime: { adapter: "codex-cli" } });
      await expect(getArchitectProviderReadiness(client, { adapter: "native_api_tool_loop", provider: "openai", model: "gpt-5.5" })).resolves.toMatchObject({ readiness: { ready: true } });
      await expect(postArchitectChat(client, { message: "hello", planId: "architect-cli", scope: "plan" })).resolves.toMatchObject({ result: { content: "hello" } });
      await expect(postArchitectCommand(client, { command: "pause" })).resolves.toMatchObject({ result: { action: "pause" } });
      await expect(listArchitectAdrs(client)).resolves.toMatchObject({ adrs: [{ id: "ADR-001" }] });
      await expect(getArchitectFutureReview(client, "architect-cli")).resolves.toMatchObject({ future_review: { status: "ready" } });
      await expect(decideArchitectFutureReview(client, "architect-cli", "accept", "looks right")).resolves.toMatchObject({ result: { decision: "accept" } });
      await expect(getArchitectSchedules(client)).resolves.toMatchObject({ schedules: [{ id: "nightly" }] });
      await expect(postArchitectScheduleAction(client, "nightly", { action: "run_now", auditReason: "smoke" })).resolves.toMatchObject({ result: { action: "run_now" } });
    });

    expect(seen.map((entry) => `${entry.method} ${entry.url}`)).toEqual([
      "GET /api/architect/v1/pulse",
      "GET /api/architect/v1/plans",
      "GET /api/architect/v1/plans/architect-cli",
      "POST /api/architect/v1/plans",
      "POST /api/architect/v1/selection",
      "POST /api/architect/v1/selection",
      "POST /api/architect/v1/plans/architect-cli/archive",
      "POST /api/architect/v1/config",
      "POST /api/architect/v1/config",
      "POST /api/architect/v1/provider-readiness",
      "POST /api/architect/v1/chat",
      "POST /api/architect/v1/commands",
      "GET /api/architect/v1/adrs",
      "GET /api/architect/v1/plans/architect-cli/future-review",
      "POST /api/architect/v1/plans/architect-cli/review-gates",
      "GET /api/architect/v1/schedules",
      "POST /api/architect/v1/schedules/nightly/actions",
    ]);
    expect(JSON.parse(seen[3].body)).toEqual({ title: "A very long plan title with spaces", id: "long-title", actor: "dreamgraph-cli" });
    expect(JSON.parse(seen[4].body)).toEqual({ plan_id: "architect-cli", actor: "dreamgraph-cli" });
    expect(JSON.parse(seen[5].body)).toEqual({ clear: true, actor: "dreamgraph-cli" });
    expect(JSON.parse(seen[6].body)).toMatchObject({ audit_reason: "retired from CLI", actor: "dreamgraph-cli", slice_id: "slice-2-plan-lifecycle-commands" });
    expect(seen[7].body).toBe("{}");
    expect(JSON.parse(seen[8].body)).toEqual({ adapter: "native_api_tool_loop", provider: "openai", model: "gpt-5.5", autonomy_mode: "autonomous" });
    expect(JSON.parse(seen[9].body)).toEqual({ adapter: "native_api_tool_loop", provider: "openai", model: "gpt-5.5" });
    expect(JSON.parse(seen[10].body)).toEqual({ message: "hello", plan_id: "architect-cli", scope: "plan" });
    expect(JSON.parse(seen[11].body)).toEqual({ command: "pause", args: [], actor: "dreamgraph-cli" });
    expect(JSON.parse(seen[14].body)).toMatchObject({ action: "future_review_decision", decision: "accept", audit_reason: "looks right", actor: "dreamgraph-cli" });
    expect(JSON.parse(seen[16].body)).toEqual({ action: "run_now", audit_reason: "smoke", actor: "dreamgraph-cli" });
  });

  it("does not apply the short daemon request timeout to streaming chat", async () => {
    await withMockServer((req, res) => {
      req.resume();
      req.on("end", () => {
        setTimeout(() => {
          res.setHeader("content-type", "text/event-stream; charset=utf-8");
          res.end([
            ": architect-chat",
            "",
            "event: architect.chat.result",
            "data: {\"ok\":true,\"result\":{\"content\":\"done\"}}",
            "",
          ].join("\n"));
        }, 25);
      });
    }, async (port) => {
      await expect(postArchitectChat({ port, timeoutMs: 1 }, { message: "hello", stream: true })).resolves.toMatchObject({
        ok: true,
        transport: "sse",
        result: { ok: true, result: { content: "done" } },
      });
    });
  });

  it("parses streaming chat events and redacts sensitive details", async () => {
    const sse = [
      ": architect-chat",
      "",
      "event: architect.chat.status",
      "data: {\"phase\":\"completed\",\"api_key\":\"sk-test-secret-value\"}",
      "",
      "event: architect.chat.result",
      "data: {\"ok\":true,\"result\":{\"content\":\"done\",\"continuation_token\":\"abc\"}}",
      "",
      "event: architect.heartbeat",
      "data: {\"noop\":true}",
      "",
    ].join("\n");

    expect(parseArchitectSse(sse)).toEqual([
      { type: "status", data: { phase: "completed", api_key: "[redacted]" } },
      { type: "result", data: { ok: true, result: { content: "done", continuation_token: "[redacted]" } } },
    ]);
    expect(redactArchitectValue({ Authorization: "Bearer abc", nested: { source: "sk-abcdefghijklmnop" } })).toEqual({
      Authorization: "[redacted]",
      nested: { source: "[redacted:api-key]" },
    });
  });

  it("posts runtime selector payloads without provider-side heuristics", async () => {
    const seen: Array<{ method: string; url: string; body: string }> = [];
    await withMockServer((req, res) => {
      let body = "";
      req.setEncoding("utf8");
      req.on("data", (chunk) => { body += chunk; });
      req.on("end", () => {
        seen.push({ method: req.method ?? "", url: req.url ?? "", body });
        res.setHeader("content-type", "application/json; charset=utf-8");
        const parsed = body ? JSON.parse(body) as Record<string, unknown> : {};
        if (req.url === "/api/architect/v1/config" && parsed.adapter === "native_api_tool_loop") {
          res.end(JSON.stringify({ ok: true, result: { persisted: true }, runtime: { adapter: "native_api_tool_loop", provider: parsed.provider, model: parsed.model, autonomy_mode: parsed.autonomy_mode, execution_route: "native_api_tool_loop" } }));
        } else if (req.url === "/api/architect/v1/config" && parsed.adapter === "codex-cli") {
          res.end(JSON.stringify({ ok: true, result: { persisted: false }, runtime: { adapter: "codex-cli", provider: "none", model: parsed.model, autonomy_mode: parsed.autonomy_mode, execution_route: "codex-cli" } }));
        } else if (req.url === "/api/architect/v1/config" && parsed.provider === "none") {
          res.end(JSON.stringify({ ok: true, result: { persisted: false }, runtime: { adapter: parsed.adapter ?? "native_api_tool_loop", provider: "none", model: "", autonomy_mode: parsed.autonomy_mode, execution_route: "deterministic_fallback" } }));
        } else {
          res.statusCode = 404;
          res.end(JSON.stringify({ ok: false, error: "not_found", message: "missing" }));
        }
      });
    }, async (port) => {
      const client = { port };
      await expect(setArchitectConfig(client, { adapter: "native_api_tool_loop", provider: "openai", model: "gpt-5.5", autonomyMode: "autonomous" })).resolves.toMatchObject({ runtime: { provider: "openai", execution_route: "native_api_tool_loop" } });
      await expect(setArchitectConfig(client, { adapter: "codex-cli", provider: "openai", model: "gpt-5.5", autonomyMode: "autonomous" })).resolves.toMatchObject({ runtime: { adapter: "codex-cli", provider: "none", execution_route: "codex-cli" }, result: { persisted: false } });
      await expect(setArchitectConfig(client, { provider: "none", autonomyMode: "manual" })).resolves.toMatchObject({ runtime: { provider: "none", execution_route: "deterministic_fallback" }, result: { persisted: false } });
    });

    expect(seen.map((entry) => `${entry.method} ${entry.url}`)).toEqual([
      "POST /api/architect/v1/config",
      "POST /api/architect/v1/config",
      "POST /api/architect/v1/config",
    ]);
    expect(JSON.parse(seen[0].body)).toEqual({ adapter: "native_api_tool_loop", provider: "openai", model: "gpt-5.5", autonomy_mode: "autonomous" });
    expect(JSON.parse(seen[1].body)).toEqual({ adapter: "codex-cli", provider: "openai", model: "gpt-5.5", autonomy_mode: "autonomous" });
    expect(JSON.parse(seen[2].body)).toEqual({ provider: "none", autonomy_mode: "manual" });
  });

  it("normalizes daemon error envelopes", async () => {
    await withMockServer((_req, res) => {
      res.statusCode = 503;
      res.setHeader("content-type", "application/json; charset=utf-8");
      res.end(JSON.stringify({ ok: false, error: "daemon_busy", message: "Architect is busy" }));
    }, async (port) => {
      await expect(architectRequest({ port }, "/api/architect/v1/pulse")).rejects.toMatchObject({
        name: "ArchitectDaemonError",
        statusCode: 503,
        code: "daemon_busy",
        message: "Architect is busy (daemon_busy)",
      } satisfies Partial<ArchitectDaemonError>);
    });
  });
});
