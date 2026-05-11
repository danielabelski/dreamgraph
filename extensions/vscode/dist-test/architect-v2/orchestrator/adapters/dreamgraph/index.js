"use strict";
// SCOPED EXCEPTION (ADR-171): the only directory in architect-v2 that
// references DreamGraph MCP tools by name. Slice 8B's lint rule will
// exempt this path.
Object.defineProperty(exports, "__esModule", { value: true });
exports.DreamGraphRecorderAdapter = exports.UnboundMcpClient = exports.DreamGraphReaderAdapter = void 0;
var reader_js_1 = require("./reader.js");
Object.defineProperty(exports, "DreamGraphReaderAdapter", { enumerable: true, get: function () { return reader_js_1.DreamGraphReaderAdapter; } });
Object.defineProperty(exports, "UnboundMcpClient", { enumerable: true, get: function () { return reader_js_1.UnboundMcpClient; } });
var recorder_js_1 = require("./recorder.js");
Object.defineProperty(exports, "DreamGraphRecorderAdapter", { enumerable: true, get: function () { return recorder_js_1.DreamGraphRecorderAdapter; } });
//# sourceMappingURL=index.js.map