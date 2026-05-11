"use strict";
// architect-v2 — Public surface
// Loaded by extensions/vscode/src/extension.ts when the v2 feature flag is on.
// All v2 work lands here per ADR-140 (parallel folder).
// Do not import from v1 files; the two surfaces are isolated until the v10.0.0 cutover (ADR-141).
Object.defineProperty(exports, "__esModule", { value: true });
exports.UnboundMcpClient = exports.InMemoryKeyValueStore = exports.createArchitectHost = exports.ARCHITECT_V2_SKELETON_VERSION = void 0;
exports.ARCHITECT_V2_SKELETON_VERSION = "0.0.0-slice1";
// Slice 8A.5: host wiring is the single entry point the cutover commit
// will call. extension.ts: createArchitectHost({...}) → host.runPass(...).
var index_js_1 = require("./host/index.js");
Object.defineProperty(exports, "createArchitectHost", { enumerable: true, get: function () { return index_js_1.createArchitectHost; } });
Object.defineProperty(exports, "InMemoryKeyValueStore", { enumerable: true, get: function () { return index_js_1.InMemoryKeyValueStore; } });
Object.defineProperty(exports, "UnboundMcpClient", { enumerable: true, get: function () { return index_js_1.UnboundMcpClient; } });
//# sourceMappingURL=index.js.map