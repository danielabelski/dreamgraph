# 3. Anatomy of a plugin

[← Quickstart](02-quickstart.md) · [Next: Manifest →](04-manifest-and-capabilities.md)

## 3.1 Required files

```
my-plugin/
├── plugin.json        # manifest, validated by @dreamgraph/sdk
├── index.js           # ESM entry (path declared as `main` in manifest)
├── package.json       # optional but recommended; "type": "module"
└── README.md          # optional; appears next to dg plugin inspect
```

Anything else (build artifacts, fixtures, sub-modules) is fine. The host loads
**only** the file referenced by `manifest.main`. Imports inside that file are
resolved by Node's standard ESM resolver against the plugin folder.

## 3.2 Module format — ESM only

The host loads plugins via dynamic `import()`. Every plugin entry MUST be an ES
module. CommonJS is not supported. Either:

- Set `"type": "module"` in the plugin's `package.json`, or
- Use the `.mjs` extension for the entry file.

If you write the plugin in TypeScript, ship the compiled JavaScript and point
`main` at the build output:

```json
{ "main": "./dist/index.js" }
```

## 3.3 The entry contract

The entry module must default-export `activate(ctx)`:

```js
export const meta = { id: "acme.changelog", version: "0.1.0" };

export default function activate(ctx) {
  ctx.logger.info("activating");

  // Register seams synchronously inside activate(). Returning a promise is
  // allowed but the host counts the plugin as "loaded" once activate() resolves.
  ctx.tools.register({ /* ... */ });

  return {
    deactivate() {
      // Optional. The host calls this on dg plugin disable / instance shutdown.
      // Use it to flush in-flight state. Contributions registered through ctx
      // are pruned automatically — you do not need to call unregister manually.
    },
  };
}
```

`activate(ctx)` may also be `async`. The host awaits it. If `activate` throws
(or the returned promise rejects), the host emits `plugin.errored` with
`reason: "handler_threw"` and the plugin is quarantined.

## 3.4 Dependencies

The SDK ships with **zero runtime dependencies** beyond `zod` (which the daemon
already bundles). For the M3 trusted-in-process model:

- You **may** use any npm package. The host does not constrain `node_modules`.
- You **should** keep dependencies small and well-known. Plugin dependencies
  live in the daemon's process and inherit its trust.
- You **must not** depend on the daemon's internals (`src/...`). The only
  supported import is `@dreamgraph/sdk`. The daemon's source is not
  re-exported and may change between releases.

## 3.5 What the host passes you

`activate(ctx)` receives a fully constructed `PluginContext`. The full shape is
documented in [§5 The PluginContext](05-plugin-context.md). The shortlist:

- `ctx.plugin.{id,version}`
- `ctx.instance.uuid`
- `ctx.logger.{debug,info,warn,error}`
- `ctx.events.{subscribe,emit}`
- `ctx.tools.register`
- `ctx.resources.register`
- `ctx.ui.register`
- `ctx.policies.propose`
- `ctx.archetypes.registerProvider`
- `ctx.markdownFences.register`
- `ctx.signal` — `AbortSignal`, aborted on disable / handler timeout

[← Quickstart](02-quickstart.md) · [Next: Manifest →](04-manifest-and-capabilities.md)
