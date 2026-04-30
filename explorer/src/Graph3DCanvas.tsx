/**
 * DreamGraph Explorer — 3D canvas (Slice B: static graph rendering).
 *
 * plans/EXPLORER_3D_MODE.md §12.B
 *
 * Slice A shipped the empty scene + camera + toggle. Slice B adds:
 *   - layout via d3-force-3d running in a Web Worker
 *   - NodeSystem (instanced spheres) + EdgeSystem (line segments)
 *   - snapshot prop wiring + camera-frame on first layout
 *
 * Out of scope here: tubes (Slice C — they share the spline plumbing
 * with particles), particles, hover/select rim shaders, bloom.
 */

import { useEffect, useRef } from "react";
import { Box3, Vector3, type PerspectiveCamera } from "three";
import {
  patchExplorerPrefs,
  type ExplorerPrefs,
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
  /** Surface a fatal init error to the parent so it can fall back to 2D. */
  onFatal?: (message: string) => void;
}

export default function Graph3DCanvas({ prefs, snapshot, onFatal }: Graph3DCanvasProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  // Latest values in refs so the long-lived effect can read them without
  // tearing down the scene on every prop change.
  const prefsRef = useRef(prefs);
  prefsRef.current = prefs;
  const snapshotRef = useRef(snapshot);
  snapshotRef.current = snapshot;
  const statusRef = useRef<HTMLDivElement | null>(null);

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
      const { OrbitControls } = (await import(
        "three/examples/jsm/controls/OrbitControls.js"
      )) as typeof import("three/examples/jsm/controls/OrbitControls.js");

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

      // Run the force layout off-thread, then push positions into both
      // systems and frame the camera. Failures are non-fatal — a bare
      // graph at the origin is still better than a crashed canvas.
      const bridge = new LayoutBridge();
      const startedAt = performance.now();
      let framedYet = false;
      bridge
        .compute(
          snap.nodes.map((n) => ({ id: n.id })),
          snap.edges.map((e) => ({ s: e.s, t: e.t, conf: e.conf })),
        )
        .then((positions) => {
          if (disposed) return;
          nodeSystem.applyLayout(positions);
          splines.applyLayout(positions);
          tubeSystem.rebuild();
          if (!framedYet) {
            framedYet = true;
            frameAll(positions, bundle.camera, controls);
            queueCameraSave();
          }
          if (statusRef.current) {
            const ms = Math.round(performance.now() - startedAt);
            statusRef.current.innerHTML =
              `<strong>3D</strong> · ${snap.nodes.length} nodes · ` +
              `${snap.edges.length} edges · ${particleSystem.metas.length} particles · ` +
              `layout ${ms} ms`;
          }
        })
        .catch((err: unknown) => {
          if ((err as Error).message === "layout-superseded") return;
          // eslint-disable-next-line no-console
          console.warn("[explorer-3d] layout failed:", err);
        });

      // Resize observer — keep the renderer in step with the flex/grid
      // container without polling rAF for size deltas.
      const resize = () => {
        const w = container.clientWidth;
        const h = container.clientHeight;
        if (w === 0 || h === 0) return;
        bundle.renderer.setSize(w, h, false);
        bundle.camera.aspect = w / h;
        bundle.camera.updateProjectionMatrix();
      };
      const ro = new ResizeObserver(resize);
      ro.observe(container);

      let lastFrame = performance.now();
      const tick = () => {
        if (disposed) return;
        const now = performance.now();
        const dt = Math.min(0.1, (now - lastFrame) / 1000);
        lastFrame = now;
        controls.update();
        // Particles only have something to advance once the layout has
        // populated the splines; before that the curves are placeholders
        // and stepping them just wastes work.
        if (framedYet) particleSystem.update(dt, now / 1000);
        bundle.renderer.render(bundle.scene, bundle.camera);
        raf = requestAnimationFrame(tick);
      };
      raf = requestAnimationFrame(tick);

      cleanup = () => {
        if (saveTimer) clearTimeout(saveTimer);
        controls.removeEventListener("end", queueCameraSave);
        controls.dispose();
        ro.disconnect();
        bridge.dispose();
        nodeSystem.dispose();
        tubeSystem.dispose();
        particleSystem.dispose();
        bundle.dispose();
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
    // Slice C will add a snapshot-delta path that re-runs the layout in
    // place and updates the existing systems.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div className="canvas-wrap canvas-3d">
      <div ref={containerRef} className="canvas" />
      <div className="status" ref={statusRef}>
        <strong>3D</strong> · slice C · laying out…
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
