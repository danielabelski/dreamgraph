/**
 * Lightweight instance surface for CLI commands.
 *
 * Keep this module free of bootstrap/scan/tool imports so status/lifecycle
 * commands do not transitively load scanner dependencies such as zod.
 */

export * from "./types.js";
export * from "./registry.js";
export * from "./lifecycle.js";
