# DreamGraph Plugin Reference Manual

**Audience:** Plugin authors and host implementors needing strict, normative tables.
**Engine baseline:** v13.0.0 "Cognitive Maintenance".
**Companion:** see the [Plugin Developer Guide](../plugin-developer-guide/00-index.md) for task-oriented walkthroughs.

This reference is the source of truth. Where the guide and the reference disagree,
the reference wins. Where the reference and the SDK source disagree, the SDK
source wins (and a doc bug should be filed).

## Sections

1. [Manifest schema](01-manifest-schema.md) — every field, every constraint.
2. [Capabilities](02-capabilities.md) — the locked vocabulary.
3. [Effects](03-effects.md) — observable cognitive effects.
4. [Reject reasons](04-reject-reasons.md) — every `plugin.output.rejected.reason`.
5. [PluginContext API](05-context-api.md) — TypeScript surface.
6. [Events](06-events.md) — stable kinds, experimental kinds, payload schemas.
7. [CLI](07-cli.md) — `dg plugin` subcommands.
8. [Host configuration](08-host-config.md) — env vars and `instance.json`.
9. [Telemetry events](09-telemetry-events.md) — the `plugin.*` stream.
10. [Architect tabs](10-architect-tabs.md) — declarative tab contract, plan state, routes, lifecycle, and telemetry.

## Conventions

- **MUST / MUST NOT / SHOULD** are used in the RFC 2119 sense.
- Tables are exhaustive unless explicitly marked "non-exhaustive".
- Source-code references link to the canonical file at the repo root.
