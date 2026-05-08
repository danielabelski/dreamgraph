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
  "register_provider_adapter",
]);

export type PluginEffect = z.infer<typeof PluginEffectSchema>;

export const PhasePermissionSchema = z.enum(["analysis", "execution", "reflection"]);
export type PhasePermission = z.infer<typeof PhasePermissionSchema>;

export const PluginToolNameSchema = z
  .string()
  .min(3)
  .regex(/^[a-z0-9][a-z0-9.-]*\.[a-z0-9][a-z0-9_-]*$/, "Tool names must be prefixed as <plugin-id>.<tool_name>");

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
  });

export type PluginManifest = z.infer<typeof PluginManifestSchema>;

export function parsePluginManifest(input: unknown): PluginManifest {
  return PluginManifestSchema.parse(input);
}
