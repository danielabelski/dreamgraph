# DreamGraph v10.0.1 — Renata

**v10.0.1 "Renata"** is a release defined by **convergence** and **discipline**. The v1 architect — long the production surface — absorbed every lesson learned during the v2 prototype work and emerged as the canonical agent. v2 is now formally quarantined.

This is also the release where DreamGraph stops fighting its model providers. A canonical strict envelope is enforced server-side by every provider that supports it, and a single projection seam normalizes their output into the shape downstream parsers already understand. The agent reasons in one shape, regardless of who answered.

---

## Headline changes

### 1. The v1 hybrid is the canonical architect — architect-v2 is quarantined

The `architect-v2/` source tree has been moved to `extensions/vscode/_quarantine/` and is no longer imported, registered, or built into the activation graph. The dedicated **"Architect v2 (preview)"** sidebar view and the `dreamgraph.openArchitectV2` command have been removed from the manifest.

Why: the v1 architect (`architect-llm.ts` + `architect-pass-projection` + the cross-provider strict envelope) now matches or exceeds every architectural goal v2 was designed to achieve, while keeping the mature autonomy loop, agentic tool execution, and chat persistence the user already depends on. Maintaining a parallel surface no longer pays for itself.

The folder is retained for historical reference. Re-importing it requires a new ADR.

### 2. Cross-provider structured-output normalization

DreamGraph now defines a single canonical pass envelope (`ArchitectPassEnvelope`) and enforces it on every provider that supports server-side schema constraint:

| Provider | Mechanism | Default |
|---|---|---|
| OpenAI Chat Completions | `response_format: json_schema` (strict) | **on** |
| OpenAI Responses API (gpt-5.5) | `text.format: json_schema` (strict) | **on** |
| Ollama (≥ 0.5) | `format: <schema>` | off (opt-in) |
| LM Studio | OpenAI-compat `response_format: json_schema` | off (opt-in) |
| Anthropic | prompt-driven envelope (unchanged — forced tool-use conflicts with the agentic tool loop) | off |

All providers that emit a strict envelope feed through the **same** `projectStrictEnvelopeToLegacy()` helper and the **same** `StrictNarrativeStreamExtractor` for clean prose streaming. Downstream parsers see one shape.

Toggle: `dreamgraph.architect.structuredOutput` (boolean).

### 3. Streaming UX preserved under strict mode

The strict envelope is a JSON object — but the user sees only the unescaped `narrative` field, decoded chunk-by-chunk in real time. Envelope fields (`summary`, `goal_status`, `recommended_next_steps`, …) are swallowed silently during the stream and projected into the existing summary card on completion.

### 4. SUMMARY card de-duplication

The webview body renderer and the host `_broadcastSummaryCard` no longer both render the envelope. The host short-circuits when an envelope is detected; the body keeps its existing prose+fenced-JSON rendering path. One card per pass, every time.

### 5. Vendor sourcemap CSP fix

`markdown-it.min.js` and `purify.min.js` are now post-processed during `build:vendor` to strip the trailing `//# sourceMappingURL=` comment. VS Code webview CSP no longer logs spurious sourcemap-blocked warnings.

---

## Files updated for v10.0.1

- Core package (`package.json`) → `10.0.1`
- VS Code extension (`extensions/vscode/package.json`) → `10.0.1` (also drops the `architect-v2` view + command)
- Explorer (`explorer/package.json`) → `10.0.1`
- `@dreamgraph/sdk` (`packages/sdk/package.json`) → `10.0.1`
- `@dreamgraph/host` (`packages/host/package.json`) → `10.0.1` (sdk dep → `10.0.1`)
- Lock files (`package-lock.json`, `explorer/package-lock.json`, `extensions/vscode/package-lock.json`) → root `10.0.1`
- CLI banner (`src/cli/dg.ts`) → `DreamGraph CLI v10.0.1 (Renata)`
- CLI ↔ daemon MCP client ID (`src/cli/utils/mcp-call.ts`) → `10.0.1`
- VS Code ↔ daemon MCP client ID (`extensions/vscode/src/mcp-client.ts`) → `10.0.1`
- Architect core prompt (`extensions/vscode/src/prompts/architect-core.ts` + `extensions/vscode/prompts/architect_core.md`) → `v10.0.1 Renata`
- VS Code activation `currentVersion` reset key → `10.0.1`
- `INSTALL.md`, `guide/02-installation.md`, `README.md`, `extensions/vscode/README.md` headers and `dg --version` examples
- `docs/architecture.md` version line → `10.0.1`
- `docs/sdk/plugin-developer-guide/00-index.md` and `docs/sdk/plugin-reference/00-index.md` engine baseline → `v10.0.1 "Renata"`
- `scripts/build-plugin-docs.ps1` engine-baseline string and PDF subtitle

### Plugin engine baseline is intentionally unchanged

The plugin manifest floor stays at `"engine": { "dreamgraph": ">=9.0.0" }`. v10.0.1 retains the M0–M6 plugin SDK contract; plugins authored against the v9 baseline run unchanged on v10.

---

## Upgrade

- Run `.\scripts\install.ps1 -Force` (or `./scripts/install.sh`) to refresh CLI, daemon, Explorer, and extension assets. Verify with `dg --version` → `DreamGraph CLI v10.0.1 (Renata)`.
- The activation key bump triggers a one-time `workbench.action.resetViewLocations` so the sidebar icons reseat cleanly after the architect-v2 view is removed.
- Plugin authors: nothing to do. `engine.dreamgraph: ">=9.0.0"` is still the supported floor.

---

## Known gaps

- The pre-built site under `docs/sdk/site/` (HTML + PDF) still carries the `v9.0.0 "Lattice"` strings; they will be regenerated by the next `scripts/build-plugin-docs.ps1` run.
- Anthropic structured output remains prompt-driven; the lenient envelope parser handles drift. A future ADR may revisit forced tool-use once the agentic tool loop and a `submit_pass` tool can coexist cleanly.

---

## Provenance

- Branch: `main`
- Release: `v10.0.1 — Renata`
