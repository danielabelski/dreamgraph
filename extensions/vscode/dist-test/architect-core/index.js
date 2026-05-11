"use strict";
// architect-core — v1-native turn-lifecycle seam (ADR-089).
//
// Phase 2: ports + types + pure `runPass()` driver. The driver owns
// the inner agentic loop (provider → tools → provider → … until the
// pass goal is satisfied) and delegates every effect to a port.
// Adapters wiring real chat-panel internals ship in Phase 3.
//
// STRICT v1: this folder MUST NOT import from `architect-v2/`.
// ADR-140 isolation remains binding in both directions.
Object.defineProperty(exports, "__esModule", { value: true });
exports.SYSTEM_CLOCK = exports.DEFAULT_MAX_INNER_ITERATIONS = exports.runPass = void 0;
var pass_js_1 = require("./pass.js");
Object.defineProperty(exports, "runPass", { enumerable: true, get: function () { return pass_js_1.runPass; } });
Object.defineProperty(exports, "DEFAULT_MAX_INNER_ITERATIONS", { enumerable: true, get: function () { return pass_js_1.DEFAULT_MAX_INNER_ITERATIONS; } });
var clock_js_1 = require("./adapters/clock.js");
Object.defineProperty(exports, "SYSTEM_CLOCK", { enumerable: true, get: function () { return clock_js_1.SYSTEM_CLOCK; } });
//# sourceMappingURL=index.js.map