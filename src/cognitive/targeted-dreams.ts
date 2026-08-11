import { createHash } from "node:crypto";

import { createSchedule, getSchedules } from "./scheduler.js";
import type { DreamSchedule, DreamStrategy } from "./types.js";
import { loadGraphMaintenanceState, updateGraphMaintenanceState } from "./graph-maintenance-state.js";
import { logger } from "../utils/logger.js";

export interface TargetedDreamScheduleRequest {
  entity_ids: string[];
  reason: string;
  strategies?: DreamStrategy[];
  max_runs?: number;
  interval_ms?: number;
}

export interface TargetedDreamScheduleResult {
  scheduled: DreamSchedule[];
  reused: DreamSchedule[];
  focus_entities: string[];
  reason: string;
}

function chooseStrategies(reason: string): DreamStrategy[] {
  const lower = reason.toLowerCase();
  if (/datastore|database|schema|table|persistence/.test(lower)) return ["schema_grounding", "llm_dream"];
  if (/tension|contradiction|conflict/.test(lower)) return ["tension_directed", "llm_dream"];
  if (/orphan|disconnect|cluster|link/.test(lower)) return ["orphan_bridging", "llm_dream"];
  return ["llm_dream", "missing_abstraction"];
}

function fingerprint(entityIds: string[], reason: string, strategy: DreamStrategy): string {
  return createHash("sha256")
    .update(JSON.stringify({ entityIds: [...entityIds].sort(), reason, strategy }))
    .digest("hex")
    .slice(0, 16);
}

/**
 * Persist bounded dream schedules for the graph region changed by a major
 * implementation or scan. Repeated requests reuse active schedules with the
 * same focus so automatic maintenance cannot create an unbounded queue.
 */
export async function scheduleTargetedDreamStabilization(
  request: TargetedDreamScheduleRequest,
): Promise<TargetedDreamScheduleResult> {
  const focusEntities = [...new Set(request.entity_ids.filter(Boolean))].slice(0, 100);
  if (focusEntities.length === 0) {
    return { scheduled: [], reused: [], focus_entities: [], reason: request.reason };
  }
  const strategies = [...new Set(request.strategies ?? chooseStrategies(request.reason))].slice(0, 3);
  const existing = await getSchedules();
  const scheduled: DreamSchedule[] = [];
  const reused: DreamSchedule[] = [];

  for (const strategy of strategies) {
    const marker = fingerprint(focusEntities, request.reason, strategy);
    const current = existing.find((schedule) =>
      schedule.action === "dream_cycle" &&
      schedule.status === "active" &&
      schedule.parameters?.maintenance_fingerprint === marker);
    if (current) {
      reused.push(current);
      continue;
    }
    const created = await createSchedule({
      name: `targeted_graph_stabilization_${strategy}_${marker.slice(0, 8)}`,
      action: "dream_cycle",
      parameters: {
        strategy,
        max_dreams: Math.max(20, Math.min(100, focusEntities.length * 2)),
        focus_entities: focusEntities,
        focus_hops: 2,
        focus_reason: request.reason,
        maintenance_fingerprint: marker,
        maintenance_origin: "major_graph_change",
      },
      trigger_type: "interval",
      interval_ms: Math.max(60_000, request.interval_ms ?? 5 * 60_000),
      max_runs: Math.max(1, Math.min(5, request.max_runs ?? 3)),
      enabled: true,
    });
    scheduled.push(created);
  }

  const maintenanceState = await loadGraphMaintenanceState();
  const scheduleIds = [...new Set([...maintenanceState.targeted_dream_schedule_ids, ...scheduled.map((schedule) => schedule.id), ...reused.map((schedule) => schedule.id)])];
  await updateGraphMaintenanceState({ targeted_dream_schedule_ids: scheduleIds.slice(-100) }).catch((err) => {
    logger.warn(`targeted dream scheduling: could not update maintenance state: ${err instanceof Error ? err.message : err}`);
  });
  logger.info(`Targeted dream stabilization: ${scheduled.length} created, ${reused.length} reused, ${focusEntities.length} focus entities`);
  return { scheduled, reused, focus_entities: focusEntities, reason: request.reason };
}
