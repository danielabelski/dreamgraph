// SCOPED EXCEPTION (ADR-171): the only directory in architect-v2 that
// references DreamGraph MCP tools by name. Slice 8B's lint rule will
// exempt this path.

export {
  DreamGraphReaderAdapter,
  UnboundMcpClient,
  type DreamGraphReaderAdapterOptions,
  type McpClient,
} from "./reader.js";

export {
  DreamGraphRecorderAdapter,
  type DreamGraphRecorderAdapterOptions,
} from "./recorder.js";
