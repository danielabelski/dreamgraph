/**
 * M5 — MCP tools for webhook lifecycle and replay.
 *
 * webhook_register   — Create a subscription (url, secret, events[]).
 * webhook_list       — List subscriptions (secrets redacted).
 * webhook_remove     — Delete a subscription by id.
 * webhook_set_enabled — Pause/resume delivery without losing config.
 * webhook_test       — Send a synthetic `webhook.test` event to one subscription.
 * webhook_replay     — Re-deliver an entry from the dead-letter store.
 * webhook_dead_letter_list — List current dead-letter entries.
 *
 * All write tools mutate `<instance>/data/webhook_*.json` via the same
 * locked store helpers used by the worker. `webhook_test` skips the store
 * and synthesizes an in-memory event so operators can verify URL + secret
 * before live traffic flows.
 */

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  appendDeadLetter,
  getDeadLetter,
  getSubscription,
  listDeadLetter,
  listSubscriptions,
  registerSubscription,
  removeDeadLetter,
  removeSubscription,
  setEnabled,
  type WebhookSubscription,
} from "../webhooks/store.js";
import { deliver } from "../webhooks/worker.js";
import type { GraphEvent, GraphEventKind } from "../graph/events.js";
import { logger } from "../utils/logger.js";

function redact(sub: WebhookSubscription): Omit<WebhookSubscription, "secret"> & { secret: string } {
  return { ...sub, secret: "***redacted***" };
}

const RegisterInputSchema = {
  url: z.string().min(1).describe("Destination URL (https or http for localhost)."),
  secret: z
    .string()
    .min(16)
    .describe("Shared HMAC-SHA256 secret (>=16 chars). Used to sign every delivery."),
  events: z
    .array(z.string().min(1))
    .min(1)
    .describe("Event kinds to subscribe to. Use ['*'] to receive everything."),
  label: z.string().optional().describe("Optional human label."),
  enabled: z.boolean().optional().describe("Default true; set false to register paused."),
};

const RemoveInputSchema = {
  id: z.string().min(1).describe("Subscription id (uuid)."),
};

const SetEnabledInputSchema = {
  id: z.string().min(1).describe("Subscription id (uuid)."),
  enabled: z.boolean().describe("New enabled state."),
};

const TestInputSchema = {
  id: z.string().min(1).describe("Subscription id (uuid) to test."),
};

const ReplayInputSchema = {
  delivery_id: z.string().min(1).describe("Dead-letter delivery_id to re-attempt."),
  remove_on_success: z
    .boolean()
    .optional()
    .describe("When true (default), drop the dead-letter entry on success."),
};

function jsonResponse(value: unknown) {
  return {
    content: [
      {
        type: "text" as const,
        text: JSON.stringify(value, null, 2),
      },
    ],
  };
}

export function registerWebhookTools(server: McpServer): void {
  server.tool(
    "webhook_register",
    "Register a new outbound webhook subscription. Returns the created " +
      "subscription with its uuid. Secret is stored locally and never " +
      "echoed back via webhook_list.",
    RegisterInputSchema,
    async ({ url, secret, events, label, enabled }) => {
      const sub = await registerSubscription({
        url,
        secret,
        events: events as (GraphEventKind | "*")[],
        label,
        enabled,
      });
      logger.info(`Webhook registered: ${sub.id} → ${sub.url} (${sub.events.join(",")})`);
      return jsonResponse({ subscription: redact(sub) });
    },
  );

  server.tool(
    "webhook_list",
    "List all registered webhook subscriptions. Secrets are redacted in the " +
      "response. Includes per-subscription delivery stats (delivered, failed, " +
      "dead_lettered, last_status, last_error).",
    {},
    async () => {
      const subs = await listSubscriptions();
      return jsonResponse({ subscriptions: subs.map(redact) });
    },
  );

  server.tool(
    "webhook_remove",
    "Delete a webhook subscription. Idempotent: returns { removed: false } " +
      "if the id is unknown.",
    RemoveInputSchema,
    async ({ id }) => {
      const removed = await removeSubscription(id);
      if (removed) logger.info(`Webhook removed: ${id}`);
      return jsonResponse({ removed });
    },
  );

  server.tool(
    "webhook_set_enabled",
    "Pause or resume delivery for a subscription without losing its " +
      "configuration. Use this to silence noisy targets during incidents.",
    SetEnabledInputSchema,
    async ({ id, enabled }) => {
      const updated = await setEnabled(id, enabled);
      return jsonResponse({ updated, id, enabled });
    },
  );

  server.tool(
    "webhook_test",
    "Send a synthetic `webhook.test` event to one subscription using its " +
      "real URL + secret. Use to validate connectivity before live traffic. " +
      "Bypasses the event-kind filter.",
    TestInputSchema,
    async ({ id }) => {
      const sub = await getSubscription(id);
      if (!sub) return jsonResponse({ ok: false, error: `subscription not found: ${id}` });
      const event: GraphEvent = {
        seq: 0,
        kind: "snapshot.changed", // benign placeholder for filter-bypass test
        affected_ids: [],
        etag: null,
        ts: new Date().toISOString(),
        payload: { test: true, subscription_id: sub.id },
      };
      try {
        const result = await deliver(sub, event);
        return jsonResponse({ ok: result.delivered, subscription_id: sub.id, ...result });
      } catch (err) {
        return jsonResponse({
          ok: false,
          subscription_id: sub.id,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    },
  );

  server.tool(
    "webhook_dead_letter_list",
    "List all current entries in the webhook dead-letter store.",
    {},
    async () => {
      const entries = await listDeadLetter();
      return jsonResponse({ entries });
    },
  );

  server.tool(
    "webhook_replay",
    "Re-attempt delivery of a dead-lettered entry. Requires the original " +
      "subscription to still exist; rebuilds the event from the stored body. " +
      "On success the dead-letter entry is removed by default.",
    ReplayInputSchema,
    async ({ delivery_id, remove_on_success }) => {
      const entry = await getDeadLetter(delivery_id);
      if (!entry) return jsonResponse({ ok: false, error: `dead-letter not found: ${delivery_id}` });
      const sub = await getSubscription(entry.subscription_id);
      if (!sub)
        return jsonResponse({
          ok: false,
          error: `subscription gone: ${entry.subscription_id}`,
        });
      let parsedEvent: GraphEvent;
      try {
        const body = JSON.parse(entry.body) as { event: GraphEvent };
        parsedEvent = body.event;
      } catch {
        return jsonResponse({ ok: false, error: "stored body is not parseable JSON" });
      }
      try {
        const result = await deliver(sub, parsedEvent);
        if (result.delivered && remove_on_success !== false) {
          await removeDeadLetter(delivery_id);
        }
        return jsonResponse({ ok: result.delivered, delivery_id, replay: result });
      } catch (err) {
        // Re-dead-letter the failure so the entry survives.
        await appendDeadLetter({
          ...entry,
          attempts: entry.attempts + 1,
          last_error: err instanceof Error ? err.message : String(err),
          failed_at: new Date().toISOString(),
        });
        return jsonResponse({
          ok: false,
          delivery_id,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    },
  );
}
