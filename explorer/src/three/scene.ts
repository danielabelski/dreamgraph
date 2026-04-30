/**
 * Three.js scene primitives shared by the 3D Explorer.
 *
 * Slice A scope (plans/EXPLORER_3D_MODE.md §12.A): just enough to mount
 * a working WebGL2 scene with orbit camera, fog, and a faint reference
 * grid. NodeSystem / TubeSystem / ParticleSystem land in slices B and C.
 *
 * Everything here is renderer-agnostic of React; Graph3DCanvas wires
 * lifecycle (mount, resize, dispose) on top.
 */

import {
  AmbientLight,
  Color,
  Fog,
  GridHelper,
  PerspectiveCamera,
  PointLight,
  Scene,
  WebGLRenderer,
} from "three";

/** Background colour — matches the 2D canvas-wrap radial-gradient floor. */
export const BG_COLOR = new Color("#06080d");

/**
 * Detect WebGL2 support without leaking a context. Used by the toggle to
 * disable the "3D" button on machines that can't run the renderer.
 */
export function hasWebGL2(): boolean {
  try {
    const canvas = document.createElement("canvas");
    return !!canvas.getContext("webgl2");
  } catch {
    return false;
  }
}

export interface SceneBundle {
  scene: Scene;
  camera: PerspectiveCamera;
  renderer: WebGLRenderer;
  /** Reference grid on the y=0 plane; toggled by prefs.showGrid3d. */
  grid: GridHelper;
  /** Free function — caller must invoke to release GPU + DOM resources. */
  dispose(): void;
}

export interface CreateSceneOpts {
  container: HTMLElement;
  cameraPosition: [number, number, number];
  cameraTarget: [number, number, number];
  showGrid: boolean;
}

/**
 * Build the scene + camera + renderer trio and attach the canvas to the
 * given container. Caller owns lifecycle.
 *
 * Notes on the choices below:
 *   - `antialias: true` — small node count vs. 2D, MSAA is affordable.
 *   - `powerPreference: "high-performance"` — request the dGPU on hybrid
 *     laptops; the user is here for graph viz, not battery life.
 *   - DPR clamped to 2 — 4K screens with 200% scaling were melting fans.
 *   - Linear fog 30→120 — gives depth cues without hiding distant nodes.
 */
export function createScene(opts: CreateSceneOpts): SceneBundle {
  const { container, cameraPosition, cameraTarget, showGrid } = opts;

  const scene = new Scene();
  scene.background = BG_COLOR;
  scene.fog = new Fog(BG_COLOR, 30, 120);

  const camera = new PerspectiveCamera(
    55,
    Math.max(1, container.clientWidth) / Math.max(1, container.clientHeight),
    0.1,
    500,
  );
  camera.position.set(...cameraPosition);
  camera.lookAt(...cameraTarget);

  const renderer = new WebGLRenderer({
    antialias: true,
    alpha: false,
    powerPreference: "high-performance",
  });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.setSize(container.clientWidth, container.clientHeight, false);
  renderer.domElement.style.position = "absolute";
  renderer.domElement.style.inset = "0";
  renderer.domElement.style.width = "100%";
  renderer.domElement.style.height = "100%";
  container.appendChild(renderer.domElement);

  // Lighting is intentionally subtle — the Slice B/C node + edge shaders
  // are emissive and rely on bloom rather than physical lighting.
  const ambient = new AmbientLight(0x6677aa, 0.55);
  scene.add(ambient);
  const point = new PointLight(0xffffff, 0.6, 200, 2);
  point.position.set(20, 30, 20);
  scene.add(point);

  const grid = new GridHelper(80, 40, 0x1a2230, 0x10161e);
  grid.position.y = -8;
  grid.visible = showGrid;
  scene.add(grid);

  function dispose(): void {
    scene.remove(grid);
    grid.geometry.dispose();
    if (Array.isArray(grid.material)) {
      grid.material.forEach((m) => m.dispose());
    } else {
      grid.material.dispose();
    }
    renderer.dispose();
    if (renderer.domElement.parentElement === container) {
      container.removeChild(renderer.domElement);
    }
  }

  return { scene, camera, renderer, grid, dispose };
}
