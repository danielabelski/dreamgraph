/**
 * Minimap3D — top-down 2D overlay of the 3D node cloud.
 *
 * plans/EXPLORER_3D_MODE.md §12.E (Slice E2).
 *
 * Renders into a single SVG element parked in the bottom-right corner
 * of the canvas. Two layers:
 *   1. Static node dots — drawn once per layout settle.
 *   2. Camera frustum quad — redrawn from the orbit pose each frame.
 *
 * SVG was picked over a second WebGL viewport so the minimap costs zero
 * GPU time, draws crisply at any DPR, and survives a fallback to 2D mode
 * (the corner widget can remain visible even when the main 3D scene is
 * paused). It is positioned absolutely; the parent container only needs
 * `position: relative`.
 */

import type { PerspectiveCamera, Vector3 } from "three";

/** Edge length of the SVG square in CSS pixels. */
const SIZE = 140;
/** Padding around the world bounds in normalized units. */
const PADDING = 0.08;

interface NodePoint {
  id: string;
  x: number;
  z: number;
}

export class Minimap3D {
  readonly element: SVGSVGElement;

  private readonly nodesLayer: SVGGElement;
  private readonly frustumPath: SVGPathElement;
  private readonly cameraDot: SVGCircleElement;
  private bounds = { minX: -1, maxX: 1, minZ: -1, maxZ: 1 };

  constructor() {
    const svgNs = "http://www.w3.org/2000/svg";
    const svg = document.createElementNS(svgNs, "svg") as SVGSVGElement;
    svg.setAttribute("class", "minimap-3d");
    svg.setAttribute("width", String(SIZE));
    svg.setAttribute("height", String(SIZE));
    svg.setAttribute("viewBox", `0 0 ${SIZE} ${SIZE}`);
    // Inline style so we don't have to ship a stylesheet update for v1.
    svg.setAttribute(
      "style",
      [
        "position:absolute",
        "bottom:12px",
        "right:12px",
        "background:rgba(8,12,18,0.72)",
        "border:1px solid rgba(255,255,255,0.12)",
        "border-radius:6px",
        "pointer-events:none",
        "z-index:5",
      ].join(";"),
    );

    const bg = document.createElementNS(svgNs, "rect");
    bg.setAttribute("x", "0");
    bg.setAttribute("y", "0");
    bg.setAttribute("width", String(SIZE));
    bg.setAttribute("height", String(SIZE));
    bg.setAttribute("fill", "transparent");
    svg.appendChild(bg);

    this.nodesLayer = document.createElementNS(svgNs, "g") as SVGGElement;
    this.nodesLayer.setAttribute("class", "minimap-nodes");
    svg.appendChild(this.nodesLayer);

    this.frustumPath = document.createElementNS(svgNs, "path") as SVGPathElement;
    this.frustumPath.setAttribute("fill", "rgba(120, 200, 255, 0.16)");
    this.frustumPath.setAttribute("stroke", "rgba(160, 220, 255, 0.65)");
    this.frustumPath.setAttribute("stroke-width", "1");
    svg.appendChild(this.frustumPath);

    this.cameraDot = document.createElementNS(svgNs, "circle") as SVGCircleElement;
    this.cameraDot.setAttribute("r", "2.5");
    this.cameraDot.setAttribute("fill", "#a0dcff");
    svg.appendChild(this.cameraDot);

    this.element = svg;
  }

  /**
   * Recompute the world bounds and redraw the static node layer. Call
   * once per layout settle; the camera marker updates separately.
   */
  setNodes(positions: readonly NodePoint[]): void {
    while (this.nodesLayer.firstChild) {
      this.nodesLayer.removeChild(this.nodesLayer.firstChild);
    }
    if (positions.length === 0) {
      this.bounds = { minX: -1, maxX: 1, minZ: -1, maxZ: 1 };
      return;
    }
    let minX = Infinity;
    let maxX = -Infinity;
    let minZ = Infinity;
    let maxZ = -Infinity;
    for (const p of positions) {
      if (p.x < minX) minX = p.x;
      if (p.x > maxX) maxX = p.x;
      if (p.z < minZ) minZ = p.z;
      if (p.z > maxZ) maxZ = p.z;
    }
    // Square the bounds so the projection isn't stretched.
    const cx = (minX + maxX) * 0.5;
    const cz = (minZ + maxZ) * 0.5;
    const half = Math.max(maxX - minX, maxZ - minZ, 2) * 0.5;
    const span = half * (1 + PADDING * 2);
    this.bounds = {
      minX: cx - span,
      maxX: cx + span,
      minZ: cz - span,
      maxZ: cz + span,
    };

    const svgNs = "http://www.w3.org/2000/svg";
    // Cap rendered points so dense graphs don't choke the DOM.
    const cap = 800;
    const stride = positions.length > cap ? Math.ceil(positions.length / cap) : 1;
    for (let i = 0; i < positions.length; i += stride) {
      const p = positions[i];
      const px = this.projectX(p.x);
      const py = this.projectZ(p.z);
      const dot = document.createElementNS(svgNs, "circle");
      dot.setAttribute("cx", px.toFixed(2));
      dot.setAttribute("cy", py.toFixed(2));
      dot.setAttribute("r", "1.2");
      dot.setAttribute("fill", "rgba(255,255,255,0.55)");
      this.nodesLayer.appendChild(dot);
    }
  }

  /**
   * Update the camera marker and frustum quad. Cheap to call every frame.
   * `target` is the orbit-controls focal point; `cam` is the camera.
   */
  setCamera(cam: PerspectiveCamera, target: Vector3): void {
    const camX = this.projectX(cam.position.x);
    const camY = this.projectZ(cam.position.z);
    this.cameraDot.setAttribute("cx", camX.toFixed(2));
    this.cameraDot.setAttribute("cy", camY.toFixed(2));

    // Build a triangular frustum footprint by walking the camera's forward
    // direction (toward target) and spreading by half the horizontal FOV.
    const dx = target.x - cam.position.x;
    const dz = target.z - cam.position.z;
    const dist = Math.hypot(dx, dz);
    if (dist < 1e-3) {
      this.frustumPath.setAttribute("d", "");
      return;
    }
    const fx = dx / dist;
    const fz = dz / dist;
    const halfFov = (cam.fov * cam.aspect * Math.PI) / 360;
    const reach = Math.max(dist * 1.2, 4);
    const cosH = Math.cos(halfFov);
    const sinH = Math.sin(halfFov);
    // Rotate forward vector by +/- halfFov to get the two edges.
    const lx = fx * cosH - fz * sinH;
    const lz = fx * sinH + fz * cosH;
    const rx = fx * cosH + fz * sinH;
    const rz = -fx * sinH + fz * cosH;

    const ax = this.projectX(cam.position.x + lx * reach);
    const ay = this.projectZ(cam.position.z + lz * reach);
    const bx = this.projectX(cam.position.x + rx * reach);
    const by = this.projectZ(cam.position.z + rz * reach);
    this.frustumPath.setAttribute(
      "d",
      `M ${camX.toFixed(2)} ${camY.toFixed(2)} L ${ax.toFixed(2)} ${ay.toFixed(2)} L ${bx.toFixed(2)} ${by.toFixed(2)} Z`,
    );
  }

  attachTo(parent: HTMLElement): void {
    parent.appendChild(this.element);
  }

  dispose(): void {
    this.element.parentNode?.removeChild(this.element);
  }

  /** Map a world X coordinate into the SVG's pixel space. */
  private projectX(x: number): number {
    const span = this.bounds.maxX - this.bounds.minX;
    if (span <= 0) return SIZE * 0.5;
    return ((x - this.bounds.minX) / span) * SIZE;
  }

  /**
   * Map a world Z coordinate into the SVG's pixel space.
   * Top-down view: z+ goes "down" in screen-space (positive y).
   */
  private projectZ(z: number): number {
    const span = this.bounds.maxZ - this.bounds.minZ;
    if (span <= 0) return SIZE * 0.5;
    return ((z - this.bounds.minZ) / span) * SIZE;
  }
}
