/**
 * Explorer prefs — load/save/coerce + endpoint contract tests.
 *
 * Slice A of plans/EXPLORER_3D_MODE.md. The prefs file is a tiny UI store,
 * but the contract matters: malformed input must never throw, the file
 * must round-trip cleanly, and the POST handler must shallow-merge so the
 * SPA can flip one field without re-sending the whole blob.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { IncomingMessage, ServerResponse } from "node:http";
import { setDataDirOverride, dataPath } from "../src/utils/paths.js";
import {
  coercePrefs,
  DEFAULT_PREFS,
  loadExplorerPrefs,
  patchExplorerPrefs,
  saveExplorerPrefs,
} from "../src/explorer/prefs.js";
import { handleExplorerRoute } from "../src/explorer/routes.js";

let tempDir: string;
let captured: { status?: number; headers?: Record<string, string>; body?: string };

interface MockReqOptions {
  method?: string;
  url?: string;
  body?: unknown;
}

function mockReq(opts: MockReqOptions = {}): IncomingMessage {
  const handlers = new Map<string, Array<(...args: unknown[]) => void>>();
  const req = {
    method: opts.method ?? "GET",
    url: opts.url ?? "/explorer/api/prefs",
    headers: {} as Record<string, string>,
    on(event: string, handler: (...args: unknown[]) => void) {
      const list = handlers.get(event) ?? [];
      list.push(handler);
      handlers.set(event, list);
      return this;
    },
  } as unknown as IncomingMessage;

  queueMicrotask(() => {
    const dataHandlers = handlers.get("data") ?? [];
    const endHandlers = handlers.get("end") ?? [];
    if (opts.body !== undefined) {
      const buf = Buffer.from(
        typeof opts.body === "string" ? opts.body : JSON.stringify(opts.body),
      );
      for (const h of dataHandlers) h(buf);
    }
    for (const h of endHandlers) h();
  });

  return req;
}

function mockRes(): ServerResponse {
  captured = {};
  const res = {
    writeHead(status: number, headers?: Record<string, string>) {
      captured.status = status;
      captured.headers = headers;
      return this;
    },
    end(body?: string) {
      captured.body = body;
      return this;
    },
  } as unknown as ServerResponse;
  return res;
}

async function waitForResponse(): Promise<void> {
  // Routes finish synchronously after the body is read; one microtask
  // turn is enough for our mockReq queueMicrotask emitter to drain.
  for (let i = 0; i < 20 && captured.body === undefined; i++) {
    await new Promise((r) => setTimeout(r, 5));
  }
}

describe("Explorer prefs — coercion", () => {
  it("returns defaults for non-objects", () => {
    expect(coercePrefs(null)).toEqual(DEFAULT_PREFS);
    expect(coercePrefs("garbage")).toEqual(DEFAULT_PREFS);
    expect(coercePrefs(42)).toEqual(DEFAULT_PREFS);
  });

  it("falls back to defaults for unknown renderMode", () => {
    expect(coercePrefs({ renderMode: "vr" }).renderMode).toBe("2d");
  });

  it("preserves valid renderMode + grid + bloom", () => {
    const out = coercePrefs({
      renderMode: "3d",
      showGrid3d: true,
      bloom3d: false,
    });
    expect(out.renderMode).toBe("3d");
    expect(out.showGrid3d).toBe(true);
    expect(out.bloom3d).toBe(false);
  });

  it("rejects malformed camera vectors", () => {
    const out = coercePrefs({
      camera3d: { position: [1, 2, "x"], target: null },
    });
    expect(out.camera3d).toEqual(DEFAULT_PREFS.camera3d);
  });

  it("preserves valid camera vectors", () => {
    const out = coercePrefs({
      camera3d: { position: [10, 20, 30], target: [1, 2, 3] },
    });
    expect(out.camera3d.position).toEqual([10, 20, 30]);
    expect(out.camera3d.target).toEqual([1, 2, 3]);
  });
});

describe("Explorer prefs — camera presets (Slice E3)", () => {
  it("defaults to an empty preset map", () => {
    expect(coercePrefs({}).cameraPresets3d).toEqual({});
    expect(DEFAULT_PREFS.cameraPresets3d).toEqual({});
  });

  it("preserves well-formed presets", () => {
    const out = coercePrefs({
      cameraPresets3d: {
        nodeA: { position: [1, 2, 3], target: [4, 5, 6] },
        nodeB: { position: [7, 8, 9], target: [0, 0, 0] },
      },
    });
    expect(out.cameraPresets3d.nodeA).toEqual({
      position: [1, 2, 3],
      target: [4, 5, 6],
    });
    expect(out.cameraPresets3d.nodeB.position).toEqual([7, 8, 9]);
  });

  it("drops malformed preset entries silently", () => {
    const out = coercePrefs({
      cameraPresets3d: {
        good: { position: [1, 2, 3], target: [4, 5, 6] },
        badVec: { position: [1, 2], target: [1, 2, 3] },
        notObj: "nope",
        missing: { position: [1, 2, 3] },
        "": { position: [1, 2, 3], target: [4, 5, 6] },
      },
    });
    expect(Object.keys(out.cameraPresets3d)).toEqual(["good"]);
  });

  it("ignores a non-object cameraPresets3d field", () => {
    expect(coercePrefs({ cameraPresets3d: "nope" }).cameraPresets3d).toEqual({});
    expect(coercePrefs({ cameraPresets3d: 42 }).cameraPresets3d).toEqual({});
    expect(coercePrefs({ cameraPresets3d: [1, 2, 3] }).cameraPresets3d).toEqual({});
  });

  it("caps the preset count to prevent unbounded growth", async () => {
    const presets: Record<string, { position: number[]; target: number[] }> = {};
    for (let i = 0; i < 1000; i++) {
      presets[`n${i}`] = { position: [i, 0, 0], target: [0, 0, 0] };
    }
    const out = coercePrefs({ cameraPresets3d: presets });
    expect(Object.keys(out.cameraPresets3d).length).toBeLessThanOrEqual(256);
    expect(Object.keys(out.cameraPresets3d).length).toBeGreaterThan(0);
  });
});

describe("Explorer prefs — layout mode (Slice E4)", () => {
  it("defaults to force layout", () => {
    expect(DEFAULT_PREFS.layoutMode3d).toBe("force");
    expect(coercePrefs({}).layoutMode3d).toBe("force");
  });

  it("preserves valid layoutMode3d values", () => {
    expect(coercePrefs({ layoutMode3d: "radial" }).layoutMode3d).toBe("radial");
    expect(coercePrefs({ layoutMode3d: "force" }).layoutMode3d).toBe("force");
  });

  it("falls back to default for unknown layoutMode3d", () => {
    expect(coercePrefs({ layoutMode3d: "spiral" }).layoutMode3d).toBe("force");
    expect(coercePrefs({ layoutMode3d: 42 }).layoutMode3d).toBe("force");
  });
});

describe("Explorer prefs — disk I/O", () => {
  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "dg-prefs-"));
    setDataDirOverride(tempDir);
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it("returns defaults when the file is missing", async () => {
    const prefs = await loadExplorerPrefs();
    expect(prefs).toEqual(DEFAULT_PREFS);
  });

  it("returns defaults when the file is malformed", async () => {
    await writeFile(dataPath("explorer_prefs.json"), "not json {", "utf-8");
    const prefs = await loadExplorerPrefs();
    expect(prefs).toEqual(DEFAULT_PREFS);
  });

  it("round-trips a saved value", async () => {
    const next = { ...DEFAULT_PREFS, renderMode: "3d" as const, showGrid3d: true };
    await saveExplorerPrefs(next);
    const reloaded = await loadExplorerPrefs();
    expect(reloaded.renderMode).toBe("3d");
    expect(reloaded.showGrid3d).toBe(true);
  });

  it("shallow-merges via patchExplorerPrefs", async () => {
    await saveExplorerPrefs({ ...DEFAULT_PREFS, renderMode: "3d" });
    const merged = await patchExplorerPrefs({ showGrid3d: true });
    expect(merged.renderMode).toBe("3d");
    expect(merged.showGrid3d).toBe(true);
  });

  it("ignores garbage in the patch payload", async () => {
    const merged = await patchExplorerPrefs({ renderMode: "hologram" });
    expect(merged.renderMode).toBe("2d");
  });

  it("round-trips camera presets through patch + reload", async () => {
    const merged = await patchExplorerPrefs({
      cameraPresets3d: {
        nodeA: { position: [10, 20, 30], target: [1, 2, 3] },
      },
    });
    expect(merged.cameraPresets3d.nodeA.position).toEqual([10, 20, 30]);
    const reloaded = await loadExplorerPrefs();
    expect(reloaded.cameraPresets3d.nodeA.target).toEqual([1, 2, 3]);
  });
});

describe("Explorer prefs — HTTP endpoints", () => {
  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "dg-prefs-http-"));
    setDataDirOverride(tempDir);
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it("GET /explorer/api/prefs returns defaults when file missing", async () => {
    const req = mockReq({ method: "GET" });
    const res = mockRes();
    const handled = await handleExplorerRoute(req, res, "/explorer/api/prefs");
    expect(handled).toBe(true);
    expect(captured.status).toBe(200);
    const body = JSON.parse(captured.body ?? "{}");
    expect(body.renderMode).toBe("2d");
    expect(body.version).toBe(1);
  });

  it("POST /explorer/api/prefs persists and returns merged value", async () => {
    const req = mockReq({
      method: "POST",
      body: { renderMode: "3d", showGrid3d: true },
    });
    const res = mockRes();
    const handled = await handleExplorerRoute(req, res, "/explorer/api/prefs");
    await waitForResponse();
    expect(handled).toBe(true);
    expect(captured.status).toBe(200);
    const body = JSON.parse(captured.body ?? "{}");
    expect(body.renderMode).toBe("3d");
    expect(body.showGrid3d).toBe(true);

    const onDisk = JSON.parse(
      await readFile(dataPath("explorer_prefs.json"), "utf-8"),
    );
    expect(onDisk.renderMode).toBe("3d");
  });

  it("POST /explorer/api/prefs with bad JSON returns 400", async () => {
    const req = mockReq({ method: "POST", body: "{not-json" });
    const res = mockRes();
    await handleExplorerRoute(req, res, "/explorer/api/prefs");
    await waitForResponse();
    expect(captured.status).toBe(400);
  });
});
