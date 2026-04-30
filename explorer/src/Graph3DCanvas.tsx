/**
 * DreamGraph Explorer — 3D canvas (Slice A skeleton).
 *
 * plans/EXPLORER_3D_MODE.md §12.A
 *
 * Scope for this slice: mount a working WebGL2 scene with orbit camera,
 * fog, and a faint reference grid. No nodes, no edges, no particles —
 * those land in slices B and C. The deliverable is "the toggle works,
 * 2D still works, and switching back and forth doesn't leak GPU memory."
 *
 * Code is split: pure Three.js plumbing lives in `./three/scene.ts`,
 * React only owns lifecycle (mount, resize, dispose, camera persistence).
 */

import { useEffect, useRef } from "react";
import {
  patchExplorerPrefs,
  type ExplorerPrefs,
} from "./api";
import { createScene, hasWebGL2 } from "./three/scene";

interface Graph3DCanvasProps {
  prefs: ExplorerPrefs;
  /** Surface a fatal init error to the parent so it can fall back to 2D. */
  onFatal?: (message: string) => void;
}

/**
 * Three.js canvas. Uses dynamic import for OrbitControls so the lazy
 * boundary in App.tsx still pays off — pulling controls statically here
 * would defeat code splitting on the orbit-controls subtree.
 */
export default function Graph3DCanvas({ prefs, onFatal }: Graph3DCanvasProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  // Latest prefs in a ref so the camera-persistence callback always sees
  // the current values without re-creating the scene on every prefs change.
  const prefsRef = useRef(prefs);
  prefsRef.current = prefs;

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

    // Async wrapper so we can `await import(...)` without blocking the
    // initial mount. Three.js itself is already a static import via
    // ./three/scene, but OrbitControls lives in the examples subtree.
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

      // Persist camera changes back to the daemon, but only when the user
      // stops moving — otherwise we'd POST every frame.
      let saveTimer: ReturnType<typeof setTimeout> | null = null;
      const queueCameraSave = () => {
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

      const tick = () => {
        if (disposed) return;
        controls.update();
        bundle.renderer.render(bundle.scene, bundle.camera);
        raf = requestAnimationFrame(tick);
      };
      raf = requestAnimationFrame(tick);

      cleanup = () => {
        if (saveTimer) clearTimeout(saveTimer);
        controls.removeEventListener("end", queueCameraSave);
        controls.dispose();
        ro.disconnect();
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
    // Intentionally only depend on mount — prefs are read via prefsRef so
    // toggling grid/quality at runtime won't tear the scene down. Slice D
    // will add explicit prop-driven updates.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div className="canvas-wrap canvas-3d">
      <div ref={containerRef} className="canvas" />
      <div className="status">
        <strong>3D</strong> · slice A · empty scene
      </div>
    </div>
  );
}
