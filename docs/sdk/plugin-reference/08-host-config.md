# Host configuration (normative)

[← Index](00-index.md)

## Environment variables

| Variable                          | Default | Effect                                                                       |
| --------------------------------- | ------- | ---------------------------------------------------------------------------- |
| `DG_ALLOW_INPROCESS_PLUGINS`      | `false` | Master kill switch for in-process plugin execution. While `false`, no plugin loads even if `trusted: true`. |
| `DG_EVENT_LOOP_LAG_MS`            | `250`   | Watchdog threshold (milliseconds). Stalls above this while a plugin handler is on the call stack are reported as `event_loop_stall`. |
| `DG_PLUGIN_HANDLER_TIMEOUT_MS`    | `5000`  | Per-handler wall-clock budget. Exceeded handlers emit `handler_timeout` and quarantine the plugin. |
| `DG_PLUGIN_LLM_BUDGET_PCT`        | `10`    | (post-M4) Percentage of host LLM budget reserved for plugins as a slice. |
| `WEBHOOK_FAST_BACKOFF`            | unset   | When set, replaces the spec backoff schedule with `1s/2s/4s/8s/16s` for live testing. |

The Plugin System block in all three engine.env templates (`default`, `ollama`,
`lmstudio`) lists `DG_ALLOW_INPROCESS_PLUGINS` with the safety wording:

```dotenv
# --- Plugin System ---
# DG_ALLOW_INPROCESS_PLUGINS=true   # Enable in-process plugins (potentially unsafe, use with trusted code only)
```

## `instance.json`

```jsonc
{
  "uuid": "...",
  "experimental_plugins": false,
  "plugins": [
    { "path": "plugins/examples.hello-events", "trusted": true },
    { "path": "plugins/acme.changelog",        "trusted": false }
  ]
}
```

| Field                              | Type                | Effect                                                              |
| ---------------------------------- | ------------------- | ------------------------------------------------------------------- |
| `experimental_plugins`             | boolean (default `false`) | Required for any plugin holding `events:read:experimental`. |
| `plugins[].path`                   | string              | Absolute or instance-relative path to the plugin folder.            |
| `plugins[].trusted`                | boolean (default `false`) | Per-plugin trust opt-in. Combined AND with `DG_ALLOW_INPROCESS_PLUGINS`. |
| `plugins[].llm_budget`             | number (post-M4)    | Override the per-plugin LLM sub-quota.                              |

The host MUST de-duplicate `plugins[]` entries by `path` on write to prevent
the duplicate-entry pathology that affected pre-8.3.0 engines after multiple
`dg plugin trust` invocations.

## Discovery roots (recap)

The host scans exactly two locations:

1. `<instance>/plugins/*/plugin.json` (folder-style auto-discovery).
2. `instance.json:plugins[].path` (explicit registration).

There is no `node_modules` scan. There is no auto-discovery from outside the
instance directory.
