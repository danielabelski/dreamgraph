/**
 * Edge tubes — translucent additive-blended pipes along each edge spline.
 *
 * plans/EXPLORER_3D_MODE.md §3.2.2.
 *
 * Implementation notes:
 *   - One TubeGeometry per edge, then merged into a single BufferGeometry
 *     so the whole edge graph draws in one call. Vertex colors carry the
 *     edge-kind tint, scaled by confidence.
 *   - Subdivisions deliberately conservative (8 tubular × 4 radial). The
 *     plan calls for 24×8 at full quality; that's a Slice D auto-quality
 *     concern. At our default 5k-edge target this gives ~320k triangles —
 *     a fraction of typical game-engine budgets.
 *   - Geometry is rebuilt on every `applyLayout`. Layout currently runs
 *     once per snapshot, so this is fine; an in-place vertex update path
 *     can be added when delta updates ship.
 */

import {
  AdditiveBlending,
  BufferAttribute,
  BufferGeometry,
  Color,
  Mesh,
  MeshBasicMaterial,
  TubeGeometry,
  type Scene,
} from "three";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";
import { EDGE_STYLES } from "../theme";
import type { SplineSet } from "./splines";

/** Tubular segments per edge — controls smoothness along the curve. */
const TUBULAR_SEGMENTS = 8;
/** Radial segments per edge — controls perceived roundness in cross-section. */
const RADIAL_SEGMENTS = 4;

export class TubeSystem {
  readonly mesh: Mesh;

  private readonly material: MeshBasicMaterial;
  private geometry: BufferGeometry;
  private readonly splines: SplineSet;

  constructor(splines: SplineSet) {
    this.splines = splines;
    this.material = new MeshBasicMaterial({
      vertexColors: true,
      transparent: true,
      opacity: 0.18,
      blending: AdditiveBlending,
      depthWrite: false,
    });
    // Empty placeholder geometry — first `applyLayout` builds the real one.
    this.geometry = new BufferGeometry();
    this.mesh = new Mesh(this.geometry, this.material);
    this.mesh.frustumCulled = false;
  }

  /**
   * Rebuild the merged tube geometry from the splines' current curves.
   * Caller is expected to have already called `splines.applyLayout(...)`.
   */
  rebuild(): void {
    const parts: BufferGeometry[] = [];
    const tmpColor = new Color();
    for (const meta of this.splines.metas) {
      const curve = this.splines.curves[meta.index];
      const style = EDGE_STYLES[meta.kind];
      // Radius scales with the 2D edge size and confidence so high-trust
      // links read thicker — same intuition as the 2D `EdgeFancyProgram`.
      const radius = 0.04 + style.size * 0.04 + meta.conf * 0.05;
      const tube = new TubeGeometry(
        curve,
        TUBULAR_SEGMENTS,
        radius,
        RADIAL_SEGMENTS,
        false,
      );
      // Per-vertex color from edge kind. Slight low-conf desaturation.
      tmpColor.set(style.color);
      const intensity = 0.4 + 0.6 * meta.conf;
      const vCount = tube.getAttribute("position").count;
      const colors = new Float32Array(vCount * 3);
      for (let v = 0; v < vCount; v++) {
        colors[v * 3 + 0] = tmpColor.r * intensity;
        colors[v * 3 + 1] = tmpColor.g * intensity;
        colors[v * 3 + 2] = tmpColor.b * intensity;
      }
      tube.setAttribute("color", new BufferAttribute(colors, 3));
      parts.push(tube);
    }

    // Free the previous geometry before swapping to avoid a per-snapshot
    // GPU memory leak.
    this.geometry.dispose();
    if (parts.length === 0) {
      this.geometry = new BufferGeometry();
    } else {
      // mergeGeometries returns null if attributes don't line up; here all
      // sources come from TubeGeometry with identical attribute layouts so
      // a non-null result is guaranteed in practice.
      const merged = mergeGeometries(parts, false);
      this.geometry = merged ?? new BufferGeometry();
      // Per-edge geometries are no longer needed once merged.
      for (const p of parts) p.dispose();
    }
    this.mesh.geometry = this.geometry;
  }

  addTo(scene: Scene): void {
    scene.add(this.mesh);
  }

  dispose(): void {
    this.mesh.parent?.remove(this.mesh);
    this.geometry.dispose();
    this.material.dispose();
  }
}
