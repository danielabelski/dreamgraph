/**
 * WavefrontSystem — expanding sphere shells triggered by graph events.
 *
 * plans/EXPLORER_3D_MODE.md §12.E (Slice E2).
 *
 * When the cognitive engine completes a dream cycle (or any other event
 * the operator has opted into), we spawn a translucent additive sphere
 * at the graph centroid. The sphere scales up and fades out over a fixed
 * duration so the operator can see — at a glance — that the engine just
 * thought a thought, without leaving the 3D view.
 *
 * Implementation notes:
 *   - Pre-allocated mesh pool (size MAX_ACTIVE_WAVES). New `trigger`
 *     calls reclaim the oldest active slot, never grow the array.
 *   - `MeshBasicMaterial` with additive blending so the shells stack
 *     gracefully when several events fire in quick succession.
 *   - All animation is driven by `tick(nowSeconds)` — the renderer can
 *     pause the system by skipping the call (used by reduced-motion mode).
 */

import {
  AdditiveBlending,
  Color,
  DoubleSide,
  Mesh,
  MeshBasicMaterial,
  SphereGeometry,
  type Scene,
  type Vector3 as TVector3,
  Vector3,
} from "three";

/** Maximum simultaneously-animating waves. Anything beyond is dropped. */
export const MAX_ACTIVE_WAVES = 4;
/** Wave lifetime in seconds. Tuned for "noticeable but not distracting". */
export const WAVE_DURATION_S = 1.4;
/** Initial radius (world units). */
const START_RADIUS = 1.0;
/** Final radius — should comfortably exceed the graph's bounding radius. */
const END_RADIUS_FACTOR = 1.4;

interface WaveSlot {
  mesh: Mesh;
  material: MeshBasicMaterial;
  startedAt: number;
  active: boolean;
  baseColor: Color;
}

export class WavefrontSystem {
  private readonly slots: WaveSlot[] = [];
  private readonly center = new Vector3();
  private graphRadius = 20;

  constructor() {
    const geom = new SphereGeometry(1, 24, 16);
    for (let i = 0; i < MAX_ACTIVE_WAVES; i++) {
      const mat = new MeshBasicMaterial({
        color: 0xffffff,
        transparent: true,
        opacity: 0,
        blending: AdditiveBlending,
        depthWrite: false,
        side: DoubleSide,
        wireframe: false,
      });
      const mesh = new Mesh(geom, mat);
      mesh.frustumCulled = false;
      mesh.visible = false;
      this.slots.push({
        mesh,
        material: mat,
        startedAt: 0,
        active: false,
        baseColor: new Color(0xffffff),
      });
    }
  }

  addTo(scene: Scene): void {
    for (const s of this.slots) scene.add(s.mesh);
  }

  /** Update the centroid and scale envelope. Call when the layout settles. */
  setBounds(center: TVector3, radius: number): void {
    this.center.copy(center);
    if (Number.isFinite(radius) && radius > 0) {
      this.graphRadius = radius;
    }
  }

  /**
   * Spawn a new wavefront. If all slots are active, reclaim the oldest.
   * `color` may be any THREE-compatible color value; defaults to white.
   */
  trigger(nowSeconds: number, color: number | string = 0xffffff): void {
    let target: WaveSlot | undefined = this.slots.find((s) => !s.active);
    if (!target) {
      target = this.slots.reduce((oldest, s) =>
        s.startedAt < oldest.startedAt ? s : oldest,
      );
    }
    target.active = true;
    target.startedAt = nowSeconds;
    target.baseColor.set(color);
    target.material.color.copy(target.baseColor);
    target.material.opacity = 0.45;
    target.mesh.position.copy(this.center);
    target.mesh.scale.setScalar(START_RADIUS);
    target.mesh.visible = true;
  }

  /** Advance every active wave. Idempotent if no waves are active. */
  tick(nowSeconds: number): void {
    const endRadius = this.graphRadius * END_RADIUS_FACTOR;
    for (const s of this.slots) {
      if (!s.active) continue;
      const t = (nowSeconds - s.startedAt) / WAVE_DURATION_S;
      if (t >= 1) {
        s.active = false;
        s.mesh.visible = false;
        s.material.opacity = 0;
        continue;
      }
      // Ease-out for radius (fast start), linear fade for opacity.
      const ease = 1 - Math.pow(1 - t, 2);
      const radius = START_RADIUS + (endRadius - START_RADIUS) * ease;
      s.mesh.scale.setScalar(radius);
      s.material.opacity = 0.45 * (1 - t);
    }
  }

  /** True iff any wave is currently animating. Useful for tests + status. */
  hasActive(): boolean {
    return this.slots.some((s) => s.active);
  }

  dispose(): void {
    for (const s of this.slots) {
      s.mesh.parent?.remove(s.mesh);
      s.material.dispose();
    }
    // Geometry is shared across all slots — dispose it via the first one.
    if (this.slots.length > 0) this.slots[0].mesh.geometry.dispose();
  }
}
