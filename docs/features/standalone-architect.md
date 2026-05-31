# Standalone Architect

> Daemon-owned, daemon-served browser Architect control plane for project-bound chat, plan operations, live tool/status feedback, and advisory Adaptive Future review. The `/architect` route falls into the daemon-owned category. The future-review projection derives route metadata from Architect LLM provider/model readiness and surfaces deterministic fallback reasons when model-backed routing is unavailable.

**Repository:** dreamgraph  
**Domain:** core  
**Status:** active  
**Source files:** src/architect/routes.ts, plans/STANDALONE_ARCHITECT_PARITY_AND_UI_FIXES_PLAN.md, plans/STANDALONE_ARCHITECT_PARITY_AND_UI_FIXES_PLAN.implementation-log.md  

## Relationships

| Target | Type | Relationship | Strength | Description |
|--------|------|--------------|----------|-------------|
| standalone_architect_browser_shell | ui_element | rendered_by | strong | Browser shell renders future-review model provenance and fallback reason chips. |
| architect-plan-registry-projection | feature | related_to | moderate | auto-backlink |
| standalone-architect-api-v1 | feature | related_to | moderate | auto-backlink |
| standalone-architect-governed-plan-actions | feature | depends_on | moderate | auto-backlink |
| standalone-architect-afe-scheduler-operations | feature | related_to | moderate | auto-backlink |
| standalone-architect-workspace-package-packaging | feature | related_to | moderate | auto-backlink |
| standalone-architect-project-bound-chat-shell | feature | implemented_by | moderate | auto-backlink |
| standalone-architect-executable-runtime-bootstrap | feature | depends_on | moderate | auto-backlink |
| standalone-architect-cli-bridge | feature | related_to | moderate | auto-backlink |

**Tags:** standalone-architect, adaptive-future-engine, future-review, daemon-governed, daemon-owned, daemon-served-route, provider-routing

