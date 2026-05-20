# DreamGraph v10.5.0 — Renata

**v10.5.0** is the current Renata release. It brings the CLI, daemon, VS Code extension, dashboard, Explorer, SDK, host package, root documentation, docs, and user guide onto one published version line.

No breaking changes are intended for existing v10.x installations.

---

## Headline changes

### 1. Copilot CLI native adapter hardening

The VS Code Architect can now use Copilot CLI as a native DreamGraph-aware provider path with:

- DreamGraph MCP authority checks and fail-closed grounding.
- Inheritance-proxy MCP bridging so Copilot CLI shares the Architect's live DreamGraph session.
- Audited `dreamgraph:run_command` routing for build/test/verification work.
- Explicit denial and filtering of phantom `cli:*` shell/write tools.
- Idle-output timeout semantics: productive long runs can continue while stalled runs still terminate quickly.
- Cause-specific cancellation and retry-success verification handling so a recovered retry does not poison the verdict.

### 2. Native scanner and graph enrichment expansion

The scanner line now includes broader native language extraction and richer graph provenance:

- C and C++ extractors, including pointer/list/container/template shape modeling.
- Rust, Java, Kotlin, Python, C#, Gradle, Go, and Swift extraction slices.
- Autonomous parser-node enrichment via `enrich_parser_nodes`.
- Canonical promotion provenance gates and source-less fact quarantine.

### 3. UI registry and Explorer graph citizenship

UI registry entries are now first-class graph citizens when they carry source provenance. The Explorer and graph surfaces can show UI registry nodes directly, and the native UI scanner can populate React/Vue/Svelte/Blazor/WPF component entries without overwriting curated registry data.

### 4. Version and documentation alignment

This release aligns all first-party versioned surfaces to **10.5.0**:

- Root daemon/CLI package and package lock.
- `@dreamgraph/sdk` and `@dreamgraph/host` workspace packages.
- Explorer package and package lock.
- VS Code extension package, package lock, runtime MCP client identity, activation-version marker, and extension README.
- CLI version output and MCP client identity.
- Root README, architecture docs, SDK docs, plugin guide/reference, and user-guide install examples.

---

## Upgrade notes

- **Node 20+ remains required.**
- Re-run the installer (`scripts/install.ps1 -Force` or `bash scripts/install.sh --force`) after pulling this release.
- Reload VS Code after installing `dreamgraph-vscode-10.5.0.vsix`.
- Restart running DreamGraph daemons so the v10.5.0 CLI/daemon/runtime strings and adapter behavior are active.

## Artifacts

This release attaches the generated first-party artifacts:

- `dreamgraph-10.5.0.tgz`
- `dreamgraph-sdk-10.5.0.tgz`
- `dreamgraph-host-10.5.0.tgz`
- `dreamgraph-vscode-10.5.0.vsix`

## Commits since v10.0.1

```text
09eb4c4 (fix): Copilot CLI most issues now fixed. Now more cancellation on timeout or failed tool calls. DreamGraph tools authorative.
56cbeb0 feat(copilot-cli): inheritance-proxy MCP bridge so Copilot CLI shares the architect's live DreamGraph session (fail-closed)
832fb14 (feature): Copilot-CLI adapter for Architect is now operational. No tool trace yet but works using dreamgraph tools and with your copilot account.
9270006 Update install.ps1
3d19821 v10.4.0
116fb46 feat(explorer): surface ui_registry entries as first-class graph nodes
dd8253d wire semantic-invariants constants into snapshot, _shared, llm-dream prompt
3f3917b v10.4.0: canonical promotion provenance gate + source-less fact quarantine
0b87f8b feat(ui): native UI scanner — slice 2 (v10.3.0)
952092b fix(plugins): enforce model-safe snake_case for plugin tool names; keep dotted UI ids
dc8faeb feat(ui): promote UI registry elements to first-class graph citizens (slice 1)
12cdeec feat(enrichment): autonomous batch enrichment for parser-discovered nodes via new enrich_parser_nodes MCP tool
13e2d0d feat(scanner): Swift extractor (SW-1..SW-3)
658a452 feat(scanner): Go extractor (GO-1..GO-3)
bd6e879 fix(extension): escape inline-code backticks in architect-core prompt template literal
13d4ad2 feat(scanner): Gradle extractor (G-1)
ac7b260 feat(scanner): C# extractor (CS-1..CS-3)
80fbf49 feat(scanner): Python extractor (PY-1..PY-3)
2851b2a feat(scanner): Kotlin extractor (KT-1..KT-3)
25ec897 fix(scanner): repair intermediate-layer coherence
2db76f5 docs(scanner): note Java extractor in Phase 2.6 + source layout
f4811fe feat(scanner): Java extractor (JV-1..JV-3)
ff51bbf docs(scanner): document polyglot native scanner (C/C++/Rust)
08d54fc feat(scanner): Rust extractor (RS-1..RS-3)
2fa724c feat(scan-project): wire native C/C++ extractors into data_model + scan_quality
8625820 feat(scanner/cpp): CPP-4 template parameters + specialisation edges
695f4f2 feat(scanner/cpp): CPP-3 smart pointer + STL container shape edges
bbbee51 feat(scanner/cpp): CPP-2 methods, constructors, destructors, out-of-line defs
b0fcb71 scanner(cpp): CPP-1 namespaces, classes, structs, inheritance, access modifiers
123a136 scanner(c): C-5 intrusive list / array-with-count / opaque handle
fb04159 scanner(c): C-4 singly + doubly linked-list shape detection
93e8065 scanner(c): C-3 cross-file linker
bf6bf7a scanner(c): C-2 pointer modeling
55e0b09 scanner(c): C-1 extractor + fixture + snapshot test
b30eab5 scanner: ontology constants + tree-sitter parser bootstrap
```
