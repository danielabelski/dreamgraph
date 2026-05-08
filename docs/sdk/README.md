# DreamGraph SDK M0/M1 Foundation

This directory records the operational contract for the first SDK foundation phase.

## Scope

M0/M1 establishes package shape, manifest validation, vocabulary, and audit discipline. It does **not** load or execute third-party plugins.

Implemented package boundaries:

- `@dreamgraph/sdk`: plugin authoring types, manifest schema, no-op declaration helpers.
- `@dreamgraph/host`: host-facing status/administrative stub only.

## M1 boundary

Allowed in this phase:

- `definePlugin`, `defineTool`, `defineResource`, and event handler declaration helpers.
- Zod-backed manifest validation.
- Stable vs experimental event kind exports.
- Schema fixtures and package validation.

Not allowed in this phase:

- Runtime plugin loading.
- In-process plugin execution.
- Host-mediated network/process authority.
- Provider adapter execution.
- New seams beyond the roadmap vocabulary.

## Capability vocabulary locked for M1

- `events:read`
- `events:read:experimental`
- `events:emit`
- `tools:register`
- `resources:register`
- `resources:read`
- `ui:register`
- `policy:propose`
- `schedule:register_action`
- `webhooks:emit`
- `archetypes:provide`
- `providers:register`

Experimental event subscriptions must declare `events:read:experimental` once host enforcement exists. Until then, the SDK only exposes the vocabulary and manifest schema.
