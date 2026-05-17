/**
 * Tree-sitter parser bootstrap.
 *
 * Provides a lazy, cached path from a language name (`"c"`, `"cpp"`, `"rust"`)
 * to a configured `Parser` instance backed by a tree-sitter WASM grammar.
 *
 * Two layers of laziness:
 *   1. The tree-sitter runtime (`Parser.init`) is initialised once on first
 *      use. Subsequent calls await the same promise.
 *   2. Each grammar is loaded from disk once and cached. Subsequent calls
 *      for the same language reuse the cached `Language` instance.
 *
 * No top-level await, no eager I/O, no behaviour at import time. Safe to
 * import from anywhere; failures surface only when an extractor actually
 * asks for a parser.
 *
 * Grammar files are shipped by `tree-sitter-wasms` under
 * `node_modules/tree-sitter-wasms/out/`. The runtime WASM ships with
 * `web-tree-sitter` itself.
 *
 * ABI note: this module is pinned to `web-tree-sitter@0.20.x`, the
 * Emscripten-format runtime that matches the `tree-sitter-wasms@0.1.x`
 * grammar bundle (language ABI 13). The 0.26.x runtime uses the newer
 * `dylink.0` dynamic-linking section and is incompatible with these
 * grammars.
 */

import { promises as fs } from "node:fs";
import { createRequire } from "node:module";
import * as path from "node:path";

// 0.20.x ships as CommonJS with a default export of the `Parser` class
// and `Language` available as `Parser.Language`.
import Parser from "web-tree-sitter";

type Language = InstanceType<typeof Parser.Language>;

// ---------------------------------------------------------------------------
// Language registry
// ---------------------------------------------------------------------------

/**
 * Languages supported by the parser bootstrap. Adding a new entry here is
 * sufficient to make that grammar loadable; the actual WASM lookup is
 * driven by `wasmFileFor`.
 */
export type ParserLanguage = "c" | "cpp" | "rust";

/**
 * File-name (under `tree-sitter-wasms/out/`) for each supported grammar.
 */
const GRAMMAR_FILE: Record<ParserLanguage, string> = {
  c: "tree-sitter-c.wasm",
  cpp: "tree-sitter-cpp.wasm",
  rust: "tree-sitter-rust.wasm",
};

// ---------------------------------------------------------------------------
// Path resolution
// ---------------------------------------------------------------------------

const require_ = createRequire(import.meta.url);

function webTreeSitterDir(): string {
  const entry = require_.resolve("web-tree-sitter");
  return path.dirname(entry);
}

function grammarsDir(): string {
  const pkgJson = require_.resolve("tree-sitter-wasms/package.json");
  return path.join(path.dirname(pkgJson), "out");
}

function wasmFileFor(lang: ParserLanguage): string {
  return path.join(grammarsDir(), GRAMMAR_FILE[lang]);
}

// ---------------------------------------------------------------------------
// Runtime init
// ---------------------------------------------------------------------------

let runtimeInit: Promise<void> | null = null;

function ensureRuntime(): Promise<void> {
  if (runtimeInit) return runtimeInit;
  const wasmDir = webTreeSitterDir();
  runtimeInit = Parser.init({
    // Emscripten module locator — used by web-tree-sitter to find its
    // own `tree-sitter.wasm` binary at runtime.
    locateFile(file: string, prefix: string): string {
      if (file === "tree-sitter.wasm") {
        return path.join(wasmDir, "tree-sitter.wasm");
      }
      return prefix + file;
    },
  }).catch((err: unknown) => {
    runtimeInit = null;
    throw err;
  });
  return runtimeInit;
}

// ---------------------------------------------------------------------------
// Language cache
// ---------------------------------------------------------------------------

const languageCache: Map<ParserLanguage, Promise<Language>> = new Map();

export async function loadLanguage(lang: ParserLanguage): Promise<Language> {
  let pending = languageCache.get(lang);
  if (pending) return pending;
  pending = (async () => {
    await ensureRuntime();
    const file = wasmFileFor(lang);
    const bytes = await fs.readFile(file);
    return Parser.Language.load(bytes);
  })();
  pending.catch(() => {
    if (languageCache.get(lang) === pending) languageCache.delete(lang);
  });
  languageCache.set(lang, pending);
  return pending;
}

// ---------------------------------------------------------------------------
// Parser factory
// ---------------------------------------------------------------------------

/**
 * Construct a fresh `Parser` configured for `lang`. Each extractor invocation
 * receives its own `Parser` instance so concurrent scans do not interfere
 * with each other.
 */
export async function getParser(lang: ParserLanguage): Promise<Parser> {
  const language = await loadLanguage(lang);
  const parser = new Parser();
  parser.setLanguage(language);
  return parser;
}

// ---------------------------------------------------------------------------
// Test / introspection helpers
// ---------------------------------------------------------------------------

export function grammarPath(lang: ParserLanguage): string {
  return wasmFileFor(lang);
}

export function _resetParserBootstrapForTests(): void {
  runtimeInit = null;
  languageCache.clear();
}
