import { Fragment, useEffect, useState, type ReactNode } from "react";
import { fetchNode } from "./api";
import type { ExplorerEdge, ExplorerNode, NodeRecord, StatsResult } from "./types";

interface Props {
  selected: ExplorerNode | null;
  stats: StatsResult | null;
  onNavigate: (id: string) => void;
}

/**
 * Right-hand inspector. Shows snapshot stats when nothing is selected.
 * On selection, fetches the full NodeRecord (entity + outgoing/incoming
 * edges) and renders the type-specific entity payload + adjacency lists.
 */
export function Inspector({ selected, stats, onNavigate }: Props) {
  const [record, setRecord] = useState<NodeRecord | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!selected) {
      setRecord(null);
      setError(null);
      return;
    }
    let cancelled = false;
    setLoading(true);
    setError(null);
    fetchNode(selected.id)
      .then((r) => {
        if (cancelled) return;
        setRecord(r);
      })
      .catch((e: Error) => {
        if (cancelled) return;
        setError(e.message);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [selected]);

  if (!selected) {
    return (
      <div className="inspector">
        <h2 className="inspector-title">Snapshot</h2>
        {stats ? (
          <dl className="kv">
            <dt>Nodes</dt><dd>{stats.totals.nodes}</dd>
            <dt>Edges</dt><dd>{stats.totals.edges}</dd>
            <dt>Tensions (active)</dt><dd>{stats.totals.tensions_active}</dd>
            <dt>Tensions (resolved)</dt><dd>{stats.totals.tensions_resolved}</dd>
            <dt>Mean health</dt><dd>{stats.health_mean.toFixed(2)}</dd>
            <dt>Mean confidence</dt><dd>{stats.confidence_mean.toFixed(2)}</dd>
          </dl>
        ) : (
          <p className="inspector-empty">Loading stats…</p>
        )}
        {stats ? (
          <>
            <h3 className="inspector-subtitle">By type</h3>
            <dl className="kv">
              {Object.entries(stats.nodes_by_type).map(([k, v]) => (
                <>
                  <dt key={`t-${k}`}>{k}</dt>
                  <dd key={`v-${k}`}>{v}</dd>
                </>
              ))}
            </dl>
            <h3 className="inspector-subtitle">By edge kind</h3>
            <dl className="kv">
              {Object.entries(stats.edges_by_kind).map(([k, v]) => (
                <>
                  <dt key={`et-${k}`}>{k}</dt>
                  <dd key={`ev-${k}`}>{v}</dd>
                </>
              ))}
            </dl>
          </>
        ) : null}
      </div>
    );
  }

  return (
    <div className="inspector">
      <h2 className="inspector-title">{selected.label}</h2>
      <p className="inspector-id">{selected.type} · {selected.id}</p>
      <dl className="kv">
        <dt>Degree</dt><dd>{selected.degree}</dd>
        {selected.type !== "tension" ? (
          <>
            <dt>Health</dt><dd>{selected.health.toFixed(2)}</dd>
          </>
        ) : null}
        {selected.type === "dream_node" ? (
          <>
            <dt>Confidence</dt><dd>{selected.confidence.toFixed(2)}</dd>
          </>
        ) : null}
      </dl>
      {loading ? <p className="inspector-empty">Loading…</p> : null}
      {error ? <p className="inspector-error">{error}</p> : null}
      {record ? (
        <>
          <EntityBlock record={record} onNavigate={onNavigate} />
          <EdgeList
            title="Outgoing"
            edges={record.outgoing}
            otherKey="t"
            onNavigate={onNavigate}
          />
          <EdgeList
            title="Incoming"
            edges={record.incoming}
            otherKey="s"
            onNavigate={onNavigate}
          />
        </>
      ) : null}
    </div>
  );
}

export function EntityBlock({
  record,
  onNavigate,
}: {
  record: NodeRecord;
  onNavigate: (id: string) => void;
}) {
  const parsedEntity = parseStructuredJson(record.entity);
  if (!isRecord(parsedEntity)) {
    if (parsedEntity === null || parsedEntity === undefined) return null;
    return (
      <>
        <h3 className="inspector-subtitle">Entity</h3>
        <StructuredValue value={parsedEntity} path={["entity"]} onNavigate={onNavigate} />
      </>
    );
  }

  const preferred = [
    "category",
    "tags",
    "domain",
    "urgency",
    "status",
    "strategy",
    "reason",
    "description",
    "intent",
    "purpose",
    "data_contract",
    "interactions",
    "visual_semantics",
    "layout_semantics",
    "implementations",
    "used_by",
    "children",
    "flows",
    "links",
    "enrichment",
    "source_repo",
    "source_files",
    "key_fields",
    "steps",
    "entities",
    "relationships",
    "state",
    "error_states",
    "rendering_capabilities",
    "provenance",
    "meta",
  ];
  const excluded = new Set(["id", "name"]);
  const orderedKeys = [
    ...preferred,
    ...Object.keys(parsedEntity).filter((key) => !preferred.includes(key) && !excluded.has(key)),
  ];
  const rows = orderedKeys
    .map((key) => [key, parsedEntity[key]] as const)
    .filter(([, value]) => value !== undefined && value !== null);
  if (rows.length === 0) return null;
  return (
    <>
      <h3 className="inspector-subtitle">Entity</h3>
      <div className="entity-fields">
        {rows.map(([key, value]) => {
          const fullWidth = isStructuredValue(value) ||
            ["description", "description_raw", "intent", "reason"].includes(key);
          return (
            <section
              className={`entity-field${fullWidth ? " entity-field--full" : ""}`}
              key={key}
            >
              <h4 className="entity-field-label">{humanizeKey(key)}</h4>
              <div className="entity-field-value">
                <StructuredValue value={value} path={[key]} onNavigate={onNavigate} />
              </div>
            </section>
          );
        })}
      </div>
    </>
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

/** Parse JSON containers supplied as strings without changing ordinary prose. */
export function parseStructuredJson(value: unknown): unknown {
  if (typeof value !== "string") return value;
  const trimmed = value.trim();
  if (!(trimmed.startsWith("{") && trimmed.endsWith("}")) &&
      !(trimmed.startsWith("[") && trimmed.endsWith("]"))) {
    return value;
  }
  try {
    const parsed = JSON.parse(trimmed) as unknown;
    return isRecord(parsed) || Array.isArray(parsed) ? parsed : value;
  } catch {
    return value;
  }
}

function isStructuredValue(value: unknown): boolean {
  const parsed = parseStructuredJson(value);
  return isRecord(parsed) || Array.isArray(parsed);
}

function humanizeKey(key: string): string {
  const abbreviations = new Map([
    ["ui", "UI"], ["llm", "LLM"], ["api", "API"], ["id", "ID"],
    ["mcp", "MCP"], ["adr", "ADR"], ["url", "URL"],
  ]);
  return key
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .split(/[_\-\s]+/)
    .filter(Boolean)
    .map((part) => abbreviations.get(part.toLowerCase()) ?? `${part.charAt(0).toUpperCase()}${part.slice(1)}`)
    .join(" ");
}

function summaryForRecord(value: Record<string, unknown>): string | null {
  for (const key of ["name", "target", "action", "platform", "region", "state", "id"]) {
    const candidate = value[key];
    if (typeof candidate === "string" && candidate.trim()) return candidate;
    if (typeof candidate === "number") return String(candidate);
  }
  return null;
}

function isNavigablePath(path: string[]): boolean {
  const leaf = path[path.length - 1];
  const root = path[0];
  if (leaf === "target" || leaf === "source") return true;
  return path.length === 1 &&
    ["links", "used_by", "children", "flows", "entities", "relationships"].includes(root);
}

function ScalarValue({
  value,
  path,
  onNavigate,
}: {
  value: string | number | boolean;
  path: string[];
  onNavigate: (id: string) => void;
}) {
  if (typeof value === "boolean") {
    return <span className={`structured-boolean ${value ? "is-true" : "is-false"}`}>{value ? "Yes" : "No"}</span>;
  }
  if (typeof value === "number") return <span className="structured-number">{value}</span>;
  if (isNavigablePath(path)) {
    return (
      <button type="button" className="structured-entity-link" onClick={() => onNavigate(value)}>
        {value}
      </button>
    );
  }
  const leaf = path[path.length - 1];
  const codeLike = /(?:^|_)(?:id|repo|file|files|model|enricher|uri|kind)$/.test(leaf) ||
    /^(?:source_repo|source_file|source_files)$/.test(path[0]);
  return <span className={codeLike ? "structured-code" : "structured-text"}>{value}</span>;
}

export function StructuredValue({
  value,
  path,
  onNavigate,
  depth = 0,
}: {
  value: unknown;
  path: string[];
  onNavigate: (id: string) => void;
  depth?: number;
}): ReactNode {
  const parsed = parseStructuredJson(value);

  if (parsed === null || parsed === undefined) return <span className="structured-empty">Not set</span>;
  if (typeof parsed === "string" || typeof parsed === "number" || typeof parsed === "boolean") {
    return <ScalarValue value={parsed} path={path} onNavigate={onNavigate} />;
  }

  if (Array.isArray(parsed)) {
    if (parsed.length === 0) return <span className="structured-empty">None</span>;
    const scalarOnly = parsed.every((item) =>
      typeof item === "string" || typeof item === "number" || typeof item === "boolean",
    );
    if (scalarOnly) {
      return (
        <ul className="structured-chips">
          {parsed.map((item, index) => (
            <li key={`${String(item)}-${index}`}>
              <ScalarValue value={item as string | number | boolean} path={path} onNavigate={onNavigate} />
            </li>
          ))}
        </ul>
      );
    }
    return (
      <div className="structured-list">
        {parsed.map((item, index) => {
          const itemRecord = isRecord(item) ? item : null;
          const summary = itemRecord ? summaryForRecord(itemRecord) : null;
          return (
            <article className="structured-card" key={`${summary ?? "item"}-${index}`}>
              {summary ? <div className="structured-card-title">{summary}</div> : null}
              <StructuredValue
                value={item}
                path={[...path, String(index)]}
                onNavigate={onNavigate}
                depth={depth + 1}
              />
            </article>
          );
        })}
      </div>
    );
  }

  if (isRecord(parsed)) {
    const entries = Object.entries(parsed).filter(([, child]) => child !== undefined && child !== null);
    if (entries.length === 0) return <span className="structured-empty">No structured data</span>;
    return (
      <dl className={`structured-object structured-object--depth-${Math.min(depth, 2)}`}>
        {entries.map(([key, child]) => (
          <Fragment key={key}>
            <dt>{humanizeKey(key)}</dt>
            <dd>
              <StructuredValue
                value={child}
                path={[...path, key]}
                onNavigate={onNavigate}
                depth={depth + 1}
              />
            </dd>
          </Fragment>
        ))}
      </dl>
    );
  }

  return <span className="structured-text">{String(parsed)}</span>;
}

function EdgeList({
  title,
  edges,
  otherKey,
  onNavigate,
}: {
  title: string;
  edges: ExplorerEdge[];
  otherKey: "s" | "t";
  onNavigate: (id: string) => void;
}) {
  if (edges.length === 0) return null;
  return (
    <>
      <h3 className="inspector-subtitle">{title} ({edges.length})</h3>
      <ul className="edgelist">
        {edges.map((e, i) => {
          const id = e[otherKey];
          return (
            <li key={`${id}-${e.kind}-${i}`} className={`edgelist-item k-${e.kind}`}>
              <button className="edgelist-link" onClick={() => onNavigate(id)}>
                <span className={`edgelist-kind k-${e.kind}`}>{e.kind}</span>
                <span className="edgelist-target">{id}</span>
                <span className="edgelist-conf">{e.conf.toFixed(2)}</span>
              </button>
            </li>
          );
        })}
      </ul>
    </>
  );
}
