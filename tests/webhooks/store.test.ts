/**
 * M5 — Webhook subscription store tests.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setDataDirOverride } from "../../src/utils/paths.js";
import {
  appendDeadLetter,
  getDeadLetter,
  listDeadLetter,
  listSubscriptions,
  recordDeliveryOutcome,
  registerSubscription,
  removeDeadLetter,
  removeSubscription,
  setEnabled,
  type DeadLetterEntry,
} from "../../src/webhooks/store.js";

let dataDir: string;
let savedOverride: string | null = null;

beforeEach(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "dg-webhook-store-"));
  setDataDirOverride(dataDir);
});

afterEach(async () => {
  await rm(dataDir, { recursive: true, force: true });
  if (savedOverride !== null) setDataDirOverride(savedOverride);
});

describe("registerSubscription", () => {
  it("creates a subscription with sane defaults", async () => {
    const sub = await registerSubscription({
      url: "https://example.test/hook",
      secret: "topsecrettopsecret",
      events: ["snapshot.changed"],
    });
    expect(sub.id).toMatch(/^[0-9a-f-]{36}$/i);
    expect(sub.enabled).toBe(true);
    expect(sub.stats.delivered).toBe(0);
    const all = await listSubscriptions();
    expect(all).toHaveLength(1);
  });

  it("rejects URLs with non-http(s) protocols", async () => {
    await expect(
      registerSubscription({
        url: "ftp://example.com/hook",
        secret: "topsecrettopsecret",
        events: ["*"],
      }),
    ).rejects.toThrow();
  });

  it("rejects short secrets", async () => {
    await expect(
      registerSubscription({
        url: "https://example.test/hook",
        secret: "short",
        events: ["*"],
      }),
    ).rejects.toThrow();
  });

  it("rejects empty events array", async () => {
    await expect(
      registerSubscription({
        url: "https://example.test/hook",
        secret: "topsecrettopsecret",
        events: [],
      }),
    ).rejects.toThrow();
  });
});

describe("removeSubscription", () => {
  it("removes by id and is idempotent", async () => {
    const sub = await registerSubscription({
      url: "https://example.test/hook",
      secret: "topsecrettopsecret",
      events: ["*"],
    });
    expect(await removeSubscription(sub.id)).toBe(true);
    expect(await removeSubscription(sub.id)).toBe(false);
  });
});

describe("setEnabled", () => {
  it("flips the enabled flag", async () => {
    const sub = await registerSubscription({
      url: "https://example.test/hook",
      secret: "topsecrettopsecret",
      events: ["*"],
    });
    expect(await setEnabled(sub.id, false)).toBe(true);
    const after = (await listSubscriptions())[0];
    expect(after.enabled).toBe(false);
  });
});

describe("recordDeliveryOutcome", () => {
  it("increments stats and records last_status", async () => {
    const sub = await registerSubscription({
      url: "https://example.test/hook",
      secret: "topsecrettopsecret",
      events: ["*"],
    });
    await recordDeliveryOutcome(sub.id, { kind: "delivered", status: 200 });
    await recordDeliveryOutcome(sub.id, { kind: "failed", status: 503, error: "boom" });
    const after = (await listSubscriptions())[0];
    expect(after.stats.delivered).toBe(1);
    expect(after.stats.failed).toBe(1);
    expect(after.stats.last_status).toBe(503);
    expect(after.stats.last_error).toBe("boom");
  });
});

describe("dead-letter store", () => {
  function entry(id: string): DeadLetterEntry {
    return {
      delivery_id: id,
      subscription_id: "sub-1",
      url: "https://example.test/hook",
      event_kind: "snapshot.changed",
      event_seq: 1,
      attempts: 5,
      last_error: "timeout",
      last_status: null,
      body: "{}",
      failed_at: new Date().toISOString(),
    };
  }

  it("appends and retrieves entries", async () => {
    await appendDeadLetter(entry("d-1"));
    await appendDeadLetter(entry("d-2"));
    const all = await listDeadLetter();
    expect(all).toHaveLength(2);
    expect((await getDeadLetter("d-1"))?.delivery_id).toBe("d-1");
  });

  it("removes by delivery_id idempotently", async () => {
    await appendDeadLetter(entry("d-1"));
    expect(await removeDeadLetter("d-1")).toBe(true);
    expect(await removeDeadLetter("d-1")).toBe(false);
  });
});
