import { loadJsonArray } from "../utils/cache.js";
import { getMetricsSnapshot } from "../utils/metrics.js";
import { getMetricsView } from "../graph/metrics.js";
import type { Feature } from "../types/index.js";

export type RuntimeMetricSurface = "mcp_tool" | "resource" | "graph_query" | "rest" | "cache" | "feature" | "internal";export interface RuntimeMetricsWindow {
  kind: "process_lifetime";
  started_at: string;
  uptime_s: number;
}

export interface RuntimeRequestMetricRow {
  surface: RuntimeMetricSurface;
  operation_class: string;
  name: string;
  request_count: number;
  error_count: number;
}

export interface RuntimeErrorMetricRow {
  surface: RuntimeMetricSurface;
  operation_class: string;
  name: string;
  error_count: number;
  error_rate: number;
  last_error: string | null;
  entity_id?: string;
}

export interface RuntimeLatencyMetricRow {
  surface: RuntimeMetricSurface;
  operation_class: string;
  name: string;
  count: number;
  avg_ms: number | null;
  p50_ms: number | null;
  p95_ms: number | null;
  max_ms: number | null;
}

export interface RuntimeGraphQueryCostRow {
  name: string;
  count: number;
  last: number | null;
  p50: number | null;
  p95: number | null;
  max: number | null;
}

export interface RuntimeGraphHotspotRow {
  name: string;
  surface: RuntimeMetricSurface;
  operation_class: string;
  count: number;
  p95_ms: number | null;
  max_ms: number | null;
}

export interface RuntimeCacheMetricRow {
  name: string;
  hits: number;
  misses: number;
  hit_rate: number | null;
}

export interface RuntimeFeatureMetricRow {
  name: string;
  usage_count: number;
  last_used_at: string | null;
  notes?: string;
}

export interface RuntimeDeadFeatureCandidateRow {
  name: string;
  reason: string;
  usage_count: number;
  last_used_at: string | null;
}

export interface RuntimeMetricsSnapshotV1 {
  snapshot_at: string;
  window: RuntimeMetricsWindow;
  requests: {
    by_surface: RuntimeRequestMetricRow[];
    by_name: RuntimeRequestMetricRow[];
  };
  errors: {
    by_surface: RuntimeErrorMetricRow[];
    by_name: RuntimeErrorMetricRow[];
    by_entity: RuntimeErrorMetricRow[];
  };
  latency: {
    by_operation_class: RuntimeLatencyMetricRow[];
    by_name: RuntimeLatencyMetricRow[];
  };
  graph: {
    query_cost: RuntimeGraphQueryCostRow[];
    hotspots: RuntimeGraphHotspotRow[];
  };
  cache: {
    entries: RuntimeCacheMetricRow[];
  };
  features: {
    usage: RuntimeFeatureMetricRow[];
    dead_candidates: RuntimeDeadFeatureCandidateRow[];
  };
}

function roundMetric(value: number): number {
  return Math.round(value * 100) / 100;
}

function deriveToolRows(): {
  requests: RuntimeRequestMetricRow[];
  errors: RuntimeErrorMetricRow[];
  latency: RuntimeLatencyMetricRow[];
} {
  const snapshot = getMetricsSnapshot();
  const requests: RuntimeRequestMetricRow[] = [];
  const errors: RuntimeErrorMetricRow[] = [];
  const latency: RuntimeLatencyMetricRow[] = [];

  for (const [toolName, record] of Object.entries(snapshot.tools)) {    const avgMs = record.calls > 0 ? record.total_ms / record.calls : null;
    const errorRate = record.calls > 0 ? record.failures / record.calls : 0;

    requests.push({
      surface: "mcp_tool",
      operation_class: "tool",
      name: toolName,
      request_count: record.calls,
      error_count: record.failures,
    });

    errors.push({
      surface: "mcp_tool",
      operation_class: "tool",
      name: toolName,
      error_count: record.failures,
      error_rate: roundMetric(errorRate),
      last_error: record.last_error,
    });

    latency.push({
      surface: "mcp_tool",
      operation_class: "tool",
      name: toolName,
      count: record.calls,
      avg_ms: avgMs === null ? null : roundMetric(avgMs),
      p50_ms: null,
      p95_ms: null,
      max_ms: null,
    });
  }

  return { requests, errors, latency };
}

function deriveRestRows(): {
  requests: RuntimeRequestMetricRow[];
  errors: RuntimeErrorMetricRow[];
  latency: RuntimeLatencyMetricRow[];
} {
  const snapshot = getMetricsSnapshot();
  const requests: RuntimeRequestMetricRow[] = [];
  const errors: RuntimeErrorMetricRow[] = [];
  const latency: RuntimeLatencyMetricRow[] = [];

  for (const [routeName, record] of Object.entries(snapshot.rest ?? {})) {
    const avgMs = record.calls > 0 ? record.total_ms / record.calls : null;
    const errorRate = record.calls > 0 ? record.failures / record.calls : 0;

    requests.push({
      surface: "rest",
      operation_class: "rest",
      name: routeName,
      request_count: record.calls,
      error_count: record.failures,
    });

    errors.push({
      surface: "rest",
      operation_class: "rest",
      name: routeName,
      error_count: record.failures,
      error_rate: roundMetric(errorRate),
      last_error: record.last_error,
    });

    latency.push({
      surface: "rest",
      operation_class: "rest",
      name: routeName,
      count: record.calls,
      avg_ms: avgMs === null ? null : roundMetric(avgMs),
      p50_ms: null,
      p95_ms: null,
      max_ms: null,
    });
  }

  return { requests, errors, latency };
}

function deriveGraphRows(): {
  requests: RuntimeRequestMetricRow[];
  latency: RuntimeLatencyMetricRow[];
  graph: RuntimeGraphQueryCostRow[];
  hotspots: RuntimeGraphHotspotRow[];
  cache: RuntimeCacheMetricRow[];
  features: RuntimeFeatureMetricRow[];
} {
  const view = getMetricsView();
  const requests: RuntimeRequestMetricRow[] = [];
  const latency: RuntimeLatencyMetricRow[] = [];
  const graph: RuntimeGraphQueryCostRow[] = [];
  const hotspots: RuntimeGraphHotspotRow[] = [];
  const cacheMap = new Map<string, { hits: number; misses: number }>();
  const features: RuntimeFeatureMetricRow[] = [];

  for (const [name, metric] of Object.entries(view.metrics)) {
    if (name.endsWith(".latency_ms")) {
      const baseName = name.slice(0, -".latency_ms".length);
      const operationClass = baseName.startsWith("client.") ? "client_route" : "route";
      const surface: RuntimeMetricSurface = baseName.startsWith("client.") ? "feature" : "graph_query";
      requests.push({
        surface,
        operation_class: operationClass,
        name: baseName,
        request_count: metric.count,
        error_count: 0,
      });
      latency.push({
        surface,
        operation_class: operationClass,
        name: baseName,
        count: metric.count,
        avg_ms: null,
        p50_ms: metric.p50,
        p95_ms: metric.p95,
        max_ms: metric.max,
      });
      hotspots.push({
        name: baseName,
        surface,
        operation_class: operationClass,
        count: metric.count,
        p95_ms: metric.p95,
        max_ms: metric.max,
      });
      if (surface === "graph_query") {
        graph.push({
          name: baseName,
          count: metric.count,
          last: metric.last,
          p50: metric.p50,
          p95: metric.p95,
          max: metric.max,
        });
      }
      continue;
    }

    if (name.startsWith("client.")) {
      features.push({
        name,
        usage_count: metric.count,
        last_used_at: null,
        notes: "Derived from explorer client metrics rolling window.",
      });
      continue;
    }

    if (name.includes("cache")) {
      const normalizedName = name.replace(/\.(hit|miss)(es)?$/u, "");
      const entry = cacheMap.get(normalizedName) ?? { hits: 0, misses: 0 };
      if (name.includes("hit")) entry.hits += metric.count;
      if (name.includes("miss")) entry.misses += metric.count;
      cacheMap.set(normalizedName, entry);
      continue;
    }

    graph.push({
      name,
      count: metric.count,
      last: metric.last,
      p50: metric.p50,
      p95: metric.p95,
      max: metric.max,
    });
  }

  const cache = Array.from(cacheMap.entries()).map(([name, counts]) => {
    const total = counts.hits + counts.misses;
    return {
      name,
      hits: counts.hits,
      misses: counts.misses,
      hit_rate: total > 0 ? roundMetric(counts.hits / total) : null,
    };
  });

  return { requests, latency, graph, hotspots, cache, features };
}

function groupRequestsBySurface(rows: RuntimeRequestMetricRow[]): RuntimeRequestMetricRow[] {
  const grouped = new Map<string, RuntimeRequestMetricRow>();
  for (const row of rows) {
    const key = `${row.surface}::${row.operation_class}`;
    const existing = grouped.get(key);
    if (existing) {
      existing.request_count += row.request_count;
      existing.error_count += row.error_count;
      continue;
    }
    grouped.set(key, {
      surface: row.surface,
      operation_class: row.operation_class,
      name: row.surface,
      request_count: row.request_count,
      error_count: row.error_count,
    });
  }
  return Array.from(grouped.values()).sort((a, b) => b.request_count - a.request_count);
}

function groupRequestsByName(rows: RuntimeRequestMetricRow[]): RuntimeRequestMetricRow[] {
  return [...rows].sort((a, b) => b.request_count - a.request_count || a.name.localeCompare(b.name));
}

function groupErrorsBySurface(rows: RuntimeErrorMetricRow[]): RuntimeErrorMetricRow[] {
  const grouped = new Map<string, RuntimeErrorMetricRow>();
  for (const row of rows) {
    const key = `${row.surface}::${row.operation_class}`;
    const existing = grouped.get(key);
    if (existing) {
      existing.error_count += row.error_count;
      existing.last_error = existing.last_error ?? row.last_error;
      continue;
    }
    grouped.set(key, {
      surface: row.surface,
      operation_class: row.operation_class,
      name: row.surface,
      error_count: row.error_count,
      error_rate: row.error_rate,
      last_error: row.last_error,
    });
  }
  return Array.from(grouped.values())
    .map((row) => ({ ...row, error_rate: row.error_count > 0 ? roundMetric(row.error_rate) : 0 }))
    .sort((a, b) => b.error_count - a.error_count);
}

function groupErrorsByName(rows: RuntimeErrorMetricRow[]): RuntimeErrorMetricRow[] {
  return [...rows].sort((a, b) => b.error_count - a.error_count || a.name.localeCompare(b.name));
}

function deriveErrorsByEntity(rows: RuntimeErrorMetricRow[]): RuntimeErrorMetricRow[] {
  return rows
    .filter((row) => row.entity_id || row.name.startsWith("client."))
    .map((row) => ({ ...row, entity_id: row.entity_id ?? row.name }))
    .sort((a, b) => b.error_count - a.error_count || (a.entity_id ?? "").localeCompare(b.entity_id ?? ""));
}

function groupLatencyByOperationClass(rows: RuntimeLatencyMetricRow[]): RuntimeLatencyMetricRow[] {
  const grouped = new Map<string, { sumCount: number; weightedAvg: number; p50: number[]; p95: number[]; max: number[]; surface: RuntimeMetricSurface; operation_class: string }>();
  for (const row of rows) {
    const key = `${row.surface}::${row.operation_class}`;
    const existing = grouped.get(key) ?? {
      sumCount: 0,
      weightedAvg: 0,
      p50: [],
      p95: [],
      max: [],
      surface: row.surface,
      operation_class: row.operation_class,
    };
    existing.sumCount += row.count;
    if (row.avg_ms !== null) existing.weightedAvg += row.avg_ms * row.count;
    if (row.p50_ms !== null) existing.p50.push(row.p50_ms);
    if (row.p95_ms !== null) existing.p95.push(row.p95_ms);
    if (row.max_ms !== null) existing.max.push(row.max_ms);
    grouped.set(key, existing);
  }

  return Array.from(grouped.values())
    .map((entry) => ({
      surface: entry.surface,
      operation_class: entry.operation_class,
      name: entry.operation_class,
      count: entry.sumCount,
      avg_ms: entry.sumCount > 0 && entry.weightedAvg > 0 ? roundMetric(entry.weightedAvg / entry.sumCount) : null,
      p50_ms: entry.p50.length > 0 ? roundMetric(entry.p50.reduce((sum, value) => sum + value, 0) / entry.p50.length) : null,
      p95_ms: entry.p95.length > 0 ? roundMetric(Math.max(...entry.p95)) : null,
      max_ms: entry.max.length > 0 ? roundMetric(Math.max(...entry.max)) : null,
    }))
    .sort((a, b) => (b.p95_ms ?? 0) - (a.p95_ms ?? 0) || b.count - a.count);
}

function groupLatencyByName(rows: RuntimeLatencyMetricRow[]): RuntimeLatencyMetricRow[] {
  return [...rows].sort((a, b) => (b.p95_ms ?? b.avg_ms ?? 0) - (a.p95_ms ?? a.avg_ms ?? 0) || b.count - a.count);
}

async function deriveDeadFeatureCandidates(usage: RuntimeFeatureMetricRow[]): Promise<RuntimeDeadFeatureCandidateRow[]> {
  const features = await loadJsonArray<Feature>("features.json");
  const usageMap = new Map(usage.map((row) => [row.name, row]));
  return features
    .filter((feature) => !usageMap.has(feature.id))
    .map((feature) => ({
      name: feature.id,
      reason: "Known feature has no observed runtime usage in the current metrics window.",
      usage_count: 0,
      last_used_at: null,
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

export async function getRuntimeMetricsSnapshotV1(): Promise<RuntimeMetricsSnapshotV1> {
  const selfSnapshot = getMetricsSnapshot();
  const toolRows = deriveToolRows();
  const restRows = deriveRestRows();
  const graphRows = deriveGraphRows();
  const requestRows = [...toolRows.requests, ...restRows.requests, ...graphRows.requests];
  const errorRows = [...toolRows.errors, ...restRows.errors];
  const latencyRows = [...toolRows.latency, ...restRows.latency, ...graphRows.latency];
  const featureUsage = [...graphRows.features].sort((a, b) => b.usage_count - a.usage_count || a.name.localeCompare(b.name));
  const deadCandidates = await deriveDeadFeatureCandidates(featureUsage);

  return {
    snapshot_at: selfSnapshot.snapshot_at,
    window: {
      kind: "process_lifetime",
      started_at: selfSnapshot.started_at,
      uptime_s: selfSnapshot.uptime_s,
    },
    requests: {
      by_surface: groupRequestsBySurface(requestRows),
      by_name: groupRequestsByName(requestRows),
    },
    errors: {
      by_surface: groupErrorsBySurface(errorRows),
      by_name: groupErrorsByName(errorRows),
      by_entity: deriveErrorsByEntity(errorRows),
    },
    latency: {
      by_operation_class: groupLatencyByOperationClass(latencyRows),
      by_name: groupLatencyByName(latencyRows),
    },
    graph: {
      query_cost: graphRows.graph.sort((a, b) => (b.p95 ?? 0) - (a.p95 ?? 0) || b.count - a.count),
      hotspots: graphRows.hotspots.sort((a, b) => (b.p95_ms ?? 0) - (a.p95_ms ?? 0) || b.count - a.count),
    },
    cache: {
      entries: graphRows.cache.sort((a, b) => (b.hit_rate ?? 0) - (a.hit_rate ?? 0) || a.name.localeCompare(b.name)),
    },
    features: {
      usage: featureUsage,
      dead_candidates: deadCandidates,
    },
  };
}
