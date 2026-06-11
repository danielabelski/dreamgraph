# VS Code Architect Codex CLI Turn

> Routes an Architect user or autonomy continuation turn through the native Codex CLI adapter while preserving DreamGraph MCP authority, live tool-trace UX, login recovery, and pending-review reconciliation.

**Trigger:** User selects codex-cli as the Architect provider and submits a chat turn or autonomy continuation.  
**Source files:** extensions/vscode/src/chat-panel.ts, extensions/vscode/src/architect-core/adapters/codex-cli/provider-port.ts, extensions/vscode/src/architect-core/adapters/codex-cli/orchestrator.ts  

## Steps

### 1. Resolve Codex provider settings

Read codexCli command/timeouts/model settings and validate that the DreamGraph MCP client is connected.

### 2. Build authoritative bridge config

Validate the live DreamGraph MCP tool registry, generate isolated Codex config.toml, and advertise the authoritative tool manifest in the prompt.

### 3. Run Codex CLI

Execute codex exec with read-only sandboxing, stdin prompt delivery, timeout/cancel wiring, and codex login recovery metadata on authentication failures.

### 4. Stream live MCP tool progress

Tail the shared audit NDJSON records and surface in-flight DreamGraph MCP calls through the chat panel without dispatching duplicate provider tool calls.

### 5. Reconcile final trace and reviews

Replace provisional live entries with the final authoritative audit trace, preserve retried failures without downgrading successful outcomes, and record workspace changes from turn snapshots independently of tool projection.

