# 12. Best practices and pitfalls

[← Telemetry & testing](11-telemetry-debugging-testing.md) · [Index ↑](00-index.md)

## 12.1 Do

- **Name everything for the model, not the human.** ADR-128 — tool names must
  carry the dominant action and target. A model should not need your
  description to pick the right tool.
- **Declare every effect.** `expectedEffects` is read by operators and by the
  discipline engine; missing entries are a bug, not a convenience.
- **Use `forbiddenEffects` actively.** `write_internal_graph` and
  `modify_tensions` should be in *every* plugin's `forbiddenEffects` unless
  the plugin's entire reason for existing is graph mutation (rare).
- **Keep handlers fast.** Default timeout is 5 s. Anything slower is either
  awaiting I/O (use `ctx.signal`) or doing CPU work that belongs in a future
  schedule action.
- **Log through `ctx.logger`.** Operators see those lines. `console.log` lines
  do not propagate to the bus.
- **Treat the bus as at-most-once.** Reconstruct critical state from a resource
  read, not from your subscriber buffer.
- **Pin `engine.dreamgraph` accurately.** `>=9.0.0` is the right floor for v1.
- **Ship a README in your plugin folder.** `dg plugin inspect` shows it.

## 12.2 Don't

- **Don't import from `dreamgraph/src/...`.** The only stable import is
  `@dreamgraph/sdk`. Daemon internals change without notice.
- **Don't reach for `fs`, `process`, or `child_process`.** Even though the
  M3 model can't physically stop you, doing so is a trust violation and the
  operator may quarantine your plugin.
- **Don't rely on a shared global between handlers.** The host may call
  `deactivate` and re-`activate` between requests; rebuild state inside
  `activate(ctx)` so a re-enable is clean.
- **Don't poll on a `setInterval`.** Use the schedule action seam once M4
  ships. Until then, recurring work belongs in the host.
- **Don't depend on plugin load order.** Plugins are independent. If your
  plugin needs another plugin's data, read its MCP resource explicitly.
- **Don't ship secrets in `plugin.json` or in the entry module.** The
  manifest is world-readable. Use the per-plugin config block (`config.schema`)
  and document where the operator should put credentials (typically
  `<instance>/config/<plugin-id>.json`).

## 12.3 Pitfalls (compendium)

| Symptom                                            | Likely cause                                                       |
| -------------------------------------------------- | ------------------------------------------------------------------ |
| Plugin shows in `dg plugin list` but no banner     | `DG_ALLOW_INPROCESS_PLUGINS` is false.                             |
| Banner appears, no contributions visible           | Capability missing in `capabilities` array.                        |
| Tool args arrive empty                             | Bug in engine < 8.3.0; upgrade. Or tool registered with no `inputSchema`. |
| `plugin.output.rejected{ effect_undeclared }`      | You emit an event/register a tool whose effect is not in `expectedEffects`. |
| `plugin.output.rejected{ tool_name_unprefixed }`   | Tool name doesn't start with `<plugin-id>.`.                       |
| `plugin.output.rejected{ resource_uri_out_of_namespace }` | Resource URI doesn't start with `plugin://<plugin-id>/`.        |
| `plugin.errored{ event_loop_stall }`               | Handler did synchronous CPU work > `DG_EVENT_LOOP_LAG_MS`.         |
| `plugin.errored{ handler_timeout }`                | Handler didn't return inside the timeout; honor `ctx.signal`.      |
| `plugin.errored{ engine_version_mismatch }`        | `engine.dreamgraph` semver excludes this engine.                   |
| Webhook never fires for your custom event          | The webhook subscription's `events[]` doesn't list your kind.      |

## 12.4 The shipping checklist

Before publishing a plugin:

- [ ] Manifest validates against `parsePluginManifest`.
- [ ] Every tool/resource/UI/policy id is `<plugin-id>.*`.
- [ ] Every effect the plugin performs is in `expectedEffects`.
- [ ] `forbiddenEffects` contains everything the plugin guarantees not to do.
- [ ] README explains: install steps, required config, what each tool returns.
- [ ] Manifest tested with at least one manifest fixture test.
- [ ] Hello-world tool round-trips an argument over MCP.
- [ ] On `dg plugin disable`, all contributions are gone (manual `Get-Content` on the four data files confirms this).
- [ ] Trust banner appears on load; `system://plugins` shows `status: "loaded"`.

[← Telemetry & testing](11-telemetry-debugging-testing.md) · [Index ↑](00-index.md)
