/**
 * Smoke test for the tree-sitter parser bootstrap.
 *
 * Verifies that:
 *   - the runtime can be initialised,
 *   - each wave-1 grammar (C, C++, Rust) loads from disk, and
 *   - a trivial source snippet parses without syntax errors.
 *
 * This test is intentionally minimal — extractor-specific assertions live
 * in the per-extractor snapshot tests. Here we only prove the WASM seam
 * works on the current platform.
 */

import { describe, it, expect, beforeAll } from "vitest";

import {
  getParser,
  grammarPath,
  _resetParserBootstrapForTests,
} from "../src/scanner/parser-bootstrap.js";

describe("parser-bootstrap", () => {
  beforeAll(() => {
    _resetParserBootstrapForTests();
  });

  it("resolves a grammar path for every supported language", () => {
    expect(grammarPath("c")).toMatch(/tree-sitter-c\.wasm$/);
    expect(grammarPath("cpp")).toMatch(/tree-sitter-cpp\.wasm$/);
    expect(grammarPath("rust")).toMatch(/tree-sitter-rust\.wasm$/);
    expect(grammarPath("java")).toMatch(/tree-sitter-java\.wasm$/);
    expect(grammarPath("kotlin")).toMatch(/tree-sitter-kotlin\.wasm$/);
    expect(grammarPath("python")).toMatch(/tree-sitter-python\.wasm$/);
  });

  it("parses a C struct without errors", async () => {
    const parser = await getParser("c");
    const tree = parser.parse("struct Node { struct Node *next; };");
    expect(tree.rootNode.hasError()).toBe(false);
    expect(tree.rootNode.type).toBe("translation_unit");
  });

  it("parses a C++ class without errors", async () => {
    const parser = await getParser("cpp");
    const tree = parser.parse(
      "namespace ns { class Foo { public: int bar() const; }; }"
    );
    expect(tree.rootNode.hasError()).toBe(false);
  });

  it("parses a Rust struct without errors", async () => {
    const parser = await getParser("rust");
    const tree = parser.parse(
      "struct Node { next: Option<Box<Node>> }"
    );
    expect(tree.rootNode.hasError()).toBe(false);
  });

  it("parses a Java class without errors", async () => {
    const parser = await getParser("java");
    const tree = parser.parse(
      "package com.example; public class Foo implements Runnable { public void run() {} }"
    );
    expect(tree.rootNode.hasError()).toBe(false);
  });

  it("parses a Python class without errors", async () => {
    const parser = await getParser("python");
    const tree = parser.parse(
      "class Foo:\n    x: int = 0\n    def bar(self) -> None:\n        return None\n"
    );
    expect(tree.rootNode.hasError()).toBe(false);
    expect(tree.rootNode.type).toBe("module");
  });

  it("returns a fresh parser per call but reuses the language", async () => {
    const a = await getParser("c");
    const b = await getParser("c");
    expect(a).not.toBe(b);
    const sa = a.parse("int x;").rootNode.toString();
    const sb = b.parse("int x;").rootNode.toString();
    expect(sa).toBe(sb);
  });
});
