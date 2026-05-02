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
  ACESFilmicToneMapping,
  AmbientLight,
  Color,
  DirectionalLight,
  Fog,
  GridHelper,
  HemisphereLight,
  PerspectiveCamera,
  Scene,
  SRGBColorSpace,
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
  // Fog defaults are tuned for the force layout (~30 unit radius). The
  // radial layout produces a much larger cloud, so callers should drive
  // fog via `tuneSceneForBounds` once the layout settles.
  scene.fog = new Fog(BG_COLOR, 30, 120);

  const camera = new PerspectiveCamera(
    55,
    Math.max(1, container.clientWidth) / Math.max(1, container.clientHeight),
    0.1,
    4000,
  );
  camera.position.set(...cameraPosition);
  camera.lookAt(...cameraTarget);

  const renderer = new WebGLRenderer({
    antialias: true,
    alpha: false,
    powerPreference: "high-performance",
    // Required so the screenshot capture path can read the framebuffer
    // back via `toBlob()` after the next present — without this the
    // buffer is cleared and the saved PNG comes out fully transparent.
    preserveDrawingBuffer: true,
  });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  // ACES filmic tone mapping compresses extreme peaks instead of clipping
  // them to flat white, so dense hubs of overlapping additive tubes
  // retain colour and shape rather than blowing out. Phase 8 lifted
  // exposure 0.95 → 1.10 to restore midtone luminance after the AA /
  // MSAA chain darkened the resolved buffer (multisample resolve plus
  // sRGB conversion was crushing midtones into the toe of the curve).
  // ACES still protects the highlights at this exposure so dense hubs
  // don't blow out. sRGB output ensures the post-tonemap framebuffer is
  // encoded correctly for the browser surface.
  renderer.toneMapping = ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.10;
  renderer.outputColorSpace = SRGBColorSpace;
  renderer.setSize(container.clientWidth, container.clientHeight, false);
  renderer.domElement.style.position = "absolute";
  renderer.domElement.style.inset = "0";
  renderer.domElement.style.width = "100%";
  renderer.domElement.style.height = "100%";
  container.appendChild(renderer.domElement);

  // Lighting (Slice F2): use distance-independent lights so nodes read
  // as 3D objects no matter how spread out the layout is. Phase 8 lifted
  // hemisphere + ambient slightly so geometry in dark zones (away from
  // the key light) doesn't sink into the background. Key/fill ratios
  // unchanged so highlight modelling stays the same.
  const hemi = new HemisphereLight(0x9bb6e0, 0x1a1f2c, 0.72);
  scene.add(hemi);
  const key = new DirectionalLight(0xffffff, 0.95);
  key.position.set(1, 1.4, 0.7);
  scene.add(key);
  const fill = new DirectionalLight(0x88a4d4, 0.45);
  fill.position.set(-0.8, 0.4, -0.6);
  scene.add(fill);
  const ambient = new AmbientLight(0x3a4458, 0.38);
  scene.add(ambient);

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

/**
 * Re-tune fog and camera far plane so the cloud is fully visible.
 *
 * Called from `Graph3DCanvas` once the layout finishes — the radial
 * mode's sprawl can be 3–5× the force mode's, and a fixed `30→120`
 * fog window blacks out the entire scene.
 *
 * `radius` is the half-extent of the bounding box (max axis ÷ 2).
 */
export function tuneSceneForBounds(
  scene: Scene,
  camera: PerspectiveCamera,
  radius: number,
): void {
  // Keep a sensible floor so a tiny graph doesn't get a paper-thin fog.
  const r = Math.max(20, radius);
  // Tighten the fog window so distant nodes blend softly toward the
  // background instead of staying crisp out to the far plane. Starting
  // around the equator of the cloud and ending just past the far rim
  // gives a subtle "depth fade" without hiding nodes the camera is
  // actually pointed at.
  if (scene.fog && "near" in scene.fog && "far" in scene.fog) {
    (scene.fog as Fog).near = r * 1.1;
    (scene.fog as Fog).far = r * 3.4;
  }
  // Far plane needs to clear the camera dolly-back distance with margin.
  const desiredFar = Math.max(500, r * 12);
  if (camera.far !== desiredFar) {
    camera.far = desiredFar;
    camera.updateProjectionMatrix();
  }
}
