/**
 * Node renderer — one `InstancedMesh` per `ExplorerNodeType` bucket so each
 * type can use a distinct geometry (per plans/EXPLORER_3D_MODE.md §3.2.1).
 *
 * Slice B used a single icosahedron for everything; Slice D promotes shape
 * to a primary visual cue alongside color, which buys a second redundant
 * channel for color-blind viewers and makes node types legible at a glance.
 *
 * Hover/select handling is local to this system — callers just push the
 * current ids in. Highlighting is implemented by:
 *   - boosting the per-instance color (multiplier on the kind base color);
 *   - scaling the instance up slightly so it pops under bloom.
 *
 * That avoids a custom shader (kept for a possible Slice E rim pass) while
 * still reading clearly under the bloom we add in this same slice.
 */

import {
  BoxGeometry,
  Color,
  ConeGeometry,
  CylinderGeometry,
  DodecahedronGeometry,
  InstancedMesh,
  type BufferGeometry,
  MeshStandardMaterial,
  Object3D,
  OctahedronGeometry,
  Raycaster,
  type Scene,
  TetrahedronGeometry,
  TorusGeometry,
} from "three";
import { nodeRenderColor } from "../theme";
import type { ExplorerNode, ExplorerNodeType } from "../types";

export interface NodeInstanceMeta {
  id: string;
  type: ExplorerNodeType;
  /** Index into the bucket's InstancedMesh. */
  index: number;
  x: number;
  y: number;
  z: number;
  radius: number;
  /** Cached base color so highlight can be applied/cleared without lookups. */
  baseColor: Color;
}

interface Bucket {
  type: ExplorerNodeType;
  mesh: InstancedMesh;
  geometry: BufferGeometry;
  material: MeshStandardMaterial;
  metas: NodeInstanceMeta[];
}

/** Multiplier applied to the base color when a node is hovered or selected. */
const HIGHLIGHT_TINT = 1.7;
/** Scale multiplier applied to a hovered/selected instance. */
const SELECT_SCALE = 1.25;
const HOVER_SCALE = 1.12;

/**
 * Build the geometry for a given node type. Geometries are sized to a
 * "unit" radius (≈1 world-unit bounding sphere) so the per-instance scale
 * matrix is the only thing controlling final visual size.
 */
function geometryForType(type: ExplorerNodeType): BufferGeometry {
  switch (type) {
    case "feature":
      // Lightly chamfered cube — three.js BoxGeometry has flat faces, so
      // subdivide it once with `widthSegments` to pick up better lighting.
      return new BoxGeometry(1.4, 1.4, 1.4, 1, 1, 1);
    case "workflow":
      return new ConeGeometry(1.0, 1.8, 6);
    case "data_model":
      return new DodecahedronGeometry(1.0, 0);
    case "capability":
      return new TorusGeometry(0.85, 0.32, 8, 18);
    case "datastore":
      return new CylinderGeometry(1.0, 1.0, 0.55, 16);
    case "dream_node":
      return new TetrahedronGeometry(1.2, 0);
    case "tension":
      return new OctahedronGeometry(1.0, 0);
  }
}

export class NodeSystem {
  /** Flat list of every meta across all buckets — order is bucket-then-index. */
  readonly metas: NodeInstanceMeta[] = [];
  private readonly buckets = new Map<ExplorerNodeType, Bucket>();
  /** Lookup from node id → its meta (constant time). */
  private readonly indexById = new Map<string, NodeInstanceMeta>();
  /** Re-used to avoid allocating a fresh Object3D every matrix update. */
  private readonly proxy = new Object3D();
  private readonly tmpColor = new Color();
  /** Currently hovered / selected ids — used to suppress duplicate writes. */
  private hoveredId: string | null = null;
  private selectedId: string | null = null;

  constructor(nodes: readonly ExplorerNode[]) {
    // Group nodes by type so each bucket can size its InstancedMesh exactly.
    const byType = new Map<ExplorerNodeType, ExplorerNode[]>();
    for (const n of nodes) {
      const arr = byType.get(n.type);
      if (arr) arr.push(n);
      else byType.set(n.type, [n]);
    }

    for (const [type, group] of byType) {
      const geometry = geometryForType(type);
      const material = new MeshStandardMaterial({
        roughness: 0.45,
        metalness: 0.15,
        flatShading: true,
      });
      const mesh = new InstancedMesh(geometry, material, group.length);
      mesh.frustumCulled = false;
      // Userdata lets the raycast loop map a hit back to a node id without
      // reverse-searching every meta list.
      mesh.userData["nodeBucketType"] = type;

      const metas: NodeInstanceMeta[] = [];
      for (let i = 0; i < group.length; i++) {
        const n = group[i];
        const radius = nodeRadius(n);
        const baseColor = new Color(nodeRenderColor(n.type, n.health));
        const meta: NodeInstanceMeta = {
          id: n.id,
          type: n.type,
          index: i,
          x: 0,
          y: 0,
          z: 0,
          radius,
          baseColor,
        };
        metas.push(meta);
        this.metas.push(meta);
        this.indexById.set(n.id, meta);

        mesh.setColorAt(i, baseColor);
        this.proxy.position.set(0, 0, 0);
        this.proxy.scale.setScalar(radius);
        this.proxy.updateMatrix();
        mesh.setMatrixAt(i, this.proxy.matrix);
      }
      mesh.instanceMatrix.needsUpdate = true;
      if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;

      this.buckets.set(type, { type, mesh, geometry, material, metas });
    }
  }

  applyLayout(positions: readonly { id: string; x: number; y: number; z: number }[]): void {
    for (const p of positions) {
      const meta = this.indexById.get(p.id);
      if (!meta) continue;
      meta.x = p.x;
      meta.y = p.y;
      meta.z = p.z;
      this.writeInstance(meta);
    }
    for (const bucket of this.buckets.values()) {
      bucket.mesh.instanceMatrix.needsUpdate = true;
    }
  }

  setHovered(id: string | null): void {
    if (id === this.hoveredId) return;
    const prev = this.hoveredId;
    this.hoveredId = id;
    if (prev) this.refreshAppearance(prev);
    if (id) this.refreshAppearance(id);
  }

  setSelected(id: string | null): void {
    if (id === this.selectedId) return;
    const prev = this.selectedId;
    this.selectedId = id;
    if (prev) this.refreshAppearance(prev);
    if (id) this.refreshAppearance(id);
  }

  /** World position of a node, used by Graph3DCanvas to focus the camera. */
  getPosition(id: string): { x: number; y: number; z: number } | null {
    const meta = this.indexById.get(id);
    if (!meta) return null;
    return { x: meta.x, y: meta.y, z: meta.z };
  }

  /**
   * Raycast every bucket and return the closest hit's node id, or null.
   *
   * Three.js raycasts InstancedMesh natively — the hit's `instanceId` plus
   * the bucket's metas list gets us back to the source node id.
   */
  raycast(ray: Raycaster): { id: string; distance: number } | null {
    let best: { id: string; distance: number } | null = null;
    for (const bucket of this.buckets.values()) {
      const hits = ray.intersectObject(bucket.mesh, false);
      for (const h of hits) {
        if (h.instanceId === undefined) continue;
        if (!best || h.distance < best.distance) {
          const meta = bucket.metas[h.instanceId];
          if (meta) best = { id: meta.id, distance: h.distance };
        }
      }
    }
    return best;
  }

  addTo(scene: Scene): void {
    for (const bucket of this.buckets.values()) scene.add(bucket.mesh);
  }

  dispose(): void {
    for (const bucket of this.buckets.values()) {
      bucket.mesh.parent?.remove(bucket.mesh);
      bucket.mesh.dispose();
      bucket.geometry.dispose();
      bucket.material.dispose();
    }
    this.buckets.clear();
    this.indexById.clear();
    this.metas.length = 0;
  }

  /** Recompute color + matrix for a single node from current state. */
  private refreshAppearance(id: string): void {
    const meta = this.indexById.get(id);
    if (!meta) return;
    this.writeInstance(meta);
    const bucket = this.buckets.get(meta.type);
    if (bucket) {
      bucket.mesh.instanceMatrix.needsUpdate = true;
      if (bucket.mesh.instanceColor) bucket.mesh.instanceColor.needsUpdate = true;
    }
  }

  /**
   * Write the matrix and color for a single instance based on its current
   * highlight state. The selected node beats hover when both apply.
   */
  private writeInstance(meta: NodeInstanceMeta): void {
    const bucket = this.buckets.get(meta.type);
    if (!bucket) return;
    const isSelected = this.selectedId === meta.id;
    const isHovered = this.hoveredId === meta.id;
    const scale =
      meta.radius * (isSelected ? SELECT_SCALE : isHovered ? HOVER_SCALE : 1);

    this.proxy.position.set(meta.x, meta.y, meta.z);
    this.proxy.scale.setScalar(scale);
    this.proxy.updateMatrix();
    bucket.mesh.setMatrixAt(meta.index, this.proxy.matrix);

    if (isSelected || isHovered) {
      // Brighten by tinting toward white via the per-instance color.
      this.tmpColor.copy(meta.baseColor).multiplyScalar(HIGHLIGHT_TINT);
      // Three's Color clamps on read but not on multiplyScalar — clamp now
      // so HDR-bound bloom doesn't blow it past meaningful thresholds.
      this.tmpColor.r = Math.min(this.tmpColor.r, 1);
      this.tmpColor.g = Math.min(this.tmpColor.g, 1);
      this.tmpColor.b = Math.min(this.tmpColor.b, 1);
      bucket.mesh.setColorAt(meta.index, this.tmpColor);
    } else {
      bucket.mesh.setColorAt(meta.index, meta.baseColor);
    }
  }
}

/**
 * Visual radius — degree dominates so hubs are obvious; confidence adds
 * a small floor so high-confidence leaves don't disappear next to them.
 */
export function nodeRadius(n: ExplorerNode): number {
  const degreeTerm = Math.log1p(n.degree) * 0.45;
  const confTerm = 0.25 * n.confidence;
  return Math.max(0.4, 0.6 + degreeTerm + confTerm);
}
