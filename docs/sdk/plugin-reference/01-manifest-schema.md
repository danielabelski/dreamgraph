# Manifest schema (normative)

[← Index](00-index.md) · Source: [packages/sdk/src/manifest.ts](../../../packages/sdk/src/manifest.ts)

## Top-level shape

```ts
interface PluginManifest {
  id:                  string;                      // PluginIdSchema
  version:             string;                      // ≥ 1 char
  displayName:         string;                      // ≥ 1 char
  description?:        string;
  author?:             string;
  license?:            string;
  engine:              { dreamgraph: string };      // semver range
  main:                string;                      // path to ESM entry
  intent:              string;
  expectedEffects:     PluginEffect[];              // ≥ 1
  forbiddenEffects:    PluginEffect[];              // default []
  capabilities:        PluginCapability[];          // ≥ 1
  tools:               { name: string }[];          // default []
  resources:           { uriNamespace: string }[];  // default []
  ui:                  { id: string }[];            // default []
  policies:            { id: string }[];            // default []
  archetypeProviders:  { id: string }[];            // default []
  markdownFences:      { language: string }[];      // default []
  architectTabs:       PluginManifestArchitectTab[]; // default []
  policy:              PluginPolicy;                // default { phasePermissions: [], writableFiles: [] }
  config?:             { schema?: string };
}
```

The schema is **strict**: unknown top-level fields are rejected with
`manifest_invalid`.

## Field-level constraints

| Field                              | Constraint                                                           | Reject reason on violation             |
| ---------------------------------- | -------------------------------------------------------------------- | -------------------------------------- |
| `id`                               | `^[a-z0-9][a-z0-9.-]*[a-z0-9]$`, ≥ 3 chars                           | `manifest_invalid`                     |
| `version`                          | non-empty string (semver recommended)                                | `manifest_invalid`                     |
| `engine.dreamgraph`                | semver range; host engine version MUST satisfy it                    | `engine_version_mismatch`              |
| `main`                             | non-empty path; resolved relative to plugin folder                   | `manifest_invalid`                     |
| `intent`                           | ≥ 1 char                                                             | `manifest_invalid`                     |
| `expectedEffects`                  | ≥ 1 entry, each in `PluginEffect`                                    | `manifest_invalid`                     |
| `forbiddenEffects`                 | each in `PluginEffect`                                                | `manifest_invalid`                     |
| `expectedEffects ∩ forbiddenEffects` | MUST be empty                                                       | `manifest_invalid`                     |
| `capabilities`                     | ≥ 1 entry, each in `PluginCapability`                                | `manifest_invalid`                     |
| `tools[].name`                     | `<plugin-id>.<tool>` — `^[a-z0-9][a-z0-9.-]*\.[a-z0-9][a-z0-9_-]*$`  | `tool_name_unprefixed`                 |
| `resources[].uriNamespace`         | `^plugin:\/\/<plugin-id>(?:\/.*)?$`                                  | `resource_uri_out_of_namespace`        |
| `ui[].id`                          | lowercase `[a-z0-9._-]+`                                              | `ui_id_unprefixed` (at register time)  |
| `policies[].id`                    | lowercase `[a-z0-9._-]+`                                              | `manifest_invalid`                     |
| `archetypeProviders[].id`          | lowercase `[a-z0-9._-]+`                                              | `manifest_invalid`                     |
| `markdownFences[].language`        | lowercase `[a-z0-9._-]+`                                              | `markdown_fence_language_invalid`      |
| `architectTabs[].id`               | lowercase `[a-z0-9._-]+`, MUST start with `<plugin-id>.`               | `manifest_invalid`                     |
| `architectTabs[].renderer`         | currently `checklist` only                                             | `manifest_invalid`                     |
| `architectTabs[].planConnectivity` | `required | optional | none`                                           | `manifest_invalid`                     |
| `policy.phasePermissions`          | each ∈ `analysis | execution | reflection`                            | `manifest_invalid`                     |
| `policy.writableFiles`             | array of strings                                                      | `manifest_invalid`                     |

## Validation entry point

```ts
import { parsePluginManifest, PluginManifestSchema } from "@dreamgraph/sdk";

const manifest = parsePluginManifest(JSON.parse(plugin_json_text));
// throws ZodError with reason "manifest_invalid" on failure
```

## Example

See [examples/hello-events/plugin.json](../../../examples/hello-events/plugin.json)
for a manifest exercising every M6 seam and [examples/action-checklist/plugin.json](../../../examples/action-checklist/plugin.json)
for a standalone Architect tab manifest.
