# 11. Telemetry, debugging, and testing

[← Lifecycle](10-lifecycle-and-installation.md) · [Next: Best practices →](12-best-practices.md)

## 11.1 The plugin telemetry kinds

Every plugin emits a uniform telemetry stream. Operators (and your tests) can
subscribe to these on the bus to understand exactly what the host is doing on
your behalf.

| Kind                         | Emitted when                                       |
| ---------------------------- | -------------------------------------------------- |
| `plugin.loaded`              | Manifest accepted, all seams wired.                |
| `plugin.unloaded`            | Graceful disable / shutdown.                       |
| `plugin.errored`             | Manifest rejection, capability violation, throw, watchdog stall. |
| `plugin.handler.started`     | A handler/tool/action is about to run (correlation id). |
| `plugin.handler.completed`   | Handler returned successfully (`duration_ms`).     |
| `plugin.output.accepted`     | Host wrote/forwarded/dispatched the plugin's output. |
| `plugin.output.rejected`     | Host refused (carries `reason`, see [reject reasons](../plugin-reference/04-reject-reasons.md)). |

Every telemetry event carries `plugin_id`, `plugin_version`, and the seam
involved. `plugin.output.rejected` additionally carries the `reason` code from
the central enum and a human-readable `message`.

## 11.2 Reading telemetry while developing

Three options:

- **Daemon log** — every `plugin.errored` and `plugin.output.rejected` is
  printed.
- **SSE** — `curl -N http://127.0.0.1:8010/explorer/api/events` streams the
  whole bus.
- **`event_log.json`** — under the instance data dir, the persistent record.

For tests, [tests/plugins/hello-events-e2e.test.ts](../../../tests/plugins/hello-events-e2e.test.ts)
shows how to assert the exact telemetry sequence in a temp instance.

## 11.3 Testing

The SDK ships a phased test harness:

| Phase | Surface                                                              | Use for                                  |
| ----- | -------------------------------------------------------------------- | ---------------------------------------- |
| 1     | Manifest validation fixtures (schema-only)                           | unit tests; no runtime, no bus.          |
| 2     | Seam mocks: fake `PluginContext`, stub bus, in-memory `system://plugins` | unit-test a tool handler or subscriber. |
| 3     | Full in-memory daemon harness (post-MVP, opens with M7)              | E2E with real persistence and bus.      |

For Phase-1/2 in your own repo:

```ts
import { parsePluginManifest } from "@dreamgraph/sdk";
import manifest from "../plugin.json" assert { type: "json" };

it("manifest parses", () => {
  expect(() => parsePluginManifest(manifest)).not.toThrow();
});
```

For an end-to-end check, copy your plugin folder into a temp instance and
assert against `ui_registry.json` / `plugin_policy_proposals.json` /
`event_log.json`. The hello-events e2e test is a working template.

## 11.4 Common debugging recipes

- **Tool not appearing in `tools/list`?** The plugin probably did not load.
  Check the daemon log for the trust banner. If it's missing, check
  `DG_ALLOW_INPROCESS_PLUGINS` and `dg plugin list` (the entry must show
  `trusted: true`).
- **Tool args arrive as `undefined`?** Earlier engine versions had a bug where
  the MCP tool was registered with an empty Zod shape (the JSON Schema wasn't
  converted). Fixed in v8.3.0; if you see this, upgrade.
- **Handler throws `EventEmitter` warning?** You probably called
  `ctx.events.subscribe` inside a handler instead of inside `activate(ctx)`.
  All subscriptions should happen in `activate`.
- **`plugin.output.rejected{ reason: "effect_undeclared" }`?** You emitted a
  side-effect (event, registration) whose effect is not in the manifest's
  `expectedEffects`. Add the effect or remove the call.

[← Lifecycle](10-lifecycle-and-installation.md) · [Next: Best practices →](12-best-practices.md)
