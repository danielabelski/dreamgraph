/**
 * examples/hello-events — DreamGraph reference plugin (v0.2.0).
 *
 * Exercises every in-process seam shipped through M6 closure:
 *   • events.subscribe / events.emit          (M3 + M4)
 *   • tools.register                          (M4)
 *   • resources.register                      (M4)
 *   • ui.register                             (M6)
 *   • policies.propose                        (M6 closure §4.6)
 *   • archetypes.registerProvider             (M6 closure §4.8)
 *   • markdownFences.register                 (M6 closure §4.9)
 *
 * The host imports this module after manifest validation and invokes the
 * default `activate(ctx)` export. Every contribution is gated by the
 * matching capability + effect declared in plugin.json; missing either
 * causes the host to emit a `plugin.output.rejected` telemetry event and
 * skip the contribution without aborting activation.
 */

export const meta = {
  id: "examples.hello-events",
  version: "0.2.0",
};

export default function activate(ctx) {
  ctx.logger.info("hello-events activating (full seam demo)");

  // ── events.subscribe ────────────────────────────────────────────────
  const unsubscribe = ctx.events.subscribe("snapshot.changed", (evt) => {
    ctx.logger.info(`observed ${evt.kind}`);
  });

  // ── events.emit ─────────────────────────────────────────────────────
  // A custom kind (non-reserved). Useful for downstream webhook fanout
  // when an outbound subscription matches `examples.*`.
  ctx.events.emit("examples.hello-events.activated", {
    at: new Date().toISOString(),
  });

  // ── tools.register ──────────────────────────────────────────────────
  ctx.tools.register({
    name: "examples.hello-events.greet",
    description: "Return a friendly greeting.",
    inputSchema: {
      type: "object",
      properties: { who: { type: "string" } },
      required: ["who"],
    },
    expectedEffects: ["emit_tool"],
    handler: async ({ who }) => ({ greeting: `Hello, ${who}!` }),
  });

  // ── resources.register ──────────────────────────────────────────────
  ctx.resources.register({
    uriNamespace: "plugin://examples.hello-events/manifest",
    name: "Plugin manifest snapshot",
    description: "Returns this plugin's identity at runtime.",
    expectedEffects: ["emit_resource"],
    handler: async () => ({
      id: meta.id,
      version: meta.version,
      seams: [
        "events",
        "tools",
        "resources",
        "ui",
        "policies",
        "archetypes",
        "markdownFences",
      ],
    }),
  });

  // ── ui.register ─────────────────────────────────────────────────────
  ctx.ui.register({
    id: "examples.hello-events.greeting",
    name: "Greeting Banner",
    purpose: "Display a friendly greeting from the hello-events plugin.",
    category: "data_display",
    inputs: [
      { name: "who", type: "string", description: "subject", required: true },
    ],
    outputs: [],
    interactions: [],
    implementations: [
      {
        platform: "react",
        component: "GreetingBanner",
        notes: "Reference UI element for the typed builder seam.",
      },
    ],
  });

  // ── policies.propose ────────────────────────────────────────────────
  ctx.policies.propose({
    id: "declare-effects",
    title: "All plugin effects must be declared",
    rationale:
      "Every effect a plugin performs must appear in expectedEffects so the host can audit it.",
    applies_to: ["plugin"],
    phases: [{ phase: "design", permission: "required" }],
    severity: "warn",
  });

  // ── archetypes.registerProvider ─────────────────────────────────────
  ctx.archetypes.registerProvider({
    id: "starter-pack",
    name: "Hello Events Starter Pack",
    inline: {
      source: "examples.hello-events",
      version: "1",
      archetypes: [
        {
          id: "the-greeter",
          name: "The Greeter",
          summary: "Acknowledges every newcomer.",
          tags: ["example"],
        },
      ],
    },
  });

  // ── markdownFences.register ─────────────────────────────────────────
  ctx.markdownFences.register({
    language: "dg-hello",
    label: "DG Hello",
    description: "Reference fence registered by examples.hello-events.",
    platforms: ["webview"],
  });

  ctx.logger.info("hello-events activated (all seams exercised)");

  return {
    deactivate() {
      unsubscribe();
      ctx.logger.info("hello-events deactivated");
    },
  };
}
