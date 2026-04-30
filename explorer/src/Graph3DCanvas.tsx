/**
 * DreamGraph Explorer — 3D canvas (Slice D: polish + interaction).
 *
 * plans/EXPLORER_3D_MODE.md §12.D
 *
 * Slice D additions on top of Slice C:
 *   - Per-type node shapes (in `NodeSystem`).
 *   - Hover + click picking via Raycaster on the InstancedMesh buckets,
 *     wired to the same selection state the 2D canvas uses.
 *   - `UnrealBloomPass` post-processing (toggleable).
 *   - `prefers-reduced-motion` honored for particle motion.
 *   - Keyboard shortcuts: B (bloom), Space (pause particles), G (grid),
 *     R (reset camera), F (frame all), Esc (clear selection).
 *
 * Out of scope for v1: SSE pulse bursts, cycle-wave sphere, GPU shader
 * picking, label sprites — see the plan §3.2.4–§3.2.6.
 */

import { useEffect, useRef } from "react";
import {
  Box3,
  Raycaster,
  Vector2,
  Vector3,
  type PerspectiveCamera,
} from "three";
import {
  fetchHeatmap,
  patchExplorerPrefs,
  type ExplorerPrefs,
  type HeatmapResult,
} from "./api";
import type { GraphSnapshot } from "./types";
import { createScene, hasWebGL2 } from "./three/scene";
import { LayoutBridge } from "./three/layout3d";
import { NodeSystem } from "./three/NodeSystem";
import { SplineSet } from "./three/splines";
import { TubeSystem } from "./three/TubeSystem";
import { ParticleSystem } from "./three/ParticleSystem";

interface Graph3DCanvasProps {
  prefs: ExplorerPrefs;
  snapshot: GraphSnapshot;
  /** Currently selected node id (lifted from `App`, shared with 2D mode). */
  selected?: string | null;
  /** Click handler — same shape as `GraphCanvas.onSelect`. */
  onSelect?: (nodeId: string | null) => void;
  /** Surface a fatal init error to the parent so it can fall back to 2D. */
  onFatal?: (message: string) => void;
}

export default function Graph3DCanvas({
  prefs,
  snapshot,
  selected,
  onSelect,
  onFatal,
}: Graph3DCanvasProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  // Latest values in refs so the long-lived effect can read them without
  // tearing down the scene on every prop change.
  const prefsRef = useRef(prefs);
  prefsRef.current = prefs;
  const snapshotRef = useRef(snapshot);
  snapshotRef.current = snapshot;
  const selectedRef = useRef<string | null>(selected ?? null);
  const onSelectRef = useRef(onSelect);
  onSelectRef.current = onSelect;
  const statusRef = useRef<HTMLDivElement | null>(null);
  /** Imperative handle filled in by the mount effect; null until then. */
  const apiRef = useRef<{ setSelected(id: string | null): void } | null>(null);

  // Push selection updates from React → renderer without re-mounting.
  useEffect(() => {
    selectedRef.current = selected ?? null;
    apiRef.current?.setSelected(selected ?? null);
  }, [selected]);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    if (!hasWebGL2()) {
      onFatal?.("WebGL2 not available on this device — falling back to 2D.");
      return;
    }

    let disposed = false;
    let raf = 0;
    let cleanup: (() => void) | null = null;

    (async () => {
      const [{ OrbitControls }, composerMod, renderPassMod, bloomMod] =
        await Promise.all([
          import("three/examples/jsm/controls/OrbitControls.js") as Promise<
            typeof import("three/examples/jsm/controls/OrbitControls.js")
          >,
          import("three/examples/jsm/postprocessing/EffectComposer.js") as Promise<
            typeof import("three/examples/jsm/postprocessing/EffectComposer.js")
          >,
          import("three/examples/jsm/postprocessing/RenderPass.js") as Promise<
            typeof import("three/examples/jsm/postprocessing/RenderPass.js")
          >,
          import("three/examples/jsm/postprocessing/UnrealBloomPass.js") as Promise<
            typeof import("three/examples/jsm/postprocessing/UnrealBloomPass.js")
          >,
        ]);

      if (disposed) return;

      const bundle = createScene({
        container,
        cameraPosition: prefsRef.current.camera3d.position,
        cameraTarget: prefsRef.current.camera3d.target,
        showGrid: prefsRef.current.showGrid3d,
      });

      const controls = new OrbitControls(bundle.camera, bundle.renderer.domElement);
      controls.enableDamping = true;
      controls.dampingFactor = 0.08;
      controls.target.set(...prefsRef.current.camera3d.target);
      controls.update();

      // Build the renderable graph from the current snapshot.
      const snap = snapshotRef.current;
      const nodeSystem = new NodeSystem(snap.nodes);
      const splines = new SplineSet(snap.nodes, snap.edges);
      const tubeSystem = new TubeSystem(splines);
      const particleSystem = new ParticleSystem(splines);
      nodeSystem.addTo(bundle.scene);
      tubeSystem.addTo(bundle.scene);
      particleSystem.addTo(bundle.scene);

      // Apply the initial selection — it might have been set in 2D before
      // the user toggled to 3D, so we shouldn't wait for a click.
      nodeSystem.setSelected(selectedRef.current);

      // Post-processing pipeline. Bloom thresholds matched to plan §3.2.6.
      const composer = new composerMod.EffectComposer(bundle.renderer);
      composer.addPass(new renderPassMod.RenderPass(bundle.scene, bundle.camera));
      const bloomPass = new bloomMod.UnrealBloomPass(
        new Vector2(container.clientWidth, container.clientHeight),
        0.7, // strength
        0.4, // radius
        0.6, // threshold
      );
      composer.addPass(bloomPass);
      let bloomEnabled = true;
      const updateBloomEnabled = (on: boolean): void => {
        bloomEnabled = on;
        bloomPass.enabled = on;
      };

      // Honor prefers-reduced-motion for particle drift. Bloom and camera
      // damping stay on — the plan specifically calls out particle motion
      // as the only animation that can be disorienting.
      const reducedMotionMql = window.matchMedia("(prefers-reduced-motion: reduce)");
      let particlesPaused = reducedMotionMql.matches;
      const onMotionPrefChange = (e: MediaQueryListEvent): void => {
        particlesPaused = e.matches;
      };
      reducedMotionMql.addEventListener("change", onMotionPrefChange);

      // Heatmap mode (Slice E1). Off by default; toggle with H. While on,
      // we re-fetch the aggregate every 30s so newly-routed events show
      // up without forcing the user to bounce the view. The window is
      // fixed at 1 hour for v1 — a UI affordance can land later.
      let heatmapOn = false;
      let heatmapTimer: ReturnType<typeof setInterval> | null = null;
      let lastHeatmap: HeatmapResult | null = null;
      const HEATMAP_REFRESH_MS = 30_000;
      const HEATMAP_WINDOW_S = 3600;
      const refreshHeatmap = async (): Promise<void> => {
        if (!heatmapOn) return;
        const result = await fetchHeatmap(HEATMAP_WINDOW_S);
        if (disposed || !heatmapOn) return;
        lastHeatmap = result;
        const map = new Map<string, number>(result.nodes);
        tubeSystem.applyHeatmap(map, result.max_count);
        renderStatus();
      };
      const setHeatmapEnabled = (on: boolean): void => {
        if (heatmapOn === on) return;
        heatmapOn = on;
        if (on) {
          void refreshHeatmap();
          heatmapTimer = setInterval(refreshHeatmap, HEATMAP_REFRESH_MS);
        } else {
          if (heatmapTimer) {
            clearInterval(heatmapTimer);
            heatmapTimer = null;
          }
          lastHeatmap = null;
          tubeSystem.applyHeatmap(null, 0);
          renderStatus();
        }
      };

      // Persist camera changes back to the daemon, but only when the user
      // stops moving — otherwise we'd POST every frame.
      let saveTimer: ReturnType<typeof setTimeout> | null = null;
      const queueCameraSave = (): void => {
        if (saveTimer) clearTimeout(saveTimer);
        saveTimer = setTimeout(() => {
          const pos = bundle.camera.position;
          const tgt = controls.target;
          void patchExplorerPrefs({
            camera3d: {
              position: [pos.x, pos.y, pos.z],
              target: [tgt.x, tgt.y, tgt.z],
            },
          });
        }, 600);
      };
      controls.addEventListener("end", queueCameraSave);

      // Raycaster + a single shared NDC vector → no per-pointer alloc.
      const raycaster = new Raycaster();
      const ndc = new Vector2();
      let lastHoverId: string | null = null;
      let lastHoverAt = 0;
      const HOVER_THROTTLE_MS = 33; // ≈30 Hz, per plan §5.2.

      const updateHover = (clientX: number, clientY: number): void => {
        const rect = container.getBoundingClientRect();
        ndc.x = ((clientX - rect.left) / rect.width) * 2 - 1;
        ndc.y = -((clientY - rect.top) / rect.height) * 2 + 1;
        raycaster.setFromCamera(ndc, bundle.camera);
        const hit = nodeSystem.raycast(raycaster);
        const id = hit ? hit.id : null;
        if (id !== lastHoverId) {
          lastHoverId = id;
          nodeSystem.setHovered(id);
          container.style.cursor = id ? "pointer" : "";
        }
      };

      const onPointerMove = (e: PointerEvent): void => {
        const now = performance.now();
        if (now - lastHoverAt < HOVER_THROTTLE_MS) return;
        lastHoverAt = now;
        updateHover(e.clientX, e.clientY);
      };
      const onPointerLeave = (): void => {
        if (lastHoverId !== null) {
          lastHoverId = null;
          nodeSystem.setHovered(null);
          container.style.cursor = "";
        }
      };
      const onClick = (e: MouseEvent): void => {
        // OrbitControls also handles mousedown for orbit; we only care about
        // a clean left-click that didn't drag. Raycast against the *current*
        // pointer rather than the throttled cache so the click feels honest.
        const rect = container.getBoundingClientRect();
        ndc.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
        ndc.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;
        raycaster.setFromCamera(ndc, bundle.camera);
        const hit = nodeSystem.raycast(raycaster);
        onSelectRef.current?.(hit ? hit.id : null);
      };
      container.addEventListener("pointermove", onPointerMove);
      container.addEventListener("pointerleave", onPointerLeave);
      container.addEventListener("click", onClick);

      // Run the force layout off-thread, then push positions into both
      // systems and frame the camera. Failures are non-fatal — a bare
      // graph at the origin is still better than a crashed canvas.
      const bridge = new LayoutBridge();
      const startedAt = performance.now();
      let framedYet = false;
      let lastPositions: { id: string; x: number; y: number; z: number }[] = [];
      bridge
        .compute(
          snap.nodes.map((n) => ({ id: n.id })),
          snap.edges.map((e) => ({ s: e.s, t: e.t, conf: e.conf })),
        )
        .then((positions) => {
          if (disposed) return;
          lastPositions = positions;
          nodeSystem.applyLayout(positions);
          splines.applyLayout(positions);
          tubeSystem.rebuild();
          if (!framedYet) {
            framedYet = true;
            frameAll(positions, bundle.camera, controls);
            queueCameraSave();
          }
          renderStatus();
        })
        .catch((err: unknown) => {
          if ((err as Error).message === "layout-superseded") return;
          // eslint-disable-next-line no-console
          console.warn("[explorer-3d] layout failed:", err);
        });

      const renderStatus = (): void => {
        if (!statusRef.current) return;
        const ms = Math.round(performance.now() - startedAt);
        const sel = selectedRef.current;
        const bits = [
          `<strong>3D</strong>`,
          `${snap.nodes.length} nodes`,
          `${snap.edges.length} edges`,
          `${particleSystem.metas.length} particles`,
          `layout ${ms} ms`,
          `bloom ${bloomEnabled ? "on" : "off"}`,
          particlesPaused ? "paused" : "playing",
        ];
        if (heatmapOn) {
          bits.push(
            lastHeatmap
              ? `heat ${lastHeatmap.total_events} ev/${Math.round(
                  lastHeatmap.window_seconds / 60,
                )}m`
              : "heat loading",
          );
        }
        if (sel) bits.push(`sel <strong>${sel}</strong>`);
        statusRef.current.innerHTML = bits.join(" · ");
      };

      // Resize observer — keep the renderer + composer in step with the
      // flex/grid container without polling rAF for size deltas.
      const resize = (): void => {
        const w = container.clientWidth;
        const h = container.clientHeight;
        if (w === 0 || h === 0) return;
        bundle.renderer.setSize(w, h, false);
        composer.setSize(w, h);
        bundle.camera.aspect = w / h;
        bundle.camera.updateProjectionMatrix();
      };
      const ro = new ResizeObserver(resize);
      ro.observe(container);

      // Keyboard controls — scoped to window with no-op when typing in an
      // input/textarea so the SearchBar still receives normal characters.
      const onKeyDown = (e: KeyboardEvent): void => {
        const target = e.target as HTMLElement | null;
        if (target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable)) {
          return;
        }
        if (e.key === "b" || e.key === "B") {
          updateBloomEnabled(!bloomEnabled);
          renderStatus();
        } else if (e.code === "Space") {
          particlesPaused = !particlesPaused;
          renderStatus();
          e.preventDefault();
        } else if (e.key === "f" || e.key === "F") {
          if (lastPositions.length > 0) frameAll(lastPositions, bundle.camera, controls);
        } else if (e.key === "h" || e.key === "H") {
          setHeatmapEnabled(!heatmapOn);
        } else if (e.key === "Escape") {
          onSelectRef.current?.(null);
        }
      };
      window.addEventListener("keydown", onKeyDown);

      let lastFrame = performance.now();
      const tick = (): void => {
        if (disposed) return;
        const now = performance.now();
        const dt = Math.min(0.1, (now - lastFrame) / 1000);
        lastFrame = now;
        controls.update();
        // Particles only have something to advance once the layout has
        // populated the splines; before that the curves are placeholders
        // and stepping them just wastes work.
        if (framedYet && !particlesPaused) particleSystem.update(dt, now / 1000);
        composer.render();
        raf = requestAnimationFrame(tick);
      };
      raf = requestAnimationFrame(tick);

      apiRef.current = {
        setSelected(id) {
          nodeSystem.setSelected(id);
          renderStatus();
        },
      };

      cleanup = () => {
        if (saveTimer) clearTimeout(saveTimer);
        if (heatmapTimer) clearInterval(heatmapTimer);
        controls.removeEventListener("end", queueCameraSave);
        controls.dispose();
        ro.disconnect();
        reducedMotionMql.removeEventListener("change", onMotionPrefChange);
        container.removeEventListener("pointermove", onPointerMove);
        container.removeEventListener("pointerleave", onPointerLeave);
        container.removeEventListener("click", onClick);
        window.removeEventListener("keydown", onKeyDown);
        bridge.dispose();
        nodeSystem.dispose();
        tubeSystem.dispose();
        particleSystem.dispose();
        composer.dispose();
        bloomPass.dispose();
        bundle.dispose();
        apiRef.current = null;
      };
    })().catch((err: unknown) => {
      onFatal?.((err as Error).message || "Failed to initialize 3D renderer.");
    });

    return () => {
      disposed = true;
      if (raf) cancelAnimationFrame(raf);
      cleanup?.();
    };
    // Intentionally only depend on mount — prefs and snapshot are read via
    // refs so toggling grid/quality at runtime won't tear the scene down.
    // Slice E will add a snapshot-delta path that re-runs the layout in
    // place and updates the existing systems.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div className="canvas-wrap canvas-3d">
      <div ref={containerRef} className="canvas" />
      <div className="status" ref={statusRef}>
        <strong>3D</strong> · slice D · laying out…
      </div>
    </div>
  );
}

/**
 * Compute a bounding box from positions, then move the camera back so the
 * whole cloud fits in the current FOV with a comfortable margin.
 */
function frameAll(
  positions: readonly { x: number; y: number; z: number }[],
  camera: PerspectiveCamera,
  controls: { target: Vector3; update(): void },
): void {
  if (positions.length === 0) return;
  const box = new Box3();
  const v = new Vector3();
  for (const p of positions) {
    v.set(p.x, p.y, p.z);
    box.expandByPoint(v);
  }
  const center = new Vector3();
  const size = new Vector3();
  box.getCenter(center);
  box.getSize(size);
  const radius = Math.max(size.x, size.y, size.z) * 0.5 || 10;
  const fovRad = (camera.fov * Math.PI) / 180;
  const distance = (radius / Math.tan(fovRad / 2)) * 1.5 + 12;
  const dir = new Vector3(1, 0.6, 1).normalize();
  camera.position.copy(center).add(dir.multiplyScalar(distance));
  controls.target.copy(center);
  camera.lookAt(center);
  controls.update();
}
