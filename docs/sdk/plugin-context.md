# Plugin Context

`PluginContext` is part of the shipped DreamGraph v9.0.0 plugin baseline. It is an authoritative runtime surface used by loaded plugins for capabilities such as logging, resource access, tool interaction, lifecycle-aware behavior, and other host-provided integrations. Earlier roadmap-era wording that described it as provisional or pending future host loading no longer applies after the M0–M6 baseline recorded in ADR-139.

## Current declaration context

SDK helper contexts currently contain only:

- `pluginId`
- optional `AbortSignal`

This keeps examples typeable without implying runtime capabilities that the host does not enforce yet.

## Future host context constraints

When runtime loading is implemented, the host-owned context must preserve these rules:

- Instance scoped access only.
- No access above the instance data directory.
- Internal graph files are read-only unless a core API explicitly mediates access.
- Shared JSON writes use existing file lock and atomic write discipline.
- Event handlers run through host-owned deferred queues, not inline on the synchronous bus.
- Network/process/secrets authority remains host mediated and deny-by-default.

This document is intentionally not a runtime API promise for M1.
