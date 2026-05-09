# hello-events — DreamGraph reference plugin (v0.2.0)

End-to-end smoke surface for the in-process plugin host. Demonstrates
**every** seam shipped through M6 closure:

| Seam                          | Capability                | Effect                  |
| ----------------------------- | ------------------------- | ----------------------- |
| `events.subscribe`            | `events:read`             | —                       |
| `events.emit`                 | `events:emit`             | `emit_event`            |
| `tools.register`              | `tools:register`          | `emit_tool`             |
| `resources.register`          | `resources:register`      | `emit_resource`         |
| `ui.register`                 | `ui:register`             | `mutate_ui_registry`    |
| `policies.propose`            | `policy:propose`          | `propose_policy`        |
| `archetypes.registerProvider` | `archetypes:provide`      | `provide_archetypes`    |
| `markdownFences.register`     | `markdown:register_fence` | `render_markdown_fence` |

All contributions are gated by the host: missing capability or undeclared
effect produces a `plugin.output.rejected` telemetry event and the
contribution is dropped without aborting activation.

## Try it

1. Copy this folder into a DreamGraph instance:

   ```pwsh
   Copy-Item -Recurse examples/hello-events `
     "$env:USERPROFILE\.dreamgraph\instances\<uuid>\plugins\examples.hello-events"
   ```

2. Allow in-process plugins:

   ```pwsh
   $env:DG_ALLOW_INPROCESS_PLUGINS = "true"
   ```

3. Mark it trusted (required for the host to actually load the module):

   ```pwsh
   dg plugin trust dreamgraph examples.hello-events
   dg restart dreamgraph
   ```

4. Inspect everything the plugin contributed:

   ```pwsh
   dg plugin list dreamgraph
   dg plugin inspect dreamgraph examples.hello-events
   ```

   The contributed tool (`examples.hello-events.greet`) and resource
   (`plugin://examples.hello-events/manifest`) are exposed over MCP and can
   be invoked from any MCP client (the VS Code extension, Claude Desktop,
   `mcp inspector`, etc.) — DreamGraph does not ship a CLI shortcut for
   calling tools or reading resources directly.

5. Verify side-effects landed in the instance store:

   ```pwsh
   # UI element (provenance tag plugin:examples.hello-events)
   Get-Content "$env:USERPROFILE\.dreamgraph\instances\<uuid>\data\ui_registry.json"

   # Policy proposal (source: plugin:examples.hello-events)
   Get-Content "$env:USERPROFILE\.dreamgraph\instances\<uuid>\data\plugin_policy_proposals.json"
   ```

6. Hot-disable and confirm pruning:

   ```pwsh
   dg plugin disable dreamgraph examples.hello-events
   ```

   The UI element, policy proposal, archetype provider, and markdown fence
   contributed by this plugin are removed automatically.

## What this plugin still does NOT do

- Write directly into the internal graph (`write_internal_graph` is in
  `forbiddenEffects`).
- Use the post-1.0 executable iframe surface (§4.7).
- Poll a live `url` — the archetype provider is `inline` only; live
  polling is exercised separately by federation tests.
