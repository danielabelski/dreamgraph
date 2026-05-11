"use strict";
// architect-v2/autonomy/index.ts
// Slice 3 — Public surface of the autonomy module.
//
// External consumers (orchestrator, settings UI, future slices) import from
// here. Internal files cross-import directly.
Object.defineProperty(exports, "__esModule", { value: true });
exports.buildContinuationPrompt = exports.detectNoProgress = exports.filterByCapability = exports.rankActions = exports.deriveNextAction = exports.createCapabilityInventory = exports.createStubCapabilityInventory = exports.createContinuationNeed = exports.deriveBudgetView = exports.isTimeBudgetExhausted = exports.remainingMs = exports.elapsedMs = exports.createTimeBudget = exports.consumePass = exports.createPassBudget = exports.getModeProfile = exports.MODE_PROFILES = void 0;
var modes_1 = require("./modes");
Object.defineProperty(exports, "MODE_PROFILES", { enumerable: true, get: function () { return modes_1.MODE_PROFILES; } });
Object.defineProperty(exports, "getModeProfile", { enumerable: true, get: function () { return modes_1.getModeProfile; } });
var budget_1 = require("./budget");
Object.defineProperty(exports, "createPassBudget", { enumerable: true, get: function () { return budget_1.createPassBudget; } });
Object.defineProperty(exports, "consumePass", { enumerable: true, get: function () { return budget_1.consumePass; } });
Object.defineProperty(exports, "createTimeBudget", { enumerable: true, get: function () { return budget_1.createTimeBudget; } });
Object.defineProperty(exports, "elapsedMs", { enumerable: true, get: function () { return budget_1.elapsedMs; } });
Object.defineProperty(exports, "remainingMs", { enumerable: true, get: function () { return budget_1.remainingMs; } });
Object.defineProperty(exports, "isTimeBudgetExhausted", { enumerable: true, get: function () { return budget_1.isTimeBudgetExhausted; } });
Object.defineProperty(exports, "deriveBudgetView", { enumerable: true, get: function () { return budget_1.deriveBudgetView; } });
var signals_1 = require("./signals");
Object.defineProperty(exports, "createContinuationNeed", { enumerable: true, get: function () { return signals_1.createContinuationNeed; } });
var capability_1 = require("./capability");
Object.defineProperty(exports, "createStubCapabilityInventory", { enumerable: true, get: function () { return capability_1.createStubCapabilityInventory; } });
Object.defineProperty(exports, "createCapabilityInventory", { enumerable: true, get: function () { return capability_1.createCapabilityInventory; } });
var decision_1 = require("./decision");
Object.defineProperty(exports, "deriveNextAction", { enumerable: true, get: function () { return decision_1.deriveNextAction; } });
Object.defineProperty(exports, "rankActions", { enumerable: true, get: function () { return decision_1.rankActions; } });
Object.defineProperty(exports, "filterByCapability", { enumerable: true, get: function () { return decision_1.filterByCapability; } });
Object.defineProperty(exports, "detectNoProgress", { enumerable: true, get: function () { return decision_1.detectNoProgress; } });
Object.defineProperty(exports, "buildContinuationPrompt", { enumerable: true, get: function () { return decision_1.buildContinuationPrompt; } });
//# sourceMappingURL=index.js.map