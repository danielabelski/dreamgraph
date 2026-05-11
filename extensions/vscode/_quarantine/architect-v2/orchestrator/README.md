# architect-v2/orchestrator

**Owner slice:** Slice 3 (Autonomy engine rewrite) primarily; Slice 4 wires execution.

Turn lifecycle: receive user input → assemble context → call provider → handle tool calls → run autonomy pass analysis → emit card events → persist task record.

Replaces v1's `chat-panel.ts` orchestration responsibilities (NOT its webview shell).

Empty until Slice 3.
