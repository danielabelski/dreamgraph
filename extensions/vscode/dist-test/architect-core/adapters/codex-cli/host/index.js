"use strict";
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Codex CLI adapter - host runtime ports (Slice 3).
Object.defineProperty(exports, "__esModule", { value: true });
exports.HOST_PROCESS = exports.HOST_FS = exports.HOST_CRYPTO = exports.HOST_CLOCK = void 0;
var clock_adapter_js_1 = require("./clock-adapter.js");
Object.defineProperty(exports, "HOST_CLOCK", { enumerable: true, get: function () { return clock_adapter_js_1.HOST_CLOCK; } });
var crypto_adapter_js_1 = require("./crypto-adapter.js");
Object.defineProperty(exports, "HOST_CRYPTO", { enumerable: true, get: function () { return crypto_adapter_js_1.HOST_CRYPTO; } });
var fs_adapter_js_1 = require("./fs-adapter.js");
Object.defineProperty(exports, "HOST_FS", { enumerable: true, get: function () { return fs_adapter_js_1.HOST_FS; } });
var process_adapter_js_1 = require("./process-adapter.js");
Object.defineProperty(exports, "HOST_PROCESS", { enumerable: true, get: function () { return process_adapter_js_1.HOST_PROCESS; } });
//# sourceMappingURL=index.js.map