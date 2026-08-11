import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  connect: vi.fn(),
  callTool: vi.fn(),
  close: vi.fn(),
}));

vi.mock("@modelcontextprotocol/sdk/client/index.js", () => ({
  Client: class MockClient {
    connect = mocks.connect;
    callTool = mocks.callTool;
    close = mocks.close;
  },
}));

vi.mock("@modelcontextprotocol/sdk/client/streamableHttp.js", () => ({
  StreamableHTTPClientTransport: class MockTransport {
    constructor(readonly url: URL) {}
  },
}));

import { mcpCallTool } from "../src/cli/utils/mcp-call.js";

describe("mcpCallTool progress-aware timeout", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.connect.mockResolvedValue(undefined);
    mocks.close.mockResolvedValue(undefined);
  });

  it("requests progress and treats timeout as resettable inactivity, not a total wall clock", async () => {
    const observed: string[] = [];
    mocks.callTool.mockImplementation(async (_params, _schema, options) => {
      options.onprogress({ progress: 3, total: 10, message: "batch persisted" });
      return { content: [{ type: "text", text: "{}" }] };
    });

    await mcpCallTool(6401, "scan_project", {}, 7_200_000, (update) => {
      if (update.message) observed.push(update.message);
    });

    const options = mocks.callTool.mock.calls[0][2];
    expect(options).toMatchObject({
      timeout: 7_200_000,
      resetTimeoutOnProgress: true,
      onprogress: expect.any(Function),
    });
    expect(options).not.toHaveProperty("maxTotalTimeout");
    expect(observed).toEqual(["batch persisted"]);
    expect(mocks.close).toHaveBeenCalledOnce();
  });
});
