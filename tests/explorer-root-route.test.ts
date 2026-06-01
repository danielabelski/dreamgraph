import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

async function readSource(path: string): Promise<string> {
  return await readFile(new URL(path, import.meta.url), "utf8");
}

describe("Explorer root route regression", () => {
  it("dispatches both /explorer and /explorer/ through the daemon router", async () => {
    const source = await readSource("../src/index.ts");

    expect(source).toContain(
      'url.pathname === "/explorer" || url.pathname.startsWith("/explorer/")',
    );
  });

  it("maps both Explorer root spellings to the SPA index", async () => {
    const source = await readSource("../src/explorer/static.ts");

    expect(source).toContain(
      'const rel = pathname.replace(/^\\/explorer/, "") || "/";',
    );
    expect(source).toContain('if (rel === "/" || rel === "") {');
  });
});
