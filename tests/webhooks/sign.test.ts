/**
 * M5 — Webhook signing tests.
 */
import { describe, it, expect } from "vitest";
import { signBody, verifySignature } from "../../src/webhooks/sign.js";

const DID = "00000000-0000-0000-0000-000000000001";
const DID2 = "00000000-0000-0000-0000-000000000002";

describe("signBody", () => {
  it("is deterministic for the same (body, secret, timestamp, deliveryId)", () => {
    const a = signBody("hello", "topsecrettopsecret", "1700000000000", DID);
    const b = signBody("hello", "topsecrettopsecret", "1700000000000", DID);
    expect(a.header).toBe(b.header);
    expect(a.header).toMatch(/^sha256=[0-9a-f]{64}$/);
  });

  it("differs when body changes", () => {
    const a = signBody("hello", "topsecrettopsecret", "1700000000000", DID);
    const b = signBody("hellp", "topsecrettopsecret", "1700000000000", DID);
    expect(a.header).not.toBe(b.header);
  });

  it("differs when timestamp changes", () => {
    const a = signBody("hello", "topsecrettopsecret", "1700000000000", DID);
    const b = signBody("hello", "topsecrettopsecret", "1700000000001", DID);
    expect(a.header).not.toBe(b.header);
  });

  it("differs when delivery_id changes (replay protection)", () => {
    const a = signBody("hello", "topsecrettopsecret", "1700000000000", DID);
    const b = signBody("hello", "topsecrettopsecret", "1700000000000", DID2);
    expect(a.header).not.toBe(b.header);
  });
});

describe("verifySignature", () => {
  it("accepts a fresh, well-formed signature", () => {
    const ts = String(Date.now());
    const sig = signBody("body", "topsecrettopsecret", ts, DID);
    const result = verifySignature("body", "topsecrettopsecret", ts, DID, sig.header);
    expect(result.valid).toBe(true);
  });

  it("rejects tampered body", () => {
    const ts = String(Date.now());
    const sig = signBody("body", "topsecrettopsecret", ts, DID);
    const result = verifySignature("BODY", "topsecrettopsecret", ts, DID, sig.header);
    expect(result.valid).toBe(false);
    expect(result.reason).toContain("signature");
  });

  it("rejects expired timestamp", () => {
    const oldTs = String(Date.now() - 10 * 60 * 1000); // 10 min ago
    const sig = signBody("body", "topsecrettopsecret", oldTs, DID);
    const result = verifySignature("body", "topsecrettopsecret", oldTs, DID, sig.header);
    expect(result.valid).toBe(false);
    expect(result.reason).toContain("drift");
  });

  it("rejects non-numeric timestamp", () => {
    const result = verifySignature("body", "topsecrettopsecret", "abc", DID, "sha256=00");
    expect(result.valid).toBe(false);
  });

  it("rejects mismatched delivery_id (replay attempt)", () => {
    const ts = String(Date.now());
    const sig = signBody("body", "topsecrettopsecret", ts, DID);
    const result = verifySignature("body", "topsecrettopsecret", ts, DID2, sig.header);
    expect(result.valid).toBe(false);
  });
});
