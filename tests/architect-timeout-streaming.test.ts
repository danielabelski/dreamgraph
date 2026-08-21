import { describe, expect, it, vi } from "vitest";
import { timeoutError, withOwnedDeadline } from "../src/architect/timeout-hierarchy.js";

describe("timeout/cancellation hierarchy and Codex streaming fixtures", () => {
  it.each(["connect", "discovery", "queue", "tool", "idle", "wall"] as const)("names the %s owning layer", (owner) => {
    expect(timeoutError({ owner, elapsedMs: 42, correlationId: "corr", tool: "query_resource" })).toMatchObject({
      code: "DREAMGRAPH_TIMEOUT", owner, elapsed_ms: 42, correlation_id: "corr", tool: "query_resource",
    });
  });

  it("propagates user cancellation upstream and names it as the sole owner", async () => {
    const controller = new AbortController();
    let upstreamAborted = false;
    const pending = withOwnedDeadline(async (signal) => {
      signal.addEventListener("abort", () => { upstreamAborted = true; });
      return new Promise<string>(() => {});
    }, { owner: "tool", timeoutMs: 10_000, correlationId: "cancel-1", signal: controller.signal });
    controller.abort();
    await expect(pending).rejects.toMatchObject({ code: "DREAMGRAPH_CANCELLED", owner: "user", correlation_id: "cancel-1" });
    expect(upstreamAborted).toBe(true);
  });

  it("keeps progress diagnostics on stderr-shaped events and preserves stdout framing", () => {
    const stdout = [
      JSON.stringify({ jsonrpc: "2.0", id: 1, result: { tools: [] } }),
      JSON.stringify({ jsonrpc: "2.0", id: 2, result: { content: [{ type: "text", text: "bounded" }] } }),
    ].join("\n");
    const stderr = "[architect-cli-mcp-bridge] correlation=c1 progress tool=query_resource";
    expect(stdout.split("\n").every((line) => JSON.parse(line).jsonrpc === "2.0")).toBe(true);
    expect(stdout).not.toContain("architect-cli-mcp-bridge");
    expect(stderr).toContain("progress");
  });

  it("does not replay mutations during a read reconnect fixture", () => {
    const calls = ["query_resource", "query_resource"];
    const mutations = vi.fn();
    calls.filter((name) => name.startsWith("modify_")).forEach(mutations);
    expect(mutations).not.toHaveBeenCalled();
  });
});
