import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createInstance } from "../src/instance/lifecycle.js";
import { cmdAttach } from "../src/cli/commands/attach.js";

const tempRoots: string[] = [];

async function freshRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "dreamgraph-plans-scaffold-"));
  tempRoots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("project plans scaffold", () => {
  it("creates plans when an instance is initialized with a project", async () => {
    const root = await freshRoot();
    const projectRoot = join(root, "new-project");

    await createInstance({
      name: "new-project",
      masterDir: join(root, "master"),
      projectRoot,
      transport: { type: "http" },
    });

    expect(existsSync(join(projectRoot, "plans"))).toBe(true);
  });

  it("creates plans when an existing instance is attached to a project", async () => {
    const root = await freshRoot();
    const masterDir = join(root, "master");
    const projectRoot = join(root, "existing-project");
    const { instance } = await createInstance({
      name: "existing-project",
      masterDir,
      transport: { type: "http" },
    });

    await cmdAttach([projectRoot], { instance: instance.name, "master-dir": masterDir });

    expect(existsSync(join(projectRoot, "plans"))).toBe(true);
  });
});
