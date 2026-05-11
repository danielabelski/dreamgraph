"use strict";
// Slice 8A.2 — public surface for the prompts sub-module.
//
// Re-exports the default composer and the synchronous formatter (for
// golden-file tests). Keep this file thin; do not add prompt logic here.
Object.defineProperty(exports, "__esModule", { value: true });
exports.presetAutonomyAddendum = exports.applyPreset = exports.getTaskPreset = exports.TASK_PRESETS = exports.declareContextRequirements = exports.composePromptSync = exports.DefaultPromptComposer = void 0;
var composer_js_1 = require("./composer.js");
Object.defineProperty(exports, "DefaultPromptComposer", { enumerable: true, get: function () { return composer_js_1.DefaultPromptComposer; } });
Object.defineProperty(exports, "composePromptSync", { enumerable: true, get: function () { return composer_js_1.composePromptSync; } });
var requirements_js_1 = require("./requirements.js");
Object.defineProperty(exports, "declareContextRequirements", { enumerable: true, get: function () { return requirements_js_1.declareContextRequirements; } });
var task_presets_js_1 = require("./task-presets.js");
Object.defineProperty(exports, "TASK_PRESETS", { enumerable: true, get: function () { return task_presets_js_1.TASK_PRESETS; } });
Object.defineProperty(exports, "getTaskPreset", { enumerable: true, get: function () { return task_presets_js_1.getTaskPreset; } });
Object.defineProperty(exports, "applyPreset", { enumerable: true, get: function () { return task_presets_js_1.applyPreset; } });
Object.defineProperty(exports, "presetAutonomyAddendum", { enumerable: true, get: function () { return task_presets_js_1.presetAutonomyAddendum; } });
//# sourceMappingURL=index.js.map