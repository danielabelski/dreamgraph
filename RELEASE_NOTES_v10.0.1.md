# DreamGraph v10.0.1 — Renata

**v10.0.1** is a focused stability and UX release on top of the v10.0 "Renata" line. It hardens the architect's continuation behaviour, ships a Copilot-parity **per-file diff review surface**, fixes provider/model persistence across restarts, and tightens the Linux/PowerShell installers so a botched install can no longer pretend to be a successful one.

No breaking changes. Drop-in upgrade from v10.0.0.

---

## Headline changes

### 1. Per-file diff review surface (Copilot parity)

The "Changed Files" panel is no longer a flat dump. Each agent pass that touches the workspace now produces a **collapsible diff bar** with:

- **Per-file rows** with Keep / Undo controls.
- **Click the filename** to open VS Code's native diff compare against the pre-change snapshot — the same gesture Copilot users already have muscle memory for.
- A backing **change-review service** (`change-review-service.ts`) and a **reviewable-file filter** (`reviewable-file-filter.ts`) that suppress noise: generated files, lockfiles, build artefacts, and out-of-workspace paths never reach the review surface.
- Architect passes, manual tool calls, and autonomy continuations all funnel through the same review surface — one place to accept or revert, regardless of how the change was produced.

This replaces the v10.0.0 changed-files view, which exposed raw mutations without a reversible gate.

### 2. Architect continuation: less talk, more action

The continuation loop in v10.0.0 was prone to two failure modes: (a) burning a pass on another "let me look at X" read after the patch target was already anchored, and (b) re-doing locate work across user turns when the user manually re-clicked an action chip. Both are fixed.

- **Anchor-stop discipline** (`847bf46`): once a concrete patch anchor is established in a pass, the architect stops researching and applies. No more "I'll just double-check the imports" right before the apply.
- **WRITE-bound continuation directive** (`autonomy-loop.ts`): the continuation prompt now emits an explicit WRITE directive when the selected action is a write-class tool **or** when a patch anchor has been established. The next pass starts already pointed at the edit.
- **Cross-turn write-pressure narrowing** (`chat-panel.ts`): when a user begins a new turn after a locate-only pass, with a sticky anchor still present, the effective tool catalog is narrowed to write-and-verify tools. Manual re-clicks of "Patch …" action chips no longer degrade back into read-heavy exploration.
- **Hand-off packets on budget exhaustion** (`6853acf`): when a pass exhausts its budget, the architect now emits a structured hand-off packet (intent, anchor, next concrete step) so the following pass picks up mid-stride instead of restarting from the prompt.

### 3. Per-project provider and model persistence

The chosen provider and model are now persisted **per workspace**, not globally. Switching repositories no longer silently swaps you onto whichever provider the last project happened to use, and a workspace's provider survives VS Code restarts. (`3865009`)

### 4. Web senses: large-output truncation fix

The web fetch / search senses no longer corrupt downstream context when a single response runs into the tens of kilobytes. Long bodies are truncated cleanly with a marker the architect can reason about, instead of overrunning the context window and silently degrading the rest of the pass. (`2cfa801`)

### 5. UI: redundant "Show tool trace" entry removed

A duplicate "Show tool trace" affordance that shipped in v10.0.0 has been removed; trace access remains in the canonical location. (`6f4f080`)

### 6. Linux + PowerShell installer hardening

The installer cascade exposed by the WSL bring-up flow has been fixed end-to-end:

- **Node 20+ required.** Both `scripts/install.sh` and `scripts/install.ps1` now fail fast with a clear message on Node 18 (which broke `undici@7`, `vsce@3`, and `cheerio@1.2`). `INSTALL.md` updated to match. `package.json` declares `"engines": { "node": ">=20.0.0" }`.
- **Stale `tsbuildinfo` cleanup.** The installer now deletes lingering `tsconfig.tsbuildinfo` files before building, so `tsc -b` can no longer skip CLI emit when the incremental cache disagrees with reality.
- **Hard build assertion.** Immediately after the root build, the installer asserts that `dist/cli/dg.js` exists. If it doesn't, it dumps `dist/` and exits with a directive to re-run `npx tsc -b --verbose`. Silent CLI-missing failures are gone.
- **Verify step actually fails on failure.** The post-install verification is no longer swallowed; its captured output is re-printed and the installer aborts on non-zero exit.
- **Honest final banner.** When the core installs but the VS Code extension fails to build or package, the installer now tracks `EXTENSION_INSTALL_FAILED` and prints a yellow "core installed — extension FAILED" banner instead of the previous green success.

### 7. Docs: federation post-office

Initial design document for the federation post-office (`federation-post-office-v1.md`) landed for review. Internal-only at this stage; no runtime surface yet. (`622b8cd`, `0176853`)

---

## Upgrade notes

- **Node 20+ is required for fresh installs.** Existing v10.0.0 deployments on Node 20 upgrade in place with no action.
- **VS Code extension:** install the `dreamgraph-vscode-10.0.1.vsix` attached to this release, or reload after the next workspace install.
- The `architect-v2/` quarantine introduced in v10.0.0 is unchanged.

## Commits in this release

```
6f4f080  (fix): Removed redundant Show tool trace
3865009  (fix): per project provider/model settings persistence over restarts
f3f87b3  (feature): Per file diff view, architect improvements, sdk example plugin name fix + UX
f1aabeb  Autonomy improvements
847bf46  (fix): Less talk more action — anchor-stop in architect (token economy)
2cfa801  (fix): Web senses truncation fix on long outputs
0176853  Update federation-post-office-v1.md
622b8cd  Create federation-post-office-v1.md
6853acf  (architect) Continuity fixes and hand-off packets when pass budget is exhausted
```
