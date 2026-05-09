/**
 * M6 closure — policy proposal seam (§4.6).
 *
 * Verifies:
 *   1. capability + effect present, weakens=false → proposal journaled to
 *      `plugin_policy_proposals.json` with `source: "plugin:<id>"`.
 *   2. capability missing → `policy_capability_missing`, no journal entry.
 *   3. weakens=true → `policy_weakening_rejected`, no journal entry.
 *   4. unloadPluginById prunes proposals owned by the plugin.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  _resetPluginManagerForTest,
  bootstrapPlugins,
  unloadPluginById,
} from "../../src/plugins/manager.js";
import { graphEventBus, type GraphEvent } from "../../src/graph/events.js";
import * as lifecycle from "../../src/instance/lifecycle.js";
import { InstanceScope } from "../../src/instance/scope.js";
import { setDataDirOverride } from "../../src/utils/paths.js";

const FAKE_UUID = "11111111-2222-3333-4444-aaaaaaaaaaaa";
let masterDir: string;
let scope: InstanceScope;
let dataDir: string;

async function makeMaster(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "dg-plugin-policy-"));
  await mkdir(join(dir, FAKE_UUID, "plugins"), { recursive: true });
  await mkdir(join(dir, FAKE_UUID, "data"), { recursive: true });
  await writeFile(
    join(dir, FAKE_UUID, "instance.json"),
    JSON.stringify({ uuid: FAKE_UUID, name: "test", plugins: [] }, null, 2),
  );
  return dir;
}

async function readProposals(): Promise<Array<Record<string, unknown>>> {
  const p = join(dataDir, "plugin_policy_proposals.json");
  if (!existsSync(p)) return [];
  const raw = JSON.parse(await readFile(p, "utf-8"));
  return Array.isArray(raw.proposals) ? raw.proposals : [];
}

async function writePlugin(
  pluginId: string,
  manifestExtras: Record<string, unknown>,
  script: string,
): Promise<void> {
  const pluginDir = join(masterDir, FAKE_UUID, "plugins", pluginId);
  await mkdir(pluginDir, { recursive: true });
  await writeFile(
    join(pluginDir, "plugin.json"),
    JSON.stringify(
      {
        id: pluginId,
        version: "0.1.0",
        displayName: pluginId,
        engine: { dreamgraph: ">=9.0.0" },
        main: "./index.js",
        intent: "policy seam test",
        ...manifestExtras,
      },
      null,
      2,
    ),
  );
  await writeFile(
    join(pluginDir, "index.js"),
    `export default function activate(ctx) { ${script} return {}; }\n`,
  );
  await writeFile(
    join(masterDir, FAKE_UUID, "instance.json"),
    JSON.stringify(
      {
        uuid: FAKE_UUID,
        name: "test",
        plugins: [{ path: "./plugins/" + pluginId, trusted: true }],
      },
      null,
      2,
    ),
  );
  process.env.DG_ALLOW_INPROCESS_PLUGINS = "true";
}

function collect(): { events: GraphEvent[]; off: () => void } {
  const events: GraphEvent[] = [];
  const off = graphEventBus.subscribe((e) => {
    if (typeof e.kind === "string" && e.kind.startsWith("plugin.")) events.push(e);
  });
  return { events, off };
}

async function flush(): Promise<void> {
  await new Promise((r) => setTimeout(r, 50));
}

beforeEach(async () => {
  _resetPluginManagerForTest();
  masterDir = await makeMaster();
  scope = new InstanceScope(FAKE_UUID, masterDir);
  dataDir = join(masterDir, FAKE_UUID, "data");
  setDataDirOverride(dataDir);
});

afterEach(async () => {
  vi.restoreAllMocks();
  _resetPluginManagerForTest();
  delete process.env.DG_ALLOW_INPROCESS_PLUGINS;
  setDataDirOverride(null as unknown as string);
  await rm(masterDir, { recursive: true, force: true });
});

describe("plugin policy seam (M6 closure)", () => {
  it("journals a proposal when capability + effect declared", async () => {
    await writePlugin(
      "examples.policy-ok",
      {
        capabilities: ["policy:propose"],
        expectedEffects: ["propose_policy"],
        policies: [{ id: "no-undeclared-write" }],
      },
      `ctx.policies.propose({
        id: "no-undeclared-write",
        title: "No undeclared writes",
        rationale: "all writes must be in expectedEffects",
        applies_to: ["plugin"],
        phases: [{ phase: "design", permission: "required" }],
        severity: "warn",
      });`,
    );
    vi.spyOn(lifecycle, "getActiveScope").mockReturnValue(scope);
    const { events, off } = collect();
    try {
      await bootstrapPlugins();
      await flush();
      const proposals = await readProposals();
      expect(proposals.length).toBe(1);
      expect(proposals[0].proposal_id).toBe("examples.policy-ok:no-undeclared-write");
      expect(proposals[0].source).toBe("plugin:examples.policy-ok");
      expect(proposals[0].status).toBe("proposed");
      const accepted = events.find(
        (e) =>
          e.kind === "plugin.output.accepted" &&
          (e.payload as { seam?: string })?.seam === "policy",
      );
      expect(accepted).toBeDefined();
    } finally {
      off();
    }
  });

  it("rejects when policy:propose capability is missing", async () => {
    await writePlugin(
      "examples.policy-no-cap",
      {
        capabilities: ["events:read"],
        expectedEffects: ["propose_policy"],
      },
      `try { ctx.policies.propose({
        id: "x", title: "x", rationale: "x", applies_to: ["plugin"], phases: [], severity: "info",
      }); } catch (_) {}`,
    );
    vi.spyOn(lifecycle, "getActiveScope").mockReturnValue(scope);
    const { events, off } = collect();
    try {
      await bootstrapPlugins();
      await flush();
      expect((await readProposals()).length).toBe(0);
      const rej = events.find(
        (e) =>
          e.kind === "plugin.output.rejected" &&
          (e.payload as { reason?: string })?.reason === "policy_capability_missing",
      );
      expect(rej).toBeDefined();
    } finally {
      off();
    }
  });

  it("rejects proposals with weakens=true", async () => {
    await writePlugin(
      "examples.policy-weak",
      {
        capabilities: ["policy:propose"],
        expectedEffects: ["propose_policy"],
        policies: [{ id: "loosen" }],
      },
      `try { ctx.policies.propose({
        id: "loosen", title: "loosen", rationale: "weaker", applies_to: ["plugin"], phases: [], severity: "info", weakens: true,
      }); } catch (_) {}`,
    );
    vi.spyOn(lifecycle, "getActiveScope").mockReturnValue(scope);
    const { events, off } = collect();
    try {
      await bootstrapPlugins();
      await flush();
      expect((await readProposals()).length).toBe(0);
      const rej = events.find(
        (e) =>
          e.kind === "plugin.output.rejected" &&
          (e.payload as { reason?: string })?.reason === "policy_weakening_rejected",
      );
      expect(rej).toBeDefined();
    } finally {
      off();
    }
  });

  it("unloadPluginById prunes plugin-owned proposals", async () => {
    await writePlugin(
      "examples.policy-prune",
      {
        capabilities: ["policy:propose"],
        expectedEffects: ["propose_policy"],
        policies: [{ id: "alpha" }],
      },
      `ctx.policies.propose({
        id: "alpha", title: "a", rationale: "r", applies_to: ["plugin"], phases: [], severity: "info",
      });`,
    );
    vi.spyOn(lifecycle, "getActiveScope").mockReturnValue(scope);
    await bootstrapPlugins();
    await flush();
    expect((await readProposals()).length).toBe(1);
    await unloadPluginById("examples.policy-prune", "disable");
    expect((await readProposals()).length).toBe(0);
  });
});
