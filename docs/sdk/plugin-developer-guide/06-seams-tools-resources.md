# 6. Seams: tools and resources

[← PluginContext](05-plugin-context.md) · [Next: Events →](07-seams-events.md)

These two seams ship plugin output over MCP. They are the most common reason to
write a plugin.

## 6.1 Tools — `ctx.tools.register`

```js
ctx.tools.register({
  name: "acme.changelog.summarize_week",     // MUST start with "<plugin-id>."
  description: "Summarize the last N days of validated edges.",
  inputSchema: {
    type: "object",
    properties: { days: { type: "integer", minimum: 1 } },
    required: ["days"],
  },
  expectedEffects: ["emit_tool"],
  handler: async ({ days }, _extra) => {
    return { summary: `Last ${days} days...` };
  },
});
```

### Naming (mandatory)

The tool `name` must:

- be lowercase,
- start with the plugin id followed by `.`,
- carry the primary semantics of the operation (ADR-128).

`acme.changelog.summarize_week` ✅
`acme.changelog.process` ❌ (no semantic verb-target)
`summarize_week` ❌ (no plugin prefix → `tool_name_unprefixed`)

### Input schema

You write a JSON Schema, the host converts it to a Zod shape and uses that to
validate `args` before calling your handler. Supported keywords today:

- `type: "object" | "string" | "number" | "integer" | "boolean" | "array"`
- `properties`, `required`, `items`, `enum` (string only),
- `description` (mapped to `.describe()`).

Anything else falls back to `z.unknown()`.

### What the host does for you

- Registers the tool with the MCP `Server.tool()` factory.
- Validates incoming arguments against your schema; invalid args never reach
  your handler.
- Wraps your handler in `plugin.handler.started` / `plugin.handler.completed`
  telemetry with a correlation id.
- Emits `plugin.output.accepted` if the host successfully forwarded your
  output, or `plugin.output.rejected{ reason }` if your handler threw, the
  effect was undeclared, or the tool name was not prefixed.

### What you owe the host

- Return JSON-serializable values from `handler`. The MCP transport encodes the
  return value as the tool's `content`.
- Honor `ctx.signal` for any long-running work.
- Keep your handler under the per-plugin handler timeout (default 5 s for
  in-process; configurable). A handler that hangs is killed and the plugin is
  quarantined with `handler_timeout`.

## 6.2 Resources — `ctx.resources.register`

```js
ctx.resources.register({
  uriNamespace: "plugin://acme.changelog/latest",
  name: "Latest weekly changelog",
  description: "Returns the most recent rendered summary.",
  expectedEffects: ["emit_resource"],
  handler: async () => ({
    rendered_at: new Date().toISOString(),
    body: "## Week ending ...",
  }),
});
```

### URI rules

- MUST start with `plugin://<plugin-id>/`. Anything else →
  `resource_uri_out_of_namespace`.
- The namespace is exact: `plugin://acme.changelog/latest` and
  `plugin://acme.changelog/by-id/123` are two distinct registrations.
- Two plugins cannot collide; the prefix is enforced.

### What the host does

- Exposes the resource over MCP `resources/list` and `resources/read`.
- Routes reads to your handler; the return value is JSON-serialized.
- Emits the same `plugin.output.{accepted,rejected}` telemetry as tools.

[← PluginContext](05-plugin-context.md) · [Next: Events →](07-seams-events.md)
