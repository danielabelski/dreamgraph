"use strict";
// STRICT ISOLATION (ADR-140): no import from v1.
// Slice 6 — public surface.
Object.defineProperty(exports, "__esModule", { value: true });
exports.buildEnrichmentTask = exports.enrichmentForFallback = exports.isGap = exports.isSparseMode = exports.isGraphAmplified = exports.chooseCapabilityPath = exports.EMPTY_DENSITY_PROBE = exports.measureDensity = exports.getCapability = exports.CAPABILITY_MATRIX = void 0;
var matrix_js_1 = require("./matrix.js");
Object.defineProperty(exports, "CAPABILITY_MATRIX", { enumerable: true, get: function () { return matrix_js_1.CAPABILITY_MATRIX; } });
Object.defineProperty(exports, "getCapability", { enumerable: true, get: function () { return matrix_js_1.getCapability; } });
var density_js_1 = require("./density.js");
Object.defineProperty(exports, "measureDensity", { enumerable: true, get: function () { return density_js_1.measureDensity; } });
Object.defineProperty(exports, "EMPTY_DENSITY_PROBE", { enumerable: true, get: function () { return density_js_1.EMPTY_DENSITY_PROBE; } });
var selection_js_1 = require("./selection.js");
Object.defineProperty(exports, "chooseCapabilityPath", { enumerable: true, get: function () { return selection_js_1.chooseCapabilityPath; } });
Object.defineProperty(exports, "isGraphAmplified", { enumerable: true, get: function () { return selection_js_1.isGraphAmplified; } });
Object.defineProperty(exports, "isSparseMode", { enumerable: true, get: function () { return selection_js_1.isSparseMode; } });
Object.defineProperty(exports, "isGap", { enumerable: true, get: function () { return selection_js_1.isGap; } });
var enrichment_js_1 = require("./enrichment.js");
Object.defineProperty(exports, "enrichmentForFallback", { enumerable: true, get: function () { return enrichment_js_1.enrichmentForFallback; } });
Object.defineProperty(exports, "buildEnrichmentTask", { enumerable: true, get: function () { return enrichment_js_1.buildEnrichmentTask; } });
//# sourceMappingURL=index.js.map