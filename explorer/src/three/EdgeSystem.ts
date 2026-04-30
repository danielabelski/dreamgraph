/**
 * Edge renderer — one merged `LineSegments` for every edge, vertex-coloured
 * by edge kind, opacity by confidence.
 *
 * plans/EXPLORER_3D_MODE.md §3.2.2 specifies translucent *tubes* with a
 * fresnel shader so that Slice C can spawn light particles travelling along
 * the spline. We are intentionally landing the simpler line-segment form in
 * Slice B because:
 *
 *   - Tube + particle work share the same Catmull-Rom spline plumbing;
 *     building tubes once, before the spline is needed by particles, would
 *     mean throwing it away in Slice C anyway.
 *   - Lines + bloom already read as glowing pipes for the alpha demo, so
 *     this lets us ship the static graph and validate the layout/picking
 *     loop without blocking on shader work.
 *
 * Slice C will replace this class with `TubeSystem` (same external API).
 * Until then `EdgeSystem` keeps the integration surface identical to what
 * the tube version will offer: `applyLayout` + `addTo` + `dispose`.
 */

import {
  AdditiveBlending,
  BufferAttribute,
  BufferGeometry,
  Color,
  LineBasicMaterial,
  LineSegments,
  type Scene,
} from "three";
import { EDGE_STYLES } from "../theme";
import type { ExplorerEdge, ExplorerNode } from "../types";

export interface EdgeInstanceMeta {
  s: string;
  t: string;
  kind: ExplorerEdge["kind"];
  conf: number;
  /** Index of the source vertex in the position attribute (target = +1). */
  vertexIndex: number;
}

export class EdgeSystem {
  readonly object: LineSegments;
  readonly metas: EdgeInstanceMeta[];

  private readonly geometry: BufferGeometry;
  private readonly material: LineBasicMaterial;
  private readonly positions: Float32Array;
  private readonly nodeMetas: Map<string, { x: number; y: number; z: number }>;

  constructor(nodes: readonly ExplorerNode[], edges: readonly ExplorerEdge[]) {
    // Build once: vertex colors are static per edge (kind + confidence),
    // positions update on every layout tick.
    const nodeIds = new Set(nodes.map((n) => n.id));
    const visibleEdges = edges.filter((e) => nodeIds.has(e.s) && nodeIds.has(e.t));

    const vertexCount = visibleEdges.length * 2;
    this.positions = new Float32Array(vertexCount * 3);
    const colors = new Float32Array(vertexCount * 3);

    this.metas = new Array(visibleEdges.length);
    this.nodeMetas = new Map();

    const tmp = new Color();
    for (let i = 0; i < visibleEdges.length; i++) {
      const e = visibleEdges[i];
      const style = EDGE_STYLES[e.kind];
      tmp.set(style.color);
      // Linear-space tilt: low-conf edges read dimmer than high-conf ones.
      const t = 0.35 + 0.65 * e.conf;
      const v = i * 2;
      colors[(v + 0) * 3 + 0] = tmp.r * t;
      colors[(v + 0) * 3 + 1] = tmp.g * t;
      colors[(v + 0) * 3 + 2] = tmp.b * t;
      colors[(v + 1) * 3 + 0] = tmp.r * t;
      colors[(v + 1) * 3 + 1] = tmp.g * t;
      colors[(v + 1) * 3 + 2] = tmp.b * t;
      this.metas[i] = {
        s: e.s,
        t: e.t,
        kind: e.kind,
        conf: e.conf,
        vertexIndex: v,
      };
    }

    this.geometry = new BufferGeometry();
    this.geometry.setAttribute(
      "position",
      new BufferAttribute(this.positions, 3),
    );
    this.geometry.setAttribute("color", new BufferAttribute(colors, 3));

    this.material = new LineBasicMaterial({
      vertexColors: true,
      transparent: true,
      opacity: 0.55,
      // Additive blending makes edge crossings glow — the right vibe for
      // the spectacle mode and the cheapest stand-in for tube fresnel.
      blending: AdditiveBlending,
      depthWrite: false,
    });

    this.object = new LineSegments(this.geometry, this.material);
    this.object.frustumCulled = false;
  }

  /**
   * Update line endpoints after a layout pass. Caller is expected to have
   * already updated the NodeSystem (so endpoints land where the spheres do).
   */
  applyLayout(positions: readonly { id: string; x: number; y: number; z: number }[]): void {
    // Index positions by id once so the per-edge loop below is O(E).
    this.nodeMetas.clear();
    for (const p of positions) {
      this.nodeMetas.set(p.id, { x: p.x, y: p.y, z: p.z });
    }
    for (const meta of this.metas) {
      const a = this.nodeMetas.get(meta.s);
      const b = this.nodeMetas.get(meta.t);
      if (!a || !b) continue;
      const v = meta.vertexIndex * 3;
      this.positions[v + 0] = a.x;
      this.positions[v + 1] = a.y;
      this.positions[v + 2] = a.z;
      this.positions[v + 3] = b.x;
      this.positions[v + 4] = b.y;
      this.positions[v + 5] = b.z;
    }
    const attr = this.geometry.getAttribute("position") as BufferAttribute;
    attr.needsUpdate = true;
    this.geometry.computeBoundingSphere();
  }

  addTo(scene: Scene): void {
    scene.add(this.object);
  }

  dispose(): void {
    this.object.parent?.remove(this.object);
    this.geometry.dispose();
    this.material.dispose();
  }
}
