/**
 * Density-aware ambient haze (Slice F next pass).
 *
 * Renders one additive Point per node with a soft circular sprite. Where
 * many nodes overlap on screen, additive blending stacks the haze and the
 * region glows softly — sparse outskirts stay dark, dense clusters
 * acquire a faint atmospheric bloom.
 *
 * Sized to be too dim to dominate (max additive ≈ 0.04 per sample), so
 * the bloom pass doesn't double-count it. The points are rendered just
 * before the tubes so they sit behind everything else colour-wise.
 *
 * Performance: one draw call, vertex shader only, no per-frame uploads.
 */

import {
  AdditiveBlending,
  BufferAttribute,
  BufferGeometry,
  Color,
  Points,
  ShaderMaterial,
  type Scene,
} from "three";

const VERTEX = /* glsl */ `
uniform float uPixelRatio;
uniform float uSize;
attribute float aWeight;
varying float vWeight;
void main() {
  vWeight = aWeight;
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  // Distance-attenuated point size — closer clusters bleed wider, far
  // ones stay tight so distant nodes don't fog up the whole scene.
  float size = uSize * uPixelRatio * (300.0 / max(1.0, -mv.z));
  gl_PointSize = size;
  gl_Position = projectionMatrix * mv;
}
`;

const FRAGMENT = /* glsl */ `
uniform vec3 uColor;
uniform float uIntensity;
varying float vWeight;
void main() {
  vec2 uv = gl_PointCoord - 0.5;
  float r = length(uv);
  // Soft Gaussian-ish falloff; clamp early so we don't write any
  // post-cutoff pixels (saves fillrate on the cheap blob edges).
  if (r > 0.5) discard;
  float a = exp(-r * r * 9.0) * uIntensity * vWeight;
  gl_FragColor = vec4(uColor * a, a);
}
`;

export class DensityHaze {
  readonly points: Points;
  private readonly material: ShaderMaterial;
  private geometry: BufferGeometry;
  private readonly nodeCount: number;
  private readonly weights: Float32Array;

  constructor(nodeCount: number) {
    this.nodeCount = nodeCount;
    this.weights = new Float32Array(nodeCount);
    for (let i = 0; i < nodeCount; i++) this.weights[i] = 1;
    this.geometry = new BufferGeometry();
    this.geometry.setAttribute(
      "position",
      new BufferAttribute(new Float32Array(nodeCount * 3), 3),
    );
    this.geometry.setAttribute("aWeight", new BufferAttribute(this.weights, 1));
    this.material = new ShaderMaterial({
      uniforms: {
        uPixelRatio: { value: Math.min(window.devicePixelRatio, 2) },
        uSize: { value: 0.55 },
        uColor: { value: new Color(0x6e90c8) },
        uIntensity: { value: 0.045 },
      },
      vertexShader: VERTEX,
      fragmentShader: FRAGMENT,
      transparent: true,
      depthWrite: false,
      blending: AdditiveBlending,
    });
    this.points = new Points(this.geometry, this.material);
    this.points.frustumCulled = false;
    // Render before tubes/nodes so it sits behind their crisp bloom.
    this.points.renderOrder = -10;
  }

  /** Push the latest layout positions into the position buffer. */
  setPositions(positions: readonly { id: string; x: number; y: number; z: number }[]): void {
    const pos = this.geometry.getAttribute("position") as BufferAttribute;
    const arr = pos.array as Float32Array;
    const n = Math.min(positions.length, this.nodeCount);
    for (let i = 0; i < n; i++) {
      const p = positions[i];
      arr[i * 3 + 0] = p.x;
      arr[i * 3 + 1] = p.y;
      arr[i * 3 + 2] = p.z;
    }
    // Zero out unused slots if the snapshot shrank.
    for (let i = n; i < this.nodeCount; i++) {
      arr[i * 3 + 0] = 0;
      arr[i * 3 + 1] = 0;
      arr[i * 3 + 2] = 0;
    }
    pos.needsUpdate = true;
  }

  /** Toggle a per-node visibility weight (0 = hidden, 1 = full). */
  setVisibility(visibleByIndex: readonly boolean[]): void {
    const wAttr = this.geometry.getAttribute("aWeight") as BufferAttribute;
    const arr = wAttr.array as Float32Array;
    const n = Math.min(visibleByIndex.length, this.nodeCount);
    for (let i = 0; i < n; i++) arr[i] = visibleByIndex[i] ? 1 : 0;
    wAttr.needsUpdate = true;
  }

  setPixelRatio(ratio: number): void {
    this.material.uniforms["uPixelRatio"].value = ratio;
  }

  addTo(scene: Scene): void {
    scene.add(this.points);
  }

  dispose(): void {
    this.points.parent?.remove(this.points);
    this.geometry.dispose();
    this.material.dispose();
  }
}
