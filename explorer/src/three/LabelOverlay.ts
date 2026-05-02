/**
 * HTML overlay labels for "active" nodes (Slice F next pass).
 *
 * Pure DOM (one absolutely-positioned div per visible label) layered over
 * the canvas. Avoids texture sprites so labels stay crisp at any zoom and
 * the GPU stays free for tubes/nodes/haze.
 *
 * Active set policy is owned by the caller (Graph3DCanvas) — typically
 * the selected node + its 2-hop focus neighbourhood, falling back to the
 * top-N by degree when no selection is active. This file only knows how
 * to project + position + recycle DOM nodes efficiently.
 */

import { Vector3, type PerspectiveCamera } from "three";

/** Shape the overlay needs from each candidate node. */
export interface LabelTarget {
  id: string;
  label: string;
  x: number;
  y: number;
  z: number;
}

/** How often to re-project labels. ~15 Hz keeps DOM traffic cheap. */
const UPDATE_INTERVAL_MS = 66;
/** Labels further than this (in NDC z) are skipped (behind near plane). */
const NEAR_CULL = 0.0;

export class LabelOverlay {
  private readonly host: HTMLDivElement;
  /** Pooled DOM nodes keyed by node id so we don't churn on every frame. */
  private readonly pool = new Map<string, HTMLDivElement>();
  private active: LabelTarget[] = [];
  private lastUpdate = 0;
  private readonly tmpVec = new Vector3();

  constructor(container: HTMLElement) {
    this.host = document.createElement("div");
    Object.assign(this.host.style, {
      position: "absolute",
      inset: "0",
      pointerEvents: "none",
      overflow: "hidden",
      zIndex: "5",
    } satisfies Partial<CSSStyleDeclaration>);
    container.appendChild(this.host);
  }

  /**
   * Replace the active label set. The pool is reconciled lazily on the
   * next `update()` to keep allocation off the React render path.
   */
  setActive(targets: readonly LabelTarget[]): void {
    this.active = targets.slice();
    // Force one immediate update so the pool reflects the new set even
    // if the camera is paused (the throttle gate would otherwise stall).
    this.lastUpdate = 0;
  }

  /** Re-project + position labels. Throttled internally. */
  update(camera: PerspectiveCamera, viewportW: number, viewportH: number): void {
    const now = performance.now();
    if (now - this.lastUpdate < UPDATE_INTERVAL_MS) return;
    this.lastUpdate = now;

    const seen = new Set<string>();
    for (const t of this.active) {
      seen.add(t.id);
      let el = this.pool.get(t.id);
      if (!el) {
        el = document.createElement("div");
        el.className = "graph3d-label";
        el.textContent = t.label;
        Object.assign(el.style, {
          position: "absolute",
          padding: "2px 6px",
          font: "11px/1.2 system-ui, sans-serif",
          color: "#e6ecf5",
          background: "rgba(0,0,0,0.30)",
          borderRadius: "4px",
          letterSpacing: "0.01em",
          whiteSpace: "nowrap",
          transform: "translate(-50%, -120%)",
          pointerEvents: "none",
          textShadow: "0 1px 2px rgba(0,0,0,0.6)",
        } satisfies Partial<CSSStyleDeclaration>);
        this.host.appendChild(el);
        this.pool.set(t.id, el);
      }
      this.tmpVec.set(t.x, t.y, t.z);
      this.tmpVec.project(camera);
      // Off-screen / behind camera → hide rather than churning DOM.
      if (this.tmpVec.z > 1 || this.tmpVec.z < NEAR_CULL || this.tmpVec.z < -1) {
        el.style.display = "none";
        continue;
      }
      const px = (this.tmpVec.x * 0.5 + 0.5) * viewportW;
      const py = (-this.tmpVec.y * 0.5 + 0.5) * viewportH;
      // Clip slack so labels don't pile up at the edges when targets
      // wander outside the framing.
      if (px < -40 || px > viewportW + 40 || py < -20 || py > viewportH + 20) {
        el.style.display = "none";
        continue;
      }
      el.style.display = "";
      el.style.left = `${px.toFixed(1)}px`;
      el.style.top = `${py.toFixed(1)}px`;
    }
    // Recycle any pool entries the active set no longer references.
    for (const [id, el] of this.pool) {
      if (!seen.has(id)) {
        el.remove();
        this.pool.delete(id);
      }
    }
  }

  dispose(): void {
    for (const el of this.pool.values()) el.remove();
    this.pool.clear();
    this.host.remove();
  }
}
