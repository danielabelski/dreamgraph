"use strict";
// STRICT ISOLATION (ADR-140): no import from v1.
// Slice 8A.1 — Public surface of the orchestrator module.
Object.defineProperty(exports, "__esModule", { value: true });
exports.UnboundMcpClient = exports.DreamGraphRecorderAdapter = exports.DreamGraphReaderAdapter = exports.runPass = exports.NullProjectGraphRecorder = exports.NullProjectGraphReader = exports.NULL_RICHNESS_SIGNAL = exports.NULL_PROJECT_SUBGRAPH = exports.SYSTEM_CLOCK = void 0;
var ports_js_1 = require("./ports.js");
Object.defineProperty(exports, "SYSTEM_CLOCK", { enumerable: true, get: function () { return ports_js_1.SYSTEM_CLOCK; } });
var project_graph_js_1 = require("./project-graph.js");
Object.defineProperty(exports, "NULL_PROJECT_SUBGRAPH", { enumerable: true, get: function () { return project_graph_js_1.NULL_PROJECT_SUBGRAPH; } });
Object.defineProperty(exports, "NULL_RICHNESS_SIGNAL", { enumerable: true, get: function () { return project_graph_js_1.NULL_RICHNESS_SIGNAL; } });
Object.defineProperty(exports, "NullProjectGraphReader", { enumerable: true, get: function () { return project_graph_js_1.NullProjectGraphReader; } });
Object.defineProperty(exports, "NullProjectGraphRecorder", { enumerable: true, get: function () { return project_graph_js_1.NullProjectGraphRecorder; } });
var loop_js_1 = require("./loop.js");
Object.defineProperty(exports, "runPass", { enumerable: true, get: function () { return loop_js_1.runPass; } });
// 8A.3 + 8A.4: DreamGraph adapters for ProjectGraphReader,
// ProjectGraphRecorder, and ContextDiscoveryRecorder. Live under
// orchestrator/adapters/dreamgraph/ per ADR-171 guard rail. Re-exported
// here so 8A.5 host wiring can import them without crossing module
// boundaries.
var index_js_1 = require("./adapters/dreamgraph/index.js");
Object.defineProperty(exports, "DreamGraphReaderAdapter", { enumerable: true, get: function () { return index_js_1.DreamGraphReaderAdapter; } });
Object.defineProperty(exports, "DreamGraphRecorderAdapter", { enumerable: true, get: function () { return index_js_1.DreamGraphRecorderAdapter; } });
Object.defineProperty(exports, "UnboundMcpClient", { enumerable: true, get: function () { return index_js_1.UnboundMcpClient; } });
//# sourceMappingURL=index.js.map