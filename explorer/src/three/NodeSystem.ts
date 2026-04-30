/**
 * Node renderer — single InstancedMesh of icosahedrons, per-instance
 * color from `NODE_COLORS` and per-instance scale derived from degree
 * and confidence.
 *
 * plans/EXPLORER_3D_MODE.md §3.2.1 — the plan calls for one InstancedMesh
 * per entity-type bucket so each shape can differ. Slice B ships the
 * unified-icosahedron variant: one draw call total, color carries type.
 * The per-shape split lands in Slice D when bloom + selection rim are
 * already pulling enough visual weight that the shape distinction adds
 * legibility instead of noise.
 */

import {
  Color,
  IcosahedronGeometry,
  InstancedMesh,
  MeshStandardMaterial,
  Object3D,
  type Scene,
} from "three";
import { nodeRenderColor } from "../theme";
import type { ExplorerNode } from "../types";

/**
 * Per-instance metadata kept in parallel with the InstancedMesh so the
 * raycaster (Slice D) and pulse system (Slice D) can map back to ids.
 */
export interface NodeInstanceMeta {
  id: string;
  index: number;
  /** World position; mirrors the matrix written into the InstancedMesh. */
  x: number;
  y: number;
  z: number;
  /** Visual radius after degree/confidence scaling. */
  radius: number;
}

export class NodeSystem {
  readonly mesh: InstancedMesh;
  readonly metas: NodeInstanceMeta[];

  private readonly geometry: IcosahedronGeometry;
  private readonly material: MeshStandardMaterial;
  private readonly indexById: Map<string, number>;
  /** Re-used to avoid allocating a fresh Object3D every matrix update. */
  private readonly proxy = new Object3D();

  constructor(nodes: readonly ExplorerNode[]) {
    // Detail 1 = 80 tris per sphere — cheap and reads as round under bloom.
    this.geometry = new IcosahedronGeometry(1, 1);
    // Standard material so emissive/metalness can be tuned later; flat
    // shading keeps the facets readable so users can tell shapes apart
    // even before per-type geometries land.
    this.material = new MeshStandardMaterial({
      vertexColors: false,
      roughness: 0.45,
      metalness: 0.15,
      flatShading: true,
    });

    this.mesh = new InstancedMesh(this.geometry, this.material, nodes.length);
    // We never raycast against this mesh outside of explicit hover passes;
    // disable frustum culling because the bounding sphere we'd compute
    // covers the whole graph anyway.
    this.mesh.frustumCulled = false;

    this.metas = new Array(nodes.length);
    this.indexById = new Map();

    const tmpColor = new Color();
    for (let i = 0; i < nodes.length; i++) {
      const n = nodes[i];
      const radius = nodeRadius(n);
      this.metas[i] = { id: n.id, index: i, x: 0, y: 0, z: 0, radius };
      this.indexById.set(n.id, i);

      // Initial color — health tilts toward red, matching 2D semantics.
      tmpColor.set(nodeRenderColor(n.type, n.health));
      this.mesh.setColorAt(i, tmpColor);

      // Initial transform — origin until the layout reports back.
      this.proxy.position.set(0, 0, 0);
      this.proxy.scale.setScalar(radius);
      this.proxy.updateMatrix();
      this.mesh.setMatrixAt(i, this.proxy.matrix);
    }

    this.mesh.instanceMatrix.needsUpdate = true;
    if (this.mesh.instanceColor) this.mesh.instanceColor.needsUpdate = true;
  }

  /** Apply layout positions in-place. Unknown ids are ignored. */
  applyLayout(positions: readonly { id: string; x: number; y: number; z: number }[]): void {
    for (const p of positions) {
      const i = this.indexById.get(p.id);
      if (i === undefined) continue;
      const meta = this.metas[i];
      meta.x = p.x;
      meta.y = p.y;
      meta.z = p.z;
      this.proxy.position.set(p.x, p.y, p.z);
      this.proxy.scale.setScalar(meta.radius);
      this.proxy.updateMatrix();
      this.mesh.setMatrixAt(i, this.proxy.matrix);
    }
    this.mesh.instanceMatrix.needsUpdate = true;
  }

  addTo(scene: Scene): void {
    scene.add(this.mesh);
  }

  dispose(): void {
    this.mesh.parent?.remove(this.mesh);
    this.mesh.dispose();
    this.geometry.dispose();
    this.material.dispose();
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
