"use strict";
// Slice 8A.3 — public surface for the context sub-module.
Object.defineProperty(exports, "__esModule", { value: true });
exports.NullContextDiscoveryRecorder = exports.NULL_RECENT_HISTORY = exports.NULL_ENVIRONMENT = exports.NullFallbackSignalProvider = exports.allocateBudget = exports.DefaultContextBuilder = void 0;
var builder_js_1 = require("./builder.js");
Object.defineProperty(exports, "DefaultContextBuilder", { enumerable: true, get: function () { return builder_js_1.DefaultContextBuilder; } });
Object.defineProperty(exports, "allocateBudget", { enumerable: true, get: function () { return builder_js_1.allocateBudget; } });
var fallback_signals_js_1 = require("./fallback-signals.js");
Object.defineProperty(exports, "NullFallbackSignalProvider", { enumerable: true, get: function () { return fallback_signals_js_1.NullFallbackSignalProvider; } });
Object.defineProperty(exports, "NULL_ENVIRONMENT", { enumerable: true, get: function () { return fallback_signals_js_1.NULL_ENVIRONMENT; } });
Object.defineProperty(exports, "NULL_RECENT_HISTORY", { enumerable: true, get: function () { return fallback_signals_js_1.NULL_RECENT_HISTORY; } });
// Slice 8A.4 — ContextDiscoveryRecorder port (ADR-177)
var discovery_recorder_js_1 = require("./discovery-recorder.js");
Object.defineProperty(exports, "NullContextDiscoveryRecorder", { enumerable: true, get: function () { return discovery_recorder_js_1.NullContextDiscoveryRecorder; } });
//# sourceMappingURL=index.js.map