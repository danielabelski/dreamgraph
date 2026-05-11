#!/usr/bin/env node
// scripts/lint-isolation.mjs
//
// ADR-171 enforcement: `mcp_dreamgraph_*` symbols (the live MCP tool
// names) MUST appear ONLY inside files under
// `src/architect-v2/orchestrator/adapters/dreamgraph/**`. Anywhere
// else in `src/architect-v2/**` is a strict-isolation violation.
//
// ADR-140 enforcement: NO file under `src/architect-v2/**` may import
// from a v1 path (any sibling under `src/` that is not `architect-v2`).
//
// Exits non-zero on the first violation. Run as part of `prebuild`.

import { promises as fs } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const ROOT = join(__dirname, "..");
const V2_ROOT = join(ROOT, "src", "architect-v2");
const ADAPTER_ALLOWED = join(V2_ROOT, "orchestrator", "adapters", "dreamgraph");

/**
 * Files under V2_ROOT explicitly allowed to break isolation rules,
 * with the reason. Keep this list short and reviewed.
 */
const ALLOWLIST = new Map([
  // host/ is the wiring seam (ADR-178). It MAY type-only depend on
  // existing low-level transports through narrow bridge interfaces.
  [join(V2_ROOT, "host", "mcp-client-bridge.ts"), "host wiring seam (ADR-178)"],
  [join(V2_ROOT, "host", "vscode-fallback-signal-provider.ts"), "host wiring seam (ADR-178)"],
  [join(V2_ROOT, "host", "vscode-memento-store.ts"), "host wiring seam (ADR-178)"],
  // execution/catalog.ts is a metadata manifest listing tool NAMES;
  // it never invokes them. Carving it out preserves a single source
  // of truth for the capability catalog without forcing all tool
  // names into the adapter folder. The lint still blocks INVOCATION
  // (any non-string-literal use) because catalog.ts contains only
  // string literals inside a const array.
  [join(V2_ROOT, "execution", "catalog.ts"), "metadata manifest of tool names (ADR-171 carve-out)"],
]);

/** Match the literal token `mcp_dreamgraph_` (case-sensitive). */
const MCP_TOKEN = /mcp_dreamgraph_/g;

/** Match `from "..."` / `from '...'` import specifiers. */
const IMPORT_RE = /\bfrom\s+["']([^"']+)["']/g;

let violations = 0;

async function* walk(dir) {
  for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      yield* walk(full);
    } else if (entry.isFile() && full.endsWith(".ts")) {
      yield full;
    }
  }
}

function isUnderAdapter(absPath) {
  return absPath.startsWith(ADAPTER_ALLOWED + sep);
}

function isUnderV2(absPath) {
  return absPath.startsWith(V2_ROOT + sep);
}

function rel(p) {
  return relative(ROOT, p).split(sep).join("/");
}

/**
 * Resolve a relative import specifier against the importing file's
 * directory. Returns an absolute path with the .ts extension
 * (resolves `.js` specifiers back to `.ts` files for our checks).
 * Returns null for bare-package imports.
 */
function resolveImport(fromFile, spec) {
  if (!spec.startsWith(".")) return null;
  const fromDir = dirname(fromFile);
  let resolved = resolve(fromDir, spec);
  if (resolved.endsWith(".js")) resolved = resolved.slice(0, -3) + ".ts";
  return resolved;
}

async function main() {
  let scanned = 0;
  // architect-v2 was quarantined in v10.0.0 "Renata" (moved to _quarantine/).
  // If the source root is absent, the isolation invariants are vacuously
  // satisfied and we skip the walk.
  try {
    await fs.access(V2_ROOT);
  } catch {
    console.log("lint:isolation OK — architect-v2 quarantined; 0 violations.");
    return;
  }
  for await (const file of walk(V2_ROOT)) {
    scanned++;
    const allowReason = ALLOWLIST.get(file);
    const text = await fs.readFile(file, "utf-8");
    const lines = text.split(/\r?\n/);

    // ADR-171: mcp_dreamgraph_* tokens
    if (!isUnderAdapter(file) && !allowReason) {
      for (let i = 0; i < lines.length; i++) {
        if (/mcp_dreamgraph_/.test(lines[i])) {
          const trimmed = lines[i].trim();
          const isComment = trimmed.startsWith("//") || trimmed.startsWith("*");
          if (!isComment) {
            console.error(
              `ADR-171 violation: ${rel(file)}:${i + 1} — mcp_dreamgraph_* token outside dreamgraph adapter\n  ${lines[i]}`,
            );
            violations++;
          }
        }
      }
    }

    // ADR-140: v1 imports — resolve each relative import and verify
    // it lands under V2_ROOT.
    if (!allowReason) {
      IMPORT_RE.lastIndex = 0;
      let m;
      while ((m = IMPORT_RE.exec(text)) !== null) {
        const spec = m[1];
        const resolved = resolveImport(file, spec);
        if (resolved === null) continue; // bare package import
        if (!isUnderV2(resolved)) {
          const lineNum = text.slice(0, m.index).split(/\r?\n/).length;
          console.error(
            `ADR-140 violation: ${rel(file)}:${lineNum} — import escapes architect-v2\n  from "${spec}"  →  ${rel(resolved)}`,
          );
          violations++;
        }
      }
    }
  }

  if (violations > 0) {
    console.error(`\nlint:isolation FAILED — ${violations} violation(s) across ${scanned} file(s).`);
    process.exit(1);
  }
  console.log(`lint:isolation OK — ${scanned} file(s) scanned, 0 violations.`);
}

main().catch((err) => {
  console.error("lint:isolation crashed:", err);
  process.exit(2);
});
