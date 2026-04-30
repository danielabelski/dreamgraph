/**
 * Edge spline plumbing shared by `TubeSystem` and `ParticleSystem`.
 *
 * Every directional edge is rendered as a Catmull-Rom curve from
 * source → mid-control-point → target. The mid control point is offset
 * perpendicular to the edge direction by a deterministic per-edge amount.
 * That keeps:
 *   - parallel edges between the same node pair from z-fighting;
 *   - the layout stable — re-running for the same edge id yields the same
 *     curve, so animations don't pop when a snapshot updates in place.
 *
 * plans/EXPLORER_3D_MODE.md §3.2.2.
 */

import { CatmullRomCurve3, Vector3 } from "three";
import type { ExplorerEdge, ExplorerNode } from "../types";

export interface SplineEdgeMeta {
  s: string;
  t: string;
  kind: ExplorerEdge["kind"];
  conf: number;
  /** Index of this edge within `splines.curves`. */
  index: number;
}

/**
 * Cheap deterministic FNV-1a → unit float in (-1, 1). Used to seed the
 * mid-control-point offset; quality is irrelevant beyond "stable per id".
 */
function hashUnit(str: string): number {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return ((h / 0xffffffff) - 0.5) * 2;
}

/** Magnitude of the perpendicular offset, in world units. */
const MID_OFFSET_SCALE = 1.4;

export class SplineSet {
  readonly curves: CatmullRomCurve3[] = [];
  readonly metas: SplineEdgeMeta[] = [];
  private readonly nodePos = new Map<string, Vector3>();
  private readonly visibleEdges: ExplorerEdge[];

  constructor(nodes: readonly ExplorerNode[], edges: readonly ExplorerEdge[]) {
    const ids = new Set(nodes.map((n) => n.id));
    this.visibleEdges = edges.filter((e) => ids.has(e.s) && ids.has(e.t));
    for (let i = 0; i < this.visibleEdges.length; i++) {
      const e = this.visibleEdges[i];
      this.metas.push({
        s: e.s,
        t: e.t,
        kind: e.kind,
        conf: e.conf,
        index: i,
      });
      // Placeholder curve until the first applyLayout call. Three.js needs
      // *some* points to construct, so seed a unit segment along +X.
      this.curves.push(
        new CatmullRomCurve3([
          new Vector3(0, 0, 0),
          new Vector3(0.5, 0, 0),
          new Vector3(1, 0, 0),
        ]),
      );
    }
  }

  /** Recompute every curve from the latest layout positions. */
  applyLayout(positions: readonly { id: string; x: number; y: number; z: number }[]): void {
    this.nodePos.clear();
    for (const p of positions) {
      this.nodePos.set(p.id, new Vector3(p.x, p.y, p.z));
    }
    // Reusable scratch vectors keep the per-edge cost allocation-free.
    const dir = new Vector3();
    const up = new Vector3(0, 1, 0);
    const perp = new Vector3();
    for (let i = 0; i < this.metas.length; i++) {
      const meta = this.metas[i];
      const a = this.nodePos.get(meta.s);
      const b = this.nodePos.get(meta.t);
      if (!a || !b) continue;
      const mid = a.clone().add(b).multiplyScalar(0.5);
      dir.copy(b).sub(a);
      const length = dir.length() || 1;
      dir.normalize();
      // Perpendicular offset — choose an "up" reference that isn't
      // parallel to the direction, then cross to get a stable perp.
      if (Math.abs(dir.dot(up)) > 0.95) {
        perp.set(1, 0, 0).cross(dir).normalize();
      } else {
        perp.copy(up).cross(dir).normalize();
      }
      // Two independent hash samples → out-of-plane bow.
      const h1 = hashUnit(meta.s + "→" + meta.t + ":" + meta.kind + ":a");
      const h2 = hashUnit(meta.s + "→" + meta.t + ":" + meta.kind + ":b");
      const offset = MID_OFFSET_SCALE * Math.min(0.6, length * 0.15);
      mid.addScaledVector(perp, h1 * offset);
      // Small extra y-bow so edges don't all lie in the same plane.
      mid.y += h2 * offset * 0.5;
      const curve = this.curves[i];
      curve.points[0].copy(a);
      curve.points[1].copy(mid);
      curve.points[2].copy(b);
      // Catmull-Rom caches arc-length on first sample — invalidate so
      // the new geometry samples uniformly along the new path.
      curve.updateArcLengths();
    }
  }
}
