import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

async function readSource(path: string): Promise<string> {
  return await readFile(new URL(path, import.meta.url), "utf8");
}

describe("Architect nested route regression", () => {
  it("dispatches nested /architect paths through the daemon router", async () => {
    const source = await readSource("../src/index.ts");

    expect(source).toContain('url.pathname.startsWith("/architect/")');
  });
});
