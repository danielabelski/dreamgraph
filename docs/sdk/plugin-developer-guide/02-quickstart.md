# 2. Quickstart — Hello Events in five minutes

[← Introduction](01-introduction.md) · [Next: Anatomy →](03-anatomy.md)

This walkthrough installs the bundled `examples.hello-events` reference plugin into
a running DreamGraph instance and exercises every seam. It is the fastest way to
confirm your environment is correctly configured.

## 2.1 Prerequisites

- DreamGraph v9.0.0 or later, installed (`dg --version`).
- A live instance UUID (`dg list`).
- An MCP-capable client to call the contributed tool (the VS Code extension,
  Claude Desktop, `mcp inspector`, or a script using
  `@modelcontextprotocol/sdk`).

## 2.2 Allow in-process plugins (host switch)

In-process plugin execution is **deny-by-default**. Add the line to your
instance's `engine.env` (or set the env var before launching the daemon):

```dotenv
DG_ALLOW_INPROCESS_PLUGINS=true
```

The switch and its caveats are documented in all three engine.env templates
([default](../../../templates/default/config/engine.env),
[ollama](../../../templates/ollama/config/engine.env),
[lmstudio](../../../templates/lmstudio/config/engine.env)).

## 2.3 Copy the example into the instance

```pwsh
$uuid = "<your-instance-uuid>"
Copy-Item -Recurse examples/hello-events `
  "$env:USERPROFILE\.dreamgraph\instances\$uuid\plugins\examples.hello-events"
```

DreamGraph discovers plugins from two roots only:

1. `<instance>/plugins/*/plugin.json`
2. `instance.json:plugins[]` (declared paths)

There is no auto-discovery from arbitrary `node_modules`.

## 2.4 Trust the plugin

```pwsh
dg plugin trust dreamgraph examples.hello-events
dg restart dreamgraph
```

`dg plugin trust` flips the `trusted: true` flag in `instance.json:plugins[]`.
A plugin must be trusted **and** the host switch must be on for in-process
loading to occur.

On startup you will see a one-line trust banner per loaded plugin:

```
plugin examples.hello-events@0.2.0 loaded with FULL HOST TRUST (in-process)
```

## 2.5 Inspect what loaded

```pwsh
dg plugin list dreamgraph
dg plugin inspect dreamgraph examples.hello-events
```

The host exposes a live `system://plugins` MCP resource with the same data:
status, intent, runtime, declared and last-seen effects.

## 2.6 Call the contributed MCP tool

DreamGraph does not ship a CLI shortcut for invoking tools. Use any MCP client.
The bundled probe script does it via the streamable HTTP transport:

```pwsh
node scripts/probe-hello-events.mjs
```

Expected output:

```
tool examples.hello-events.greet  →  { "greeting": "Hello, world!" }
resource plugin://examples.hello-events/manifest  →  { id: "...", version: "0.2.0", seams: [...] }
```

## 2.7 Verify the closure-seam side-effects

Each closure seam writes through a host-locked store and prunes on unload:

```pwsh
$data = "$env:USERPROFILE\.dreamgraph\instances\$uuid\data"
Get-Content "$data\ui_registry.json"               # contains examples.hello-events.greeting
Get-Content "$data\plugin_policy_proposals.json"   # contains source: plugin:examples.hello-events
```

Disable the plugin and watch every contribution disappear:

```pwsh
dg plugin disable dreamgraph examples.hello-events
```

The UI element, policy proposal, archetype provider, and markdown fence are all
removed automatically.

## 2.8 What you just exercised

| Seam              | Where to look |
| ----------------- | ------------- |
| `events.subscribe`| `dg plugin inspect` shows declared `events:read` + a subscriber on `snapshot.changed`. |
| `events.emit`     | The `examples.hello-events.activated` event appears on the bus / SSE stream. |
| `tools.register`  | `tools/list` over MCP shows `examples.hello-events.greet`. |
| `resources.register`| `resources/list` shows `plugin://examples.hello-events/manifest`. |
| `ui.register`     | `ui_registry.json` gains a tagged entry. |
| `policies.propose`| `plugin_policy_proposals.json` gains a `source: plugin:examples.hello-events` entry. |
| `archetypes.registerProvider` | `system://plugins` lists the inline provider. |
| `markdownFences.register` | The webview SDK can introspect language `dg-hello`. |

[← Introduction](01-introduction.md) · [Next: Anatomy →](03-anatomy.md)
