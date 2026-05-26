import { describe, expect, it } from "vitest";

import { parseLinkArray } from "../../src/tools/wire-links.js";

function link(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    target: "target-1",
    relationship: "depends_on",
    direction: "downstream",
    description: "Source depends on target evidence.",
    evidence_excerpt: "shared source file and matching domain",
    confidence: 0.82,
    strength: "moderate",
    ...overrides,
  };
}

describe("wire_links strict link parsing", () => {
  it("accepts valid strict link selections and preserves evidence metadata", () => {
    const parsed = parseLinkArray(JSON.stringify({ links: [link()] }), new Set(["target-1"]));

    expect(parsed.errors).toEqual([]);
    expect(parsed.links).toHaveLength(1);
    expect(parsed.links[0]).toMatchObject({
      target: "target-1",
      relationship: "depends_on",
      strength: "moderate",
      meta: {
        direction: "downstream",
        evidence_excerpt: "shared source file and matching domain",
        confidence: 0.82,
      },
    });
  });

  it("rejects unknown target ids", () => {
    const parsed = parseLinkArray(JSON.stringify({ links: [link({ target: "missing" })] }), new Set(["target-1"]));

    expect(parsed.links).toEqual([]);
    expect(parsed.errors.join("\n")).toMatch(/invalid target/);
  });

  it("rejects invalid relationship vocabulary", () => {
    const parsed = parseLinkArray(JSON.stringify({ links: [link({ relationship: "magic" })] }), new Set(["target-1"]));

    expect(parsed.links).toEqual([]);
    expect(parsed.errors.join("\n")).toMatch(/invalid relationship/);
  });

  it("rejects excessive edge counts", () => {
    const parsed = parseLinkArray(
      JSON.stringify({ links: Array.from({ length: 9 }, (_, index) => link({ target: `target-${index}` })) }),
      new Set(Array.from({ length: 9 }, (_, index) => `target-${index}`)),
    );

    expect(parsed.links).toEqual([]);
    expect(parsed.errors.join("\n")).toMatch(/excessive edge count/);
  });

  it("rejects missing evidence excerpts", () => {
    const parsed = parseLinkArray(JSON.stringify({ links: [link({ evidence_excerpt: "" })] }), new Set(["target-1"]));

    expect(parsed.links).toEqual([]);
    expect(parsed.errors.join("\n")).toMatch(/missing evidence excerpt/);
  });

  it("falls back to an empty validated set for malformed output", () => {
    const parsed = parseLinkArray("not json", new Set(["target-1"]));

    expect(parsed.links).toEqual([]);
    expect(parsed.errors.join("\n")).toMatch(/parseable JSON/);
  });
});
