# `dg plugin` CLI (normative)

[← Index](00-index.md)

All commands take the instance name (or UUID) as the first positional argument.

## `dg plugin list <instance>`

Lists every discovered plugin with its current state.

```pwsh
dg plugin list dreamgraph
```

Output columns: `id`, `version`, `state`, `runtime`, `trusted`, `last_loaded_at`.

## `dg plugin inspect <instance> <plugin-id>`

Prints the full validated manifest, last seen effects, last activation
timestamp, last error reason (if any), and the path to the plugin folder.

## `dg plugin trust <instance> <plugin-id>`

Sets `trusted: true` on the plugin's entry in `instance.json:plugins[]`. Does
not load or restart the daemon. Run `dg restart <instance>` to apply.

## `dg plugin enable <instance> <plugin-id>`

Marks the plugin trusted (if not already) and triggers an in-place
activate-cycle: calls `deactivate()` if the plugin is currently loaded, then
re-imports the entry module (cache-busted) and calls `activate(ctx)`.

## `dg plugin disable <instance> <plugin-id>`

Calls `deactivate()`, prunes every contribution registered through `ctx`
(tools, resources, UI, policy proposals, archetype providers, markdown
fences), and unsubscribes every event handler. The plugin entry remains in
`instance.json` so a future `enable` reuses the same identity.

## Notes

- The `dg plugin` family does not invoke MCP tools or read MCP resources.
  Use any MCP client (VS Code extension, Claude Desktop, `mcp inspector`) for
  that.
- `dg plugin trust` is idempotent. Repeated runs **must not** create duplicate
  entries in `instance.json:plugins[]` (a known issue in earlier engine
  versions; v8.3.0 deduplicates on write).
- All commands exit non-zero on error; standard `--json` flag is reserved for a
  future release.
