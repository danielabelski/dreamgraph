"use strict";
// architect-v2/providers/index.ts
// Slice 2 — Public surface of the providers module.
//
// External consumers (orchestrator, settings UI, future slices) import from
// here. Internal files cross-import directly.
Object.defineProperty(exports, "__esModule", { value: true });
exports.UnknownModelError = exports.listModelIds = exports.resolveModel = exports.resolveDefaultModel = exports.hasProvider = exports.getProvider = exports.listProviders = exports.createStubAdapter = exports.ProviderAdapterNotImplementedError = exports.ProviderError = void 0;
var adapter_1 = require("./adapter");
Object.defineProperty(exports, "ProviderError", { enumerable: true, get: function () { return adapter_1.ProviderError; } });
Object.defineProperty(exports, "ProviderAdapterNotImplementedError", { enumerable: true, get: function () { return adapter_1.ProviderAdapterNotImplementedError; } });
Object.defineProperty(exports, "createStubAdapter", { enumerable: true, get: function () { return adapter_1.createStubAdapter; } });
var registry_1 = require("./registry");
Object.defineProperty(exports, "listProviders", { enumerable: true, get: function () { return registry_1.listProviders; } });
Object.defineProperty(exports, "getProvider", { enumerable: true, get: function () { return registry_1.getProvider; } });
Object.defineProperty(exports, "hasProvider", { enumerable: true, get: function () { return registry_1.hasProvider; } });
Object.defineProperty(exports, "resolveDefaultModel", { enumerable: true, get: function () { return registry_1.resolveDefaultModel; } });
Object.defineProperty(exports, "resolveModel", { enumerable: true, get: function () { return registry_1.resolveModel; } });
Object.defineProperty(exports, "listModelIds", { enumerable: true, get: function () { return registry_1.listModelIds; } });
Object.defineProperty(exports, "UnknownModelError", { enumerable: true, get: function () { return registry_1.UnknownModelError; } });
//# sourceMappingURL=index.js.map