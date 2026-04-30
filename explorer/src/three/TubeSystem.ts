/**
 * Edge tubes — translucent additive-blended pipes along each edge spline.
 *
 * plans/EXPLORER_3D_MODE.md §3.2.2 + §12.E (heatmap).
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
 *   - Heatmap mode (Slice E1) recolors the existing color attribute in
 *     place — no geometry rebuild — using a per-edge heat value derived
 *     from `event_log.json`.
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

/** Warm tint mixed in for hot edges. Roughly amber/orange. */
const HEAT_COLOR = new Color(1.0, 0.55, 0.15);
/** How much extra brightness a fully-hot edge gets (1 + this). */
const HEAT_BRIGHTNESS = 1.2;

interface EdgeColorRange {
  /** Vertex offset of this edge in the merged color attribute. */
  start: number;
  /** Vertex count for this edge. */
  count: number;
  /** Base RGB (per-edge kind × confidence) — never mutated after build. */
  baseR: number;
  baseG: number;
  baseB: number;
}

export class TubeSystem {
  readonly mesh: Mesh;

  private readonly material: MeshBasicMaterial;
  private geometry: BufferGeometry;
  private readonly splines: SplineSet;
  private edgeRanges: EdgeColorRange[] = [];

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
    const ranges: EdgeColorRange[] = [];
    let cursor = 0;
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
      const baseR = tmpColor.r * intensity;
      const baseG = tmpColor.g * intensity;
      const baseB = tmpColor.b * intensity;
      const vCount = tube.getAttribute("position").count;
      const colors = new Float32Array(vCount * 3);
      for (let v = 0; v < vCount; v++) {
        colors[v * 3 + 0] = baseR;
        colors[v * 3 + 1] = baseG;
        colors[v * 3 + 2] = baseB;
      }
      tube.setAttribute("color", new BufferAttribute(colors, 3));
      parts.push(tube);
      ranges.push({ start: cursor, count: vCount, baseR, baseG, baseB });
      cursor += vCount;
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
    this.edgeRanges = ranges;
  }

  /** Vertex offsets for each edge, exposed for tests + heatmap callers. */
  getEdgeRanges(): readonly EdgeColorRange[] {
    return this.edgeRanges;
  }

  /**
   * Recolor tubes by per-node heat. Pass `null` (or a 0 maxCount) to
   * restore base colors. Edge heat is `max(node_heat[s], node_heat[t]) /
   * max_count`, so the brightest edges are those touching the most-active
   * nodes.
   */
  applyHeatmap(nodeHeat: Map<string, number> | null, maxCount: number): void {
    const colorAttr = this.geometry.getAttribute("color");
    if (!colorAttr) return;
    const arr = colorAttr.array as Float32Array;
    const denom = maxCount > 0 ? maxCount : 1;
    const ranges = this.edgeRanges;
    const metas = this.splines.metas;
    const useHeat = nodeHeat !== null && maxCount > 0;
    for (let i = 0; i < ranges.length; i++) {
      const r = ranges[i];
      let rOut = r.baseR;
      let gOut = r.baseG;
      let bOut = r.baseB;
      if (useHeat) {
        const meta = metas[i];
        const hs = nodeHeat!.get(meta.s) ?? 0;
        const ht = nodeHeat!.get(meta.t) ?? 0;
        const heat = Math.max(0, Math.min(1, Math.max(hs, ht) / denom));
        if (heat > 0) {
          // Lerp toward the warm tint, then bump overall intensity.
          const k = heat;
          const boost = 1 + heat * HEAT_BRIGHTNESS;
          rOut = (r.baseR * (1 - k) + HEAT_COLOR.r * k) * boost;
          gOut = (r.baseG * (1 - k) + HEAT_COLOR.g * k) * boost;
          bOut = (r.baseB * (1 - k) + HEAT_COLOR.b * k) * boost;
        }
      }
      const end = r.start + r.count;
      for (let v = r.start; v < end; v++) {
        arr[v * 3 + 0] = rOut;
        arr[v * 3 + 1] = gOut;
        arr[v * 3 + 2] = bOut;
      }
    }
    (colorAttr as BufferAttribute).needsUpdate = true;
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
