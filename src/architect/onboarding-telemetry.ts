import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { config } from "../config/config.js";
import { getActiveScope } from "../instance/lifecycle.js";
import { atomicWriteFile } from "../utils/atomic-write.js";
import { withFileLock } from "../utils/mutex.js";

const TELEMETRY_FILE = "onboarding_telemetry.json";
const ALLOWED_EVENTS = ["checklist_snapshot", "mission_launched", "mission_completed", "provider_tested", "repo_setup_completed", "guide_opened", "second_session_return"] as const;
type OnboardingTelemetryEventType = typeof ALLOWED_EVENTS[number];

export interface OnboardingTelemetryEvent {
  event: OnboardingTelemetryEventType;
  recorded_at: string;
  mission_id?: string;
  category?: string;
  source?: "dashboard" | "architect";
  ready_count?: number;
  required_count?: number;
  duration_ms?: number;
}

function telemetryPath(): string {
  return resolve(getActiveScope()?.dataDir ?? config.dataDir, TELEMETRY_FILE);
}

function boundedCount(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? Math.min(Math.floor(value), 86_400_000) : undefined;
}

function safeToken(value: unknown): string | undefined {
  return typeof value === "string" && /^[A-Za-z0-9._-]{1,64}$/.test(value) ? value : undefined;
}

export function sanitizeOnboardingTelemetryEvent(input: unknown): OnboardingTelemetryEvent {
  const body = input && typeof input === "object" && !Array.isArray(input) ? input as Record<string, unknown> : {};
  if (!ALLOWED_EVENTS.includes(body.event as OnboardingTelemetryEventType)) throw new Error("invalid_onboarding_event");
  const event = body.event as OnboardingTelemetryEventType;
  const result: OnboardingTelemetryEvent = { event, recorded_at: new Date().toISOString() };
  const missionId = safeToken(body.mission_id);
  const category = safeToken(body.category);
  if (missionId) result.mission_id = missionId;
  if (category) result.category = category;
  if (body.source === "dashboard" || body.source === "architect") result.source = body.source;
  const readyCount = boundedCount(body.ready_count);
  const requiredCount = boundedCount(body.required_count);
  const durationMs = boundedCount(body.duration_ms);
  if (readyCount !== undefined) result.ready_count = readyCount;
  if (requiredCount !== undefined) result.required_count = requiredCount;
  if (durationMs !== undefined) result.duration_ms = durationMs;
  return result;
}

export async function recordOnboardingTelemetryEvent(input: unknown): Promise<OnboardingTelemetryEvent> {
  const event = sanitizeOnboardingTelemetryEvent(input);
  await withFileLock(TELEMETRY_FILE, async () => {
    let events: OnboardingTelemetryEvent[] = [];
    try {
      const parsed = JSON.parse(await readFile(telemetryPath(), "utf8")) as unknown;
      if (Array.isArray(parsed)) events = parsed as OnboardingTelemetryEvent[];
    } catch { /* initialize a local-first telemetry file */ }
    events.push(event);
    await atomicWriteFile(telemetryPath(), JSON.stringify(events.slice(-500), null, 2));
  });
  return event;
}

export async function readOnboardingTelemetryEvents(): Promise<OnboardingTelemetryEvent[]> {
  try {
    const parsed = JSON.parse(await readFile(telemetryPath(), "utf8")) as unknown;
    return Array.isArray(parsed) ? parsed as OnboardingTelemetryEvent[] : [];
  } catch {
    return [];
  }
}
