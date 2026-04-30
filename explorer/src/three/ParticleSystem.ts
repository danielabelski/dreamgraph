/**
 * Light particles flowing along edge tubes — the marquee of 3D mode.
 *
 * plans/EXPLORER_3D_MODE.md §3.2.3.
 *
 * Implementation choice: CPU-side per-frame `t` advance + matrix update on
 * a single `InstancedMesh`. The plan also describes a GPU-shader variant
 * with per-instance attributes; that's a Slice D optimization once the
 * motion patterns are visually validated. CPU advance for ~5–20k particles
 * is comfortably under 1 ms/frame on the reference laptop.
 *
 * Per-kind motion table (matches plan §3.2.3, simplified for v1):
 *
 *   | kind      | particles per edge | speed | direction       | brightness         |
 *   |-----------|--------------------|-------|-----------------|--------------------|
 *   | validated | round(6 × conf)    | 0.18  | s → t           | steady             |
 *   | candidate | 3                  | 0.18  | s → t (sparse)  | steady             |
 *   | dream     | 4                  | 0.07  | s → t           | steady             |
 *   | tension   | 2 fwd + 2 back     | 0.30  | mixed           | sawtooth flicker   |
 *   | fact      | 2                  | 0.04  | s → t           | dim, steady        |
 *
 * Color blindness: motion direction + per-kind speed encode the kind
 * independently of hue, satisfying the plan's accessibility constraint.
 */

import {
  AdditiveBlending,
  Color,
  IcosahedronGeometry,
  InstancedMesh,
  MeshBasicMaterial,
  Object3D,
  Vector3,
  type Scene,
} from "three";
import { EDGE_STYLES } from "../theme";
import type { ExplorerEdge } from "../types";
import type { SplineSet } from "./splines";

interface ParticleMeta {
  /** Index into `splines.curves`. */
  edgeIndex: number;
  /** Phase offset in [0,1). Forward particles start at this t. */
  offset: number;
  /** Speed in normalized-units / second along the curve. */
  speed: number;
  /** +1 = source→target, -1 = counterflow (used for tension). */
  direction: 1 | -1;
  /** Edge kind, kept for the brightness modulation pass. */
  kind: ExplorerEdge["kind"];
}

const SPEEDS = {
  validated: 0.18,
  candidate: 0.18,
  dream: 0.07,
  tension: 0.30,
  fact: 0.04,
} as const;

const PARTICLE_RADIUS = 0.18;

export class ParticleSystem {
  readonly mesh: InstancedMesh;
  readonly metas: ParticleMeta[];

  private readonly geometry: IcosahedronGeometry;
  private readonly material: MeshBasicMaterial;
  private readonly splines: SplineSet;
  /** Reusable scratch objects to keep the per-frame loop allocation-free. */
  private readonly proxy = new Object3D();
  private readonly samplePos = new Vector3();

  constructor(splines: SplineSet) {
    this.splines = splines;

    // Spawn the per-edge particle metas up front.
    const metas: ParticleMeta[] = [];
    for (const meta of splines.metas) {
      pushParticlesForEdge(metas, meta.index, meta.kind, meta.conf);
    }
    this.metas = metas;

    this.geometry = new IcosahedronGeometry(PARTICLE_RADIUS, 0);
    // Basic + additive — particles are emissive points of light, not lit.
    this.material = new MeshBasicMaterial({
      vertexColors: false,
      transparent: true,
      opacity: 0.95,
      blending: AdditiveBlending,
      depthWrite: false,
    });

    this.mesh = new InstancedMesh(this.geometry, this.material, metas.length || 1);
    this.mesh.frustumCulled = false;
    // Hide the trailing instance when the metas list is empty so we don't
    // render a stray particle at the origin.
    this.mesh.count = metas.length;

    // Per-instance color from edge kind. Brightness is baked here; the
    // tension flicker is applied by the per-frame matrix scale instead so
    // we don't have to keep updating the color buffer.
    const tmpColor = new Color();
    for (let i = 0; i < metas.length; i++) {
      const m = metas[i];
      tmpColor.set(EDGE_STYLES[m.kind].color);
      this.mesh.setColorAt(i, tmpColor);
    }
    if (this.mesh.instanceColor) this.mesh.instanceColor.needsUpdate = true;
  }

  /**
   * Advance every particle by `dtSeconds` and write the new transforms.
   *
   * `nowSeconds` drives kind-specific brightness modulation that doesn't
   * accumulate over time (so the loop is well-defined under variable dt).
   */
  update(dtSeconds: number, nowSeconds: number): void {
    const metas = this.metas;
    const curves = this.splines.curves;
    const proxy = this.proxy;
    const sample = this.samplePos;
    for (let i = 0; i < metas.length; i++) {
      const m = metas[i];
      // Advance the offset; wrap to [0,1).
      m.offset = (m.offset + m.speed * dtSeconds) % 1;
      if (m.offset < 0) m.offset += 1;
      const u = m.direction === 1 ? m.offset : 1 - m.offset;
      const curve = curves[m.edgeIndex];
      curve.getPointAt(u, sample);
      proxy.position.copy(sample);
      // Tension particles flicker (2 Hz sawtooth); other kinds stay steady.
      let scale = 1;
      if (m.kind === "tension") {
        scale = 0.7 + 0.3 * (((nowSeconds * 2) % 1));
      } else if (m.kind === "candidate") {
        // Sparse pulse — every 1.5s the particle dims to 25%, then recovers.
        const phase = (nowSeconds + m.offset * 1.5) % 1.5;
        scale = phase < 0.3 ? 0.25 : 1;
      } else if (m.kind === "fact") {
        scale = 0.55;
      }
      proxy.scale.setScalar(scale);
      proxy.updateMatrix();
      this.mesh.setMatrixAt(i, proxy.matrix);
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
 * Emit per-edge particle metas according to the kind table.
 *
 * Exported so tests can validate spawn counts independently of the
 * InstancedMesh wiring.
 */
export function pushParticlesForEdge(
  out: ParticleMeta[],
  edgeIndex: number,
  kind: ExplorerEdge["kind"],
  conf: number,
): void {
  const speed = SPEEDS[kind];
  const add = (count: number, direction: 1 | -1, offsetPattern: (i: number, n: number) => number) => {
    for (let i = 0; i < count; i++) {
      out.push({
        edgeIndex,
        offset: offsetPattern(i, count),
        speed,
        direction,
        kind,
      });
    }
  };

  if (kind === "validated") {
    const count = Math.max(2, Math.round(6 * conf));
    add(count, 1, (i, n) => i / n);
  } else if (kind === "candidate") {
    add(3, 1, (i, n) => i / n);
  } else if (kind === "dream") {
    add(4, 1, (i, n) => i / n);
  } else if (kind === "tension") {
    add(2, 1, (i, n) => i / n);
    add(2, -1, (i, n) => i / n + 0.5 / n);
  } else if (kind === "fact") {
    add(2, 1, (i, n) => i / n);
  }
}
