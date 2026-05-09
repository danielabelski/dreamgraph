# 10. Installation and lifecycle

[← Trust](09-trust-and-security.md) · [Next: Telemetry & testing →](11-telemetry-debugging-testing.md)

## 10.1 Discovery roots

The host scans exactly two roots:

1. `<instance>/plugins/*/plugin.json` — folder-style.
2. `<instance>/instance.json:plugins[]` — explicit `[{ path, trusted }]` entries.

Anything elsewhere on disk is ignored. There is no `node_modules` auto-scan.

## 10.2 The five lifecycle states

```
        discover
        ───────►   discovered
                       │
                trust + switch
                       ▼
                    loading
                       │
                  activate(ctx)
            ┌──────────┴──────────┐
            ▼                     ▼
          loaded              quarantined
            │                     ▲
       disable / shutdown      error
            ▼                     │
         unloading               (any handler reject /
            │                     manifest invalid /
            ▼                     watchdog stall /
        unloaded                  effect undeclared)
```

`system://plugins` exposes the current state for every plugin, plus the last
seen effects, last error reason, and last activation timestamp.

## 10.3 The CLI

```pwsh
dg plugin list <instance>                    # all discovered plugins + state
dg plugin inspect <instance> <plugin-id>     # full manifest + last telemetry
dg plugin trust <instance> <plugin-id>       # set instance.json:plugins[].trusted=true
dg plugin enable <instance> <plugin-id>      # untrust → trust + re-activate
dg plugin disable <instance> <plugin-id>     # prune contributions, keep entry
```

After any change to the plugin's code (or to the SDK or host packages), restart
the daemon: `dg restart <instance>`.

## 10.4 Hot reload

There is no automatic file-watcher. Each plugin is loaded once per daemon
process. To pick up code changes:

1. Edit the plugin source.
2. (If you bundled it) re-build.
3. `dg plugin disable <instance> <plugin-id>` then
   `dg plugin enable <instance> <plugin-id>`. The host calls your `deactivate()`
   then re-imports the entry module and calls `activate(ctx)` again.

ESM module caching means the host bypasses the cache by appending a unique
query-string to the import URL on re-enable. You do not have to do anything.

## 10.5 Shipping inside a workspace

If your plugin lives in the same npm workspace as the daemon (rare), declare it
in the host's install pipeline so [scripts/install.ps1](../../../scripts/install.ps1)
packs it into `bin/vendor/`. Otherwise, ship the plugin folder with `plugin.json`
and the compiled entry module — that is the entire deliverable.

## 10.6 Versioning and compatibility

- Bump `version` on every change that affects the manifest, the seam shape, or
  the public behavior of your tools/resources.
- Keep `engine.dreamgraph` narrow but accurate. The host emits a clear
  `engine_version_mismatch` rather than a runtime crash if the range excludes
  the current engine.
- The SDK follows semver. Stable event payload shapes never change in a
  backwards-incompatible way within a major. Experimental kinds may.

[← Trust](09-trust-and-security.md) · [Next: Telemetry & testing →](11-telemetry-debugging-testing.md)
