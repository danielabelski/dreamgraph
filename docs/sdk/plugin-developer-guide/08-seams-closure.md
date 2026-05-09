# 8. Closure seams: UI, policies, archetypes, markdown fences

[← Events](07-seams-events.md) · [Next: Trust →](09-trust-and-security.md)

These four seams are the M6 closure. Each is **metadata-only** and writes
through a host-locked store with automatic prune-on-unload.

## 8.1 UI — `ctx.ui.register`

```js
ctx.ui.register({
  id: "acme.changelog.summary_panel",       // MUST start with "<plugin-id>."
  name: "Weekly Summary Panel",
  purpose: "Display the latest weekly changelog body.",
  category: "data_display",
  inputs: [
    { name: "week_id", type: "string", required: true },
  ],
  outputs: [],
  interactions: [],
  implementations: [
    { platform: "react", component: "WeeklySummaryPanel" },
  ],
});
```

The host validates the element against the live `ui_registry.json` schema and
writes it with provenance `plugin:<plugin-id>`. The metadata is consumable by
the explorer and by external dashboards reading `ui_registry.json`.

**Out of scope for v1:** an executable iframe panel runtime. M6 ships the
metadata seam only; the iframe contract is post-1.0.

## 8.2 Policies — `ctx.policies.propose`

```js
ctx.policies.propose({
  id: "weekly-changelog-allowed-during-execution",
  title: "Weekly changelog generation is allowed during the execution phase",
  rationale: "The summary tool is a read-only synthesis with no side-effects.",
  applies_to: ["plugin"],
  phases: [{ phase: "execution", permission: "allowed" }],
  severity: "info",
});
```

Plugins **propose** discipline rules; they cannot **weaken** existing rules.
A proposal that contradicts a stricter built-in rule is rejected with
`policy_weakening_rejected`. Accepted proposals land in
`plugin_policy_proposals.json` tagged `source: "plugin:<id>"`. The merge into
the live `discipline://manifest` happens on a separate, operator-reviewed path.

## 8.3 Archetypes — `ctx.archetypes.registerProvider`

```js
ctx.archetypes.registerProvider({
  id: "starter-pack",
  name: "Starter Archetype Pack",
  inline: {
    source: "acme.changelog",
    version: "1",
    archetypes: [
      { id: "the-weekly-recap", name: "The Weekly Recap", summary: "...", tags: ["example"] },
    ],
  },
});
```

Two provider modes:

| Mode     | Field      | When polled                                |
| -------- | ---------- | ------------------------------------------ |
| `inline` | `inline`   | Immediately at registration; static feed.  |
| `remote` | `url`, `etag` | (Reserved) polled by the federation poller. |

For v1, prefer `inline`. Live polling is exercised separately by federation tests
and is not yet part of the plugin contract.

## 8.4 Markdown fences — `ctx.markdownFences.register`

```js
ctx.markdownFences.register({
  language: "acme-changelog",
  label: "Acme Changelog",
  description: "Renders a structured changelog block.",
  platforms: ["webview"],
});
```

This is a **manifest-only stub** in the host: it tells the webview SDK that a
fence language exists and describes its rendering surface, but the actual
renderer lives in a webview-side package (`window.registerCardFencePlugin`).
The closure here gives operators visibility — they can see which plugins claim
which fence languages — and reserves the language so two plugins cannot collide
(`markdown_fence_language_collision`).

[← Events](07-seams-events.md) · [Next: Trust →](09-trust-and-security.md)
