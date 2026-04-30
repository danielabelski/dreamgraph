import { lazy, Suspense, useEffect, useMemo, useRef, useState } from "react";
import {
  DEFAULT_EXPLORER_PREFS,
  fetchExplorerPrefs,
  fetchSnapshot,
  fetchStats,
  patchExplorerPrefs,
  SnapshotVersionError,
  type ExplorerPrefs,
  type ExplorerRenderMode,
} from "./api";
import { GraphCanvas } from "./GraphCanvas";

// 3D canvas is split into its own chunk so the Three.js + OrbitControls
// payload is only paid by users who actually flip the toggle.
const Graph3DCanvas = lazy(() => import("./Graph3DCanvas"));
import { SearchBar } from "./SearchBar";
import { FiltersPanel } from "./FiltersPanel";
import { Inspector } from "./Inspector";
import { TensionsPanel } from "./TensionsPanel";
import { CandidatesPanel } from "./CandidatesPanel";
import { defaultFilters, type ExplorerMode, type FilterState } from "./filters";
import { EDGE_STYLES, NODE_COLORS } from "./theme";
import type { ExplorerEdgeKind, ExplorerNodeType, GraphSnapshot, StatsResult } from "./types";
import { useEventStream } from "./sse";
import { EventDock } from "./EventDock";

type RightTab = "inspector" | "tensions" | "candidates";

const SIDEBAR_MIN = 200;
const SIDEBAR_MAX = 640;
const COLLAPSED_W = 24;
const LEFT_DEFAULT = 240;
const RIGHT_DEFAULT = 360;

function readNum(key: string, fallback: number): number {
  if (typeof window === "undefined") return fallback;
  const raw = window.localStorage.getItem(key);
  const n = raw ? Number(raw) : NaN;
  return Number.isFinite(n) ? n : fallback;
}
function readBool(key: string, fallback: boolean): boolean {
  if (typeof window === "undefined") return fallback;
  const raw = window.localStorage.getItem(key);
  if (raw === null) return fallback;
  return raw === "1";
}

export function App() {
  const [snapshot, setSnapshot] = useState<GraphSnapshot | null>(null);
  const [stats, setStats] = useState<StatsResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [versionError, setVersionError] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);
  const [filters, setFilters] = useState<FilterState>(() => defaultFilters());
  const [mode, setMode] = useState<ExplorerMode>("atlas");
  const [rightTab, setRightTab] = useState<RightTab>("inspector");
  const [conflictBanner, setConflictBanner] = useState(false);
  const [prefs, setPrefs] = useState<ExplorerPrefs>(DEFAULT_EXPLORER_PREFS);
  const [render3dError, setRender3dError] = useState<string | null>(null);
  const { events: liveEvents, pulses, connected: sseConnected } = useEventStream();

  // Hydrate the renderer mode from the daemon on mount. Defaults stand
  // until the prefs file roundtrips so first paint is never blocked.
  useEffect(() => {
    let cancelled = false;
    void fetchExplorerPrefs().then((p) => {
      if (!cancelled) setPrefs(p);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  const setRenderMode = (next: ExplorerRenderMode) => {
    if (next === prefs.renderMode) return;
    setRender3dError(null);
    setPrefs((p) => ({ ...p, renderMode: next }));
    void patchExplorerPrefs({ renderMode: next });
  };

  const [leftWidth, setLeftWidth] = useState<number>(() => readNum("dg.explorer.leftWidth", LEFT_DEFAULT));
  const [rightWidth, setRightWidth] = useState<number>(() => readNum("dg.explorer.rightWidth", RIGHT_DEFAULT));
  const [leftCollapsed, setLeftCollapsed] = useState<boolean>(() => readBool("dg.explorer.leftCollapsed", false));
  const [rightCollapsed, setRightCollapsed] = useState<boolean>(() => readBool("dg.explorer.rightCollapsed", false));
  const [dragging, setDragging] = useState<"left" | "right" | null>(null);
  const dragStartRef = useRef<{ x: number; startWidth: number } | null>(null);

  useEffect(() => { window.localStorage.setItem("dg.explorer.leftWidth", String(leftWidth)); }, [leftWidth]);
  useEffect(() => { window.localStorage.setItem("dg.explorer.rightWidth", String(rightWidth)); }, [rightWidth]);
  useEffect(() => { window.localStorage.setItem("dg.explorer.leftCollapsed", leftCollapsed ? "1" : "0"); }, [leftCollapsed]);
  useEffect(() => { window.localStorage.setItem("dg.explorer.rightCollapsed", rightCollapsed ? "1" : "0"); }, [rightCollapsed]);

  useEffect(() => {
    if (!dragging) return;
    const onMove = (e: MouseEvent) => {
      const start = dragStartRef.current;
      if (!start) return;
      const dx = e.clientX - start.x;
      // Right rail grows when dragged left (negative dx), left rail grows when dragged right.
      const next = dragging === "left"
        ? start.startWidth + dx
        : start.startWidth - dx;
      const clamped = Math.max(SIDEBAR_MIN, Math.min(SIDEBAR_MAX, next));
      if (dragging === "left") setLeftWidth(clamped);
      else setRightWidth(clamped);
    };
    const onUp = () => {
      dragStartRef.current = null;
      setDragging(null);
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    return () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
  }, [dragging]);

  const beginDrag = (side: "left" | "right") => (e: React.MouseEvent) => {
    e.preventDefault();
    dragStartRef.current = { x: e.clientX, startWidth: side === "left" ? leftWidth : rightWidth };
    setDragging(side);
  };

  const refreshSnapshot = () => {
    const t0 = performance.now();
    fetchSnapshot()
      .then((s) => {
        setSnapshot(s);
        const ms = Math.round(performance.now() - t0);
        void fetch("/explorer/api/metrics/client", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ "snapshot.fetch_ms": ms }),
        }).catch(() => undefined);
      })
      .catch((err: unknown) => {
        if (err instanceof SnapshotVersionError) setVersionError(true);
        else setError(err instanceof Error ? err.message : String(err));
      });
    fetchStats().then(setStats).catch(() => undefined);
  };

  useEffect(() => {
    refreshSnapshot();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const selectedNode = useMemo(() => {
    if (!snapshot || !selected) return null;
    return snapshot.nodes.find((n) => n.id === selected) ?? null;
  }, [snapshot, selected]);

  const nodeColors = NODE_COLORS as Record<ExplorerNodeType, string>;
  const edgeColors = useMemo(() => {
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(EDGE_STYLES)) out[k] = v.color;
    return out as Record<ExplorerEdgeKind, string>;
  }, []);

  return (
    <div
      className="app"
      style={{
        gridTemplateColumns: `${leftCollapsed ? COLLAPSED_W : leftWidth}px 6px 1fr 6px ${rightCollapsed ? COLLAPSED_W : rightWidth}px`,
      }}
    >
      <div className="topbar" style={{ gridColumn: "1 / 6" }}>
        <span className="brand">DreamGraph Explorer</span>
        <span className="meta">Phase 4 · curated mutations</span>
        <SearchBar onPick={setSelected} />
        <div className="mode-toggle">
          <button
            className={`mode-btn${mode === "atlas" ? " active" : ""}`}
            onClick={() => setMode("atlas")}
            title="Show the entire graph"
          >
            Atlas
          </button>
          <button
            className={`mode-btn${mode === "focus" ? " active" : ""}`}
            onClick={() => setMode("focus")}
            disabled={!selected}
            title={selected ? "Show only the selected node and its 2-hop neighborhood" : "Select a node first"}
          >
            Focus
          </button>
        </div>
        <div className="mode-toggle" role="group" aria-label="Renderer">
          <button
            className={`mode-btn${prefs.renderMode === "2d" ? " active" : ""}`}
            onClick={() => setRenderMode("2d")}
            title="Classic 2D Sigma renderer"
          >
            2D
          </button>
          <button
            className={`mode-btn${prefs.renderMode === "3d" ? " active" : ""}`}
            onClick={() => setRenderMode("3d")}
            title="Experimental 3D Three.js renderer (slice A)"
          >
            3D ✨
          </button>
        </div>
        {snapshot ? (
          <span className="meta">
            instance <strong>{snapshot.instance_uuid.slice(0, 8)}</strong>
          </span>
        ) : null}
        {snapshot ? (
          <span className="meta">
            etag <strong>{snapshot.etag.slice(7, 15)}</strong>
          </span>
        ) : null}
      </div>

      {leftCollapsed ? (
        <button
          className="sidebar-reopen"
          onClick={() => setLeftCollapsed(false)}
          title="Expand filters panel"
          aria-label="Expand filters panel"
        >
          Filters
        </button>
      ) : (
        <aside className="left">
          <button
            className="sidebar-collapse left"
            onClick={() => setLeftCollapsed(true)}
            title="Collapse filters panel"
            aria-label="Collapse filters panel"
          >
            &lt;
          </button>
          <FiltersPanel
            filters={filters}
            onChange={setFilters}
            nodeColors={nodeColors}
            edgeColors={edgeColors}
          />
          {versionError ? (
            <div className="error-banner">
              Daemon snapshot version is newer than this Explorer build — please
              update the SPA assets.
            </div>
          ) : null}
          {error ? <div className="error-banner">{error}</div> : null}
        </aside>
      )}

      <div
        className={`resizer${dragging === "left" ? " dragging" : ""}`}
        onMouseDown={beginDrag("left")}
        role="separator"
        aria-orientation="vertical"
      />

      {snapshot ? (
        prefs.renderMode === "3d" && !render3dError ? (
          <Suspense
            fallback={
              <div className="canvas-wrap">
                <div className="status">loading 3D renderer…</div>
              </div>
            }
          >
            <Graph3DCanvas
              prefs={prefs}
              snapshot={snapshot}
              onFatal={(msg) => {
                setRender3dError(msg);
                setRenderMode("2d");
              }}
            />
          </Suspense>
        ) : (
          <GraphCanvas
            snapshot={snapshot}
            onSelect={setSelected}
            filters={filters}
            mode={mode}
            selected={selected}
            pulses={pulses}
          />
        )
      ) : (
        <div className="canvas-wrap">
          <div className="status">
            {error || versionError ? "snapshot unavailable" : "loading snapshot…"}
          </div>
        </div>
      )}

      <div
        className={`resizer${dragging === "right" ? " dragging" : ""}`}
        onMouseDown={beginDrag("right")}
        role="separator"
        aria-orientation="vertical"
      />

      {rightCollapsed ? (
        <button
          className="sidebar-reopen right"
          onClick={() => setRightCollapsed(false)}
          title="Expand inspector panel"
          aria-label="Expand inspector panel"
        >
          Inspector
        </button>
      ) : (
        <aside className="right">
          <button
            className="sidebar-collapse right"
            onClick={() => setRightCollapsed(true)}
            title="Collapse inspector panel"
            aria-label="Collapse inspector panel"
          >
            &gt;
          </button>
          <div className="right-tabs">
          <button
            className={`right-tab${rightTab === "inspector" ? " active" : ""}`}
            onClick={() => setRightTab("inspector")}
          >
            Inspector
          </button>
          <button
            className={`right-tab${rightTab === "tensions" ? " active" : ""}`}
            onClick={() => setRightTab("tensions")}
          >
            Tensions
            {stats && stats.totals.tensions_active > 0 ? (
              <span className="right-tab-badge">{stats.totals.tensions_active}</span>
            ) : null}
          </button>
          <button
            className={`right-tab${rightTab === "candidates" ? " active" : ""}`}
            onClick={() => setRightTab("candidates")}
          >
            Candidates
          </button>
        </div>
        {conflictBanner ? (
          <div className="conflict-banner">
            Graph moved on. Snapshot refreshed — please retry.
          </div>
        ) : null}
        {rightTab === "inspector" ? (
          <Inspector
            selected={selectedNode}
            stats={stats}
            onNavigate={setSelected}
          />
        ) : rightTab === "tensions" && snapshot ? (
          <TensionsPanel
            instanceUuid={snapshot.instance_uuid}
            etag={snapshot.etag}
            onConflict={() => {
              setConflictBanner(true);
              refreshSnapshot();
              setTimeout(() => setConflictBanner(false), 4000);
            }}
            onApplied={() => {
              refreshSnapshot();
            }}
            onInspect={(id) => {
              setSelected(id);
              setRightTab("inspector");
            }}
          />
        ) : rightTab === "candidates" && snapshot ? (
          <CandidatesPanel
            instanceUuid={snapshot.instance_uuid}
            etag={snapshot.etag}
            onConflict={() => {
              setConflictBanner(true);
              refreshSnapshot();
              setTimeout(() => setConflictBanner(false), 4000);
            }}
            onApplied={() => {
              refreshSnapshot();
            }}
            onInspect={(id) => {
              setSelected(id);
              setRightTab("inspector");
            }}
          />
        ) : (
          <div className="panel-empty">Loading…</div>
        )}
        </aside>
      )}
      <EventDock events={liveEvents} connected={sseConnected} />
    </div>
  );
}
