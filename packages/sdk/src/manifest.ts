import { z } from "zod";

export const PluginIdSchema = z
  .string()
  .min(3)
  .regex(/^[a-z0-9][a-z0-9.-]*[a-z0-9]$/, "Plugin ids must be lowercase DNS-like identifiers");

export const PluginVersionSchema = z.string().min(1);

export const PluginCapabilitySchema = z.enum([
  "events:read",
  "events:read:experimental",
  "events:emit",
  "tools:register",
  "resources:register",
  "resources:read",
  "ui:register",
  "policy:propose",
  "schedule:register_action",
  "webhooks:emit",
  "archetypes:provide",
  "providers:register",
  "markdown:register_fence",
  "architect:register_tab",
  "architect:read_plan",
  "architect:write_plan_state",
  "architect:register_sidebar_summary",
]);

export type PluginCapability = z.infer<typeof PluginCapabilitySchema>;

export const PluginEffectSchema = z.enum([
  "read_events",
  "read_internal_graph",
  "read_external_state",
  "write_internal_graph",
  "modify_tensions",
  "emit_resource",
  "emit_tool",
  "emit_event",
  "emit_webhook",
  "register_schedule_action",
  "invoke_llm",
  "mutate_ui_registry",
  "propose_policy",
  "provide_archetypes",
  "render_markdown_fence",
  "register_provider_adapter",
  "render_architect_tab",
  "read_architect_plan_projection",
  "write_architect_plan_state",
  "render_architect_sidebar_summary",
]);

export type PluginEffect = z.infer<typeof PluginEffectSchema>;

export const PhasePermissionSchema = z.enum(["analysis", "execution", "reflection"]);
export type PhasePermission = z.infer<typeof PhasePermissionSchema>;

export const PluginToolNameSchema = z
  .string()
  .min(3)
  .regex(/^[a-z0-9][a-z0-9_]*$/, "Tool names must be model-safe snake_case prefixed as <sanitized-plugin-id>_<tool_name> (lowercase a-z, 0-9, underscore only)");

export const PluginResourceUriNamespaceSchema = z
  .string()
  .min(12)
  .regex(/^plugin:\/\/[a-z0-9][a-z0-9.-]*[a-z0-9](?:\/.*)?$/, "Resource namespaces must start with plugin://<plugin-id>/");

export const PluginManifestToolSchema = z
  .object({
    name: PluginToolNameSchema,
  })
  .strict();

export const PluginManifestResourceSchema = z
  .object({
    uriNamespace: PluginResourceUriNamespaceSchema,
  })
  .strict();

/**
 * Manifest-level UI element declaration. Only the id is declared statically;
 * the full {@link UiElementDefinition} is provided at runtime via
 * `ctx.ui.register()` so the host can validate the element against the
 * live registry schema and emit telemetry.
 *
 * The id MUST be prefixed with `<plugin-id>.` (matches the runtime gate).
 */
export const PluginManifestUiElementSchema = z
  .object({
    id: z
      .string()
      .min(3)
      .regex(/^[a-z0-9][a-z0-9._-]*$/, "UI element ids must be lowercase, dot/dash/underscore separated"),
  })
  .strict();

/** Declarative standalone Architect tab declaration. */
export const PluginManifestArchitectTabSchema = z
  .object({
    id: z
      .string()
      .min(3)
      .regex(/^[a-z0-9][a-z0-9._-]*$/, "Architect tab ids must be lowercase, dot/dash/underscore separated"),
    renderer: z.enum(["checklist"]),
    planConnectivity: z.enum(["required", "optional", "none"]),
  })
  .strict();

/** Manifest declaration for a discipline-rule proposal (§4.6). */
export const PluginManifestPolicyProposalSchema = z
  .object({
    id: z
      .string()
      .min(2)
      .regex(/^[a-z0-9][a-z0-9._-]*$/, "Policy proposal ids must be lowercase"),
  })
  .strict();

/** Manifest declaration for an archetype provider (§4.8). */
export const PluginManifestArchetypeProviderSchema = z
  .object({
    id: z
      .string()
      .min(2)
      .regex(/^[a-z0-9][a-z0-9._-]*$/, "Archetype provider ids must be lowercase"),
  })
  .strict();

/** Manifest declaration for a markdown fence language (§4.9). */
export const PluginManifestMarkdownFenceSchema = z
  .object({
    language: z
      .string()
      .min(1)
      .regex(/^[a-z0-9][a-z0-9._-]*$/, "Markdown fence languages must be lowercase, dot/dash/underscore separated"),
  })
  .strict();

export const PluginPolicySchema = z
  .object({
    phasePermissions: z.array(PhasePermissionSchema).default([]),
    writableFiles: z.array(z.string()).default([]),
  })
  .strict();

export type PluginPolicy = z.infer<typeof PluginPolicySchema>;

export const PluginManifestSchema = z
  .object({
    id: PluginIdSchema,
    version: PluginVersionSchema,
    displayName: z.string().min(1),
    description: z.string().min(1).optional(),
    author: z.string().min(1).optional(),
    license: z.string().min(1).optional(),
    engine: z
      .object({
        dreamgraph: z.string().min(1),
      })
      .strict(),
    main: z.string().min(1),
    intent: z.string().min(1),
    expectedEffects: z.array(PluginEffectSchema).min(1),
    forbiddenEffects: z.array(PluginEffectSchema).default([]),
    capabilities: z.array(PluginCapabilitySchema).min(1),
    tools: z.array(PluginManifestToolSchema).default([]),
    resources: z.array(PluginManifestResourceSchema).default([]),
    ui: z.array(PluginManifestUiElementSchema).default([]),
    policies: z.array(PluginManifestPolicyProposalSchema).default([]),
    archetypeProviders: z.array(PluginManifestArchetypeProviderSchema).default([]),
    markdownFences: z.array(PluginManifestMarkdownFenceSchema).default([]),
    architectTabs: z.array(PluginManifestArchitectTabSchema).default([]),
    policy: PluginPolicySchema.default({ phasePermissions: [], writableFiles: [] }),
    config: z
      .object({
        schema: z.string().min(1).optional(),
      })
      .strict()
      .optional(),
  })
  .strict()
  .superRefine((manifest, context) => {
    for (const effect of manifest.expectedEffects) {
      if (manifest.forbiddenEffects.includes(effect)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: `Effect ${effect} cannot be both expected and forbidden`,
          path: ["expectedEffects"],
        });
      }
    }
    if (manifest.architectTabs.length > 0) {
      const requiredCapabilities = ["architect:register_tab", "architect:read_plan"] as const;
      const requiredEffects = ["render_architect_tab", "read_architect_plan_projection"] as const;
      for (const capability of requiredCapabilities) {
        if (!manifest.capabilities.includes(capability)) {
          context.addIssue({ code: z.ZodIssueCode.custom, message: `Architect tabs require capability ${capability}`, path: ["capabilities"] });
        }
      }
      for (const effect of requiredEffects) {
        if (!manifest.expectedEffects.includes(effect)) {
          context.addIssue({ code: z.ZodIssueCode.custom, message: `Architect tabs require effect ${effect}`, path: ["expectedEffects"] });
        }
      }
      for (const [index, tab] of manifest.architectTabs.entries()) {
        if (!tab.id.startsWith(`${manifest.id}.`)) {
          context.addIssue({ code: z.ZodIssueCode.custom, message: `Architect tab '${tab.id}' must start with '${manifest.id}.'`, path: ["architectTabs", index, "id"] });
        }
      }
    }
  });

export type PluginManifest = z.infer<typeof PluginManifestSchema>;

export function parsePluginManifest(input: unknown): PluginManifest {
  return PluginManifestSchema.parse(input);
}
