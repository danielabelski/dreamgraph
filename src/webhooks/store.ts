/**
 * M5 — Webhook subscription + dead-letter store.
 *
 * Persistent state for outbound HTTP webhook delivery:
 *
 *   data/webhook_subscriptions.json   { subscriptions: WebhookSubscription[] }
 *   data/webhook_dead_letter.json     { entries: DeadLetterEntry[] }
 *
 * Both files are owned by the daemon. Reads are best-effort (return empty
 * shape if missing); writes go through `withFileLock` + `atomicWriteFile`
 * to coordinate with concurrent worker activity.
 *
 * See plans/DREAMGRAPH_SDK_ROADMAP.md §7 (Webhooks) for wire format.
 */

import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { dataPath } from "../utils/paths.js";
import { atomicWriteFile } from "../utils/atomic-write.js";
import { withFileLock } from "../utils/mutex.js";
import { logger } from "../utils/logger.js";
import type { GraphEventKind } from "../graph/events.js";

export const SUBSCRIPTIONS_FILE = "webhook_subscriptions.json";
export const DEAD_LETTER_FILE = "webhook_dead_letter.json";

export interface WebhookSubscription {
  /** Stable id (uuid v4). */
  id: string;
  /** Destination HTTPS (or HTTP for localhost) URL. */
  url: string;
  /** Shared HMAC-SHA256 secret used to sign delivery bodies. */
  secret: string;
  /**
   * Event kinds to deliver. `["*"]` means all kinds.
   * Empty array is illegal — fail registration up front.
   */
  events: (GraphEventKind | "*")[];
  /** Optional human label. */
  label?: string;
  /** ISO timestamp. */
  created_at: string;
  /** Operator can pause delivery without losing config. */
  enabled: boolean;
  /** Delivery health rollups (best-effort, updated by the worker). */
  stats: {
    delivered: number;
    failed: number;
    dead_lettered: number;
    last_delivery_at: string | null;
    last_status: number | null;
    last_error: string | null;
  };
}

export interface DeadLetterEntry {
  delivery_id: string;
  subscription_id: string;
  url: string;
  event_kind: GraphEventKind;
  event_seq: number;
  attempts: number;
  last_error: string;
  last_status: number | null;
  body: string;
  failed_at: string;
}

interface SubscriptionsFile {
  subscriptions: WebhookSubscription[];
}

interface DeadLetterFile {
  entries: DeadLetterEntry[];
}

const MAX_DEAD_LETTER_ENTRIES = 500;

async function loadSubscriptionsFile(): Promise<SubscriptionsFile> {
  const file = dataPath(SUBSCRIPTIONS_FILE);
  if (!existsSync(file)) return { subscriptions: [] };
  try {
    const raw = await readFile(file, "utf-8");
    const parsed = JSON.parse(raw) as Partial<SubscriptionsFile>;
    return { subscriptions: Array.isArray(parsed.subscriptions) ? parsed.subscriptions : [] };
  } catch (err) {
    logger.warn(
      `webhook-store: unreadable ${SUBSCRIPTIONS_FILE} — treating as empty (${
        err instanceof Error ? err.message : err
      })`,
    );
    return { subscriptions: [] };
  }
}

async function saveSubscriptionsFile(file: SubscriptionsFile): Promise<void> {
  await atomicWriteFile(dataPath(SUBSCRIPTIONS_FILE), JSON.stringify(file, null, 2));
}

async function loadDeadLetterFile(): Promise<DeadLetterFile> {
  const file = dataPath(DEAD_LETTER_FILE);
  if (!existsSync(file)) return { entries: [] };
  try {
    const raw = await readFile(file, "utf-8");
    const parsed = JSON.parse(raw) as Partial<DeadLetterFile>;
    return { entries: Array.isArray(parsed.entries) ? parsed.entries : [] };
  } catch (err) {
    logger.warn(
      `webhook-store: unreadable ${DEAD_LETTER_FILE} — treating as empty (${
        err instanceof Error ? err.message : err
      })`,
    );
    return { entries: [] };
  }
}

async function saveDeadLetterFile(file: DeadLetterFile): Promise<void> {
  await atomicWriteFile(dataPath(DEAD_LETTER_FILE), JSON.stringify(file, null, 2));
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export async function listSubscriptions(): Promise<WebhookSubscription[]> {
  const file = await loadSubscriptionsFile();
  return file.subscriptions;
}

export async function getSubscription(id: string): Promise<WebhookSubscription | null> {
  const file = await loadSubscriptionsFile();
  return file.subscriptions.find((s) => s.id === id) ?? null;
}

export interface RegisterSubscriptionInput {
  url: string;
  secret: string;
  events: (GraphEventKind | "*")[];
  label?: string;
  enabled?: boolean;
}

export async function registerSubscription(
  input: RegisterSubscriptionInput,
): Promise<WebhookSubscription> {
  const url = input.url.trim();
  if (!url) throw new Error("webhook url is required");
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`webhook url is not a valid URL: ${url}`);
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error(`webhook url protocol must be http(s), got ${parsed.protocol}`);
  }
  if (!input.secret || input.secret.length < 16) {
    throw new Error("webhook secret must be at least 16 characters");
  }
  if (!Array.isArray(input.events) || input.events.length === 0) {
    throw new Error("webhook must subscribe to at least one event kind (or '*')");
  }

  const subscription: WebhookSubscription = {
    id: randomUUID(),
    url,
    secret: input.secret,
    events: input.events,
    label: input.label,
    created_at: new Date().toISOString(),
    enabled: input.enabled ?? true,
    stats: {
      delivered: 0,
      failed: 0,
      dead_lettered: 0,
      last_delivery_at: null,
      last_status: null,
      last_error: null,
    },
  };

  await withFileLock(SUBSCRIPTIONS_FILE, async () => {
    const file = await loadSubscriptionsFile();
    file.subscriptions.push(subscription);
    await saveSubscriptionsFile(file);
  });

  return subscription;
}

export async function removeSubscription(id: string): Promise<boolean> {
  let removed = false;
  await withFileLock(SUBSCRIPTIONS_FILE, async () => {
    const file = await loadSubscriptionsFile();
    const before = file.subscriptions.length;
    file.subscriptions = file.subscriptions.filter((s) => s.id !== id);
    removed = file.subscriptions.length < before;
    if (removed) await saveSubscriptionsFile(file);
  });
  return removed;
}

export async function setEnabled(id: string, enabled: boolean): Promise<boolean> {
  let updated = false;
  await withFileLock(SUBSCRIPTIONS_FILE, async () => {
    const file = await loadSubscriptionsFile();
    const sub = file.subscriptions.find((s) => s.id === id);
    if (!sub) return;
    sub.enabled = enabled;
    updated = true;
    await saveSubscriptionsFile(file);
  });
  return updated;
}

export interface RecordDeliveryOutcome {
  status: number | null;
  error: string | null;
}

/**
 * Update aggregate stats on a subscription after a delivery attempt.
 * Best-effort — if the subscription was removed mid-flight, silently no-op.
 */
export async function recordDeliveryOutcome(
  subscriptionId: string,
  outcome:
    | { kind: "delivered"; status: number }
    | { kind: "failed"; status: number | null; error: string }
    | { kind: "dead_lettered"; status: number | null; error: string },
): Promise<void> {
  await withFileLock(SUBSCRIPTIONS_FILE, async () => {
    const file = await loadSubscriptionsFile();
    const sub = file.subscriptions.find((s) => s.id === subscriptionId);
    if (!sub) return;
    sub.stats.last_delivery_at = new Date().toISOString();
    if (outcome.kind === "delivered") {
      sub.stats.delivered += 1;
      sub.stats.last_status = outcome.status;
      sub.stats.last_error = null;
    } else if (outcome.kind === "failed") {
      sub.stats.failed += 1;
      sub.stats.last_status = outcome.status;
      sub.stats.last_error = outcome.error;
    } else {
      sub.stats.dead_lettered += 1;
      sub.stats.last_status = outcome.status;
      sub.stats.last_error = outcome.error;
    }
    await saveSubscriptionsFile(file);
  });
}

export async function listDeadLetter(): Promise<DeadLetterEntry[]> {
  const file = await loadDeadLetterFile();
  return file.entries;
}

export async function getDeadLetter(deliveryId: string): Promise<DeadLetterEntry | null> {
  const file = await loadDeadLetterFile();
  return file.entries.find((e) => e.delivery_id === deliveryId) ?? null;
}

export async function appendDeadLetter(entry: DeadLetterEntry): Promise<void> {
  await withFileLock(DEAD_LETTER_FILE, async () => {
    const file = await loadDeadLetterFile();
    file.entries.push(entry);
    // Keep dead-letter store bounded — drop oldest entries if oversized.
    if (file.entries.length > MAX_DEAD_LETTER_ENTRIES) {
      file.entries.splice(0, file.entries.length - MAX_DEAD_LETTER_ENTRIES);
    }
    await saveDeadLetterFile(file);
  });
}

export async function removeDeadLetter(deliveryId: string): Promise<boolean> {
  let removed = false;
  await withFileLock(DEAD_LETTER_FILE, async () => {
    const file = await loadDeadLetterFile();
    const before = file.entries.length;
    file.entries = file.entries.filter((e) => e.delivery_id !== deliveryId);
    removed = file.entries.length < before;
    if (removed) await saveDeadLetterFile(file);
  });
  return removed;
}
