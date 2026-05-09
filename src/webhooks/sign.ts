/**
 * M5 — Webhook HMAC signing.
 *
 * Each outbound delivery body is signed with HMAC-SHA256 over
 *   `${delivery_id}.${timestamp}.${body}`
 * using the subscription's shared secret. The delivery_id is included so
 * that two replays of the same event payload produce different signatures
 * and cannot be silently substituted by a receiver. Receivers reconstruct
 * the signature and reject deliveries where:
 *   - the timestamp drifts more than ±5 minutes from now, OR
 *   - the recomputed signature does not match (constant-time compare).
 *
 * Wire format (request headers):
 *   X-DreamGraph-Timestamp:  <unix-ms>
 *   X-DreamGraph-Signature:  sha256=<hex-digest>
 *   X-DreamGraph-Event:      <event-kind>
 *   X-DreamGraph-Event-Id:   <monotonic-seq>
 *   X-DreamGraph-Instance:   <instance-uuid>
 *   X-DreamGraph-Delivery:   <delivery-uuid>
 */

import { createHmac, timingSafeEqual } from "node:crypto";

export interface SignatureParts {
  timestamp: string;
  header: string;
  digest: string;
}

export function signBody(
  body: string,
  secret: string,
  timestamp: string,
  deliveryId: string,
): SignatureParts {
  const signingInput = `${deliveryId}.${timestamp}.${body}`;
  const digest = createHmac("sha256", secret).update(signingInput).digest("hex");
  return {
    timestamp,
    digest,
    header: `sha256=${digest}`,
  };
}

export function verifySignature(
  body: string,
  secret: string,
  timestamp: string,
  deliveryId: string,
  signatureHeader: string,
  toleranceSeconds = 300,
): { valid: boolean; reason?: string } {
  const ts = Number(timestamp);
  if (!Number.isFinite(ts)) return { valid: false, reason: "timestamp not numeric" };
  const drift = Math.abs(Date.now() - ts) / 1000;
  if (drift > toleranceSeconds) return { valid: false, reason: `timestamp drift ${drift.toFixed(0)}s` };

  const expected = signBody(body, secret, timestamp, deliveryId).header;
  const a = Buffer.from(expected, "utf-8");
  const b = Buffer.from(signatureHeader, "utf-8");
  if (a.length !== b.length) return { valid: false, reason: "signature length mismatch" };
  return timingSafeEqual(a, b)
    ? { valid: true }
    : { valid: false, reason: "signature mismatch" };
}
