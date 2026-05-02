/**
 * Edge tubes — translucent additive-blended pipes along each edge spline,
 * with a custom shader that draws moving "flow pulses" right on the tube
 * surface. Replaces the old `ParticleSystem`: one draw call instead of
 * 4000+ matrix updates per frame.
 *
 * plans/EXPLORER_3D_MODE.md §3.2.2 + §12.E (heatmap) + §12.F (shader flow).
 *
 * Geometry layout
 * ---------------
 * One TubeGeometry per edge, then merged into a single BufferGeometry so
 * the whole edge graph draws in one call. Each vertex carries:
 *   - position / normal / uv         (from TubeGeometry)
 *   - color                          (per-edge base RGB; heatmap mutates)
 *   - aDirection                     (1 = s→t, -1 = t→s, 0 = bilateral)
 *   - aFlowSpeed                     (cycles / second along the tube)
 *   - aFlowDensity                   (pulses per tube length)
 *   - aConfidence                    (0..1, drives base brightness)
 *   - aPulsePhase                    (per-edge offset, desyncs the flow)
 *   - aFocus                         (1 = highlighted, ~0.15 when dimmed)
 *
 * The fragment shader walks `vUv.x` (longitudinal) to draw moving pulses
 * and supports bilateral counter-flow for tension edges. Three's standard
 * fog chunks are included so the adaptive scene fog still applies.
 *
 * Heatmap mode (Slice E1) recolors the per-vertex base `color` attribute
 * in place — the shader multiplies that with the flow term, so heat shows
 * through the moving pulses.
 *
 * Selection focus (Slice F2) walks the edge graph from the selected node
 * up to N hops, sets `aFocus = 1` on touched edges and `~0.15` on the
 * rest, then re-uploads only that one attribute.
 */

import {
  AdditiveBlending,
  BufferAttribute,
  BufferGeometry,
  Color,
  Mesh,
  ShaderMaterial,
  TubeGeometry,
  UniformsLib,
  UniformsUtils,
  type Scene,
} from "three";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";
import { EDGE_STYLES } from "../theme";
import type { ExplorerEdge } from "../types";
import type { SplineSet } from "./splines";

/** Tubular segments per edge — controls smoothness along the curve. */
const TUBULAR_SEGMENTS = 24;
/** Radial segments per edge — controls perceived roundness in cross-section. */
const RADIAL_SEGMENTS = 6;

/** Warm tint mixed in for hot edges. Roughly amber/orange. */
const HEAT_COLOR = new Color(1.0, 0.55, 0.15);
/** How much extra brightness a fully-hot edge gets (1 + this). */
const HEAT_BRIGHTNESS = 1.2;

/** Default focus level for off-focus edges when selection is active. */
const DEFAULT_DIMMED_FOCUS = 0.18;

/** Per-kind motion table — replaces the old ParticleSystem motion table. */
const KIND_MOTION: Record<
  ExplorerEdge["kind"],
  { speed: number; density: number; direction: -1 | 0 | 1 }
> = {
  validated: { speed: 0.55, density: 4, direction: 1 },
  candidate: { speed: 0.40, density: 2, direction: 1 },
  dream:     { speed: 0.18, density: 3, direction: 1 },
  tension:   { speed: 0.70, density: 5, direction: 0 }, // bilateral
  fact:      { speed: 0.10, density: 2, direction: 1 },
};

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

interface EdgeMeta {
  s: string;
  t: string;
  kind: ExplorerEdge["kind"];
}

const VERTEX_SHADER = /* glsl */ `
#include <common>
#include <fog_pars_vertex>

attribute float aDirection;
attribute float aFlowSpeed;
attribute float aFlowDensity;
attribute float aConfidence;
attribute float aPulsePhase;
attribute float aFocus;
attribute float aHidden;

varying vec2 vUv;
varying vec3 vColor;
varying float vDirection;
varying float vFlowSpeed;
varying float vFlowDensity;
varying float vConfidence;
varying float vPulsePhase;
varying float vFocus;
varying float vHidden;
varying vec3 vNormalView;
varying vec3 vViewDir;

void main() {
  vUv = uv;
  vColor = color;
  vDirection = aDirection;
  vFlowSpeed = aFlowSpeed;
  vFlowDensity = aFlowDensity;
  vConfidence = aConfidence;
  vPulsePhase = aPulsePhase;
  vFocus = aFocus;
  vHidden = aHidden;
  vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
  // TubeGeometry generates outward-facing normals, perfect for fresnel.
  vNormalView = normalize(normalMatrix * normal);
  vViewDir = normalize(-mvPosition.xyz);
  gl_Position = projectionMatrix * mvPosition;
  #include <fog_vertex>
}
`;

const FRAGMENT_SHADER = /* glsl */ `
#include <common>
#include <fog_pars_fragment>

uniform float uTime;

varying vec2 vUv;
varying vec3 vColor;
varying float vDirection;
varying float vFlowSpeed;
varying float vFlowDensity;
varying float vConfidence;
varying float vPulsePhase;
varying float vFocus;
varying float vHidden;
varying vec3 vNormalView;
varying vec3 vViewDir;

float pulse(float t) {
  // Narrow bright head with a soft trailing fade — same shape on both
  // sides of the apex so symmetric counter-flow reads cleanly.
  return smoothstep(0.0, 0.05, t) * (1.0 - smoothstep(0.05, 0.20, t));
}

void main() {
  if (vHidden > 0.5) discard;
  // Base tube glow, scaled by confidence so low-trust edges fade back.
  // Phase 8 lifted from 0.22 + 0.40*conf so non-flow midtones of tubes
  // stay visible after the AA / tone-mapping chain darkened the buffer.
  // The hue-preserving roll-off below still prevents dense-hub blowout.
  float baseI = 0.30 + 0.50 * vConfidence;
  vec3 base = vColor * baseI;

  float flow;
  if (abs(vDirection) < 0.5) {
    // Bilateral: two opposing waves layered.
    float a = fract(vUv.x * vFlowDensity - uTime * vFlowSpeed + vPulsePhase);
    float b = fract(vUv.x * vFlowDensity + uTime * vFlowSpeed + vPulsePhase);
    flow = max(pulse(a), pulse(b));
  } else {
    float t = fract(vUv.x * vFlowDensity - uTime * vFlowSpeed * vDirection + vPulsePhase);
    flow = pulse(t);
  }

  // Bright pulse on top of the base — ride the per-edge colour ONLY,
  // no achromatic white-add. The previous "+ vec3(flow * 0.25)" term
  // was bleeding hue out of dense clusters, turning green hubs white.
  vec3 col = base + vColor * flow * 1.05;

  // Fresnel rim — lifts the tube silhouette so it reads as a translucent
  // glass conduit. Coloured-only (no white add) for the same reason as
  // the flow term: keep edges green/blue/etc. through tone mapping.
  float NoV = clamp(dot(normalize(vNormalView), normalize(vViewDir)), 0.0, 1.0);
  float fresnel = pow(1.0 - NoV, 2.4);
  col += vColor * fresnel * 0.40;

  // Focus dimming — pre-fog so dimmed edges also sink into the haze.
  col *= mix(${DEFAULT_DIMMED_FOCUS.toFixed(3)}, 1.0, vFocus);

  // Soft hue-preserving roll-off so additive overlap in dense hubs
  // tapers toward (but never reaches) saturation. Each pixel is still
  // bright; we just stop runaway clipping to flat white.
  float peak = max(max(col.r, col.g), col.b);
  col = col / (1.0 + 0.55 * peak);

  // Alpha rises with the flow head + rim so dim trails don't pile up
  // to opaque but silhouettes still hold against the dark scene.
  // Capped lower than before — the additive accumulation in dense hubs
  // was the main blowout source.
  float alpha = 0.12 + 0.42 * flow + 0.16 * fresnel;
  alpha *= mix(0.4, 1.0, vFocus);

  gl_FragColor = vec4(col, alpha);

  // Phase 6 — atmospheric distance attenuation in place of stock
    // mix-to-fog-colour. With additive blending, mixing toward the near-
    // black background literally subtracts the contribution and far tubes
    // vanish into the void. Instead we apply a gentle intensity falloff
    // with a hue-preserving floor so distant edges keep their colour and
    // a faint glow even at the far rim — atmospheric haze, not blackout.
    // Phase 8 raised the far-distance brightness floor (0.55 → 0.70) and
    // emissive floor (0.05 → 0.07) so distant structure stays clearly
    // legible in the brighter scene.
  #ifdef USE_FOG
    float fogFactor = smoothstep(fogNear, fogFar, vFogDepth);
    float atten = mix(1.0, 0.70, fogFactor);
    gl_FragColor.rgb *= atten;
    gl_FragColor.rgb += vColor * fogFactor * 0.07;
    gl_FragColor.a *= mix(1.0, 0.72, fogFactor);
  #endif
}
`;

export class TubeSystem {
  readonly mesh: Mesh;

  private readonly material: ShaderMaterial;
  private geometry: BufferGeometry;
  private readonly splines: SplineSet;
  private edgeRanges: EdgeColorRange[] = [];
  private edgeMetas: EdgeMeta[] = [];
  /** Adjacency derived from edges, used for focus BFS. */
  private adjacency = new Map<string, Set<string>>();

  constructor(splines: SplineSet) {
    this.splines = splines;
    this.material = new ShaderMaterial({
      uniforms: UniformsUtils.merge([
        UniformsLib.fog,
        { uTime: { value: 0 } },
      ]),
      vertexShader: VERTEX_SHADER,
      fragmentShader: FRAGMENT_SHADER,
      transparent: true,
      depthWrite: false,
      blending: AdditiveBlending,
      vertexColors: true,
      fog: true,
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
    const metas: EdgeMeta[] = [];
    let cursor = 0;
    for (const meta of this.splines.metas) {
      const curve = this.splines.curves[meta.index];
      const style = EDGE_STYLES[meta.kind];
      const motion = KIND_MOTION[meta.kind];
      // Radius scales with the 2D edge size and confidence.
      const radius = 0.06 + style.size * 0.05 + meta.conf * 0.06;
      const tube = new TubeGeometry(
        curve,
        TUBULAR_SEGMENTS,
        radius,
        RADIAL_SEGMENTS,
        false,
      );
      tmpColor.set(style.color);
      const intensity = 0.55 + 0.45 * meta.conf;
      const baseR = tmpColor.r * intensity;
      const baseG = tmpColor.g * intensity;
      const baseB = tmpColor.b * intensity;
      const vCount = tube.getAttribute("position").count;

      // Per-vertex (constant per edge) attributes.
      const colors = new Float32Array(vCount * 3);
      const aDir = new Float32Array(vCount);
      const aSpeed = new Float32Array(vCount);
      const aDensity = new Float32Array(vCount);
      const aConf = new Float32Array(vCount);
      const aPhase = new Float32Array(vCount);
      const aFocus = new Float32Array(vCount);
      const aHidden = new Float32Array(vCount);
      // Deterministic per-edge phase offset so flows aren't synchronised.
      const phase = pseudoRandom(meta.s + ":" + meta.t + ":" + meta.kind);
      for (let v = 0; v < vCount; v++) {
        colors[v * 3 + 0] = baseR;
        colors[v * 3 + 1] = baseG;
        colors[v * 3 + 2] = baseB;
        aDir[v] = motion.direction;
        aSpeed[v] = motion.speed;
        aDensity[v] = motion.density;
        aConf[v] = meta.conf;
        aPhase[v] = phase;
        aFocus[v] = 1; // default: full intensity until selection dims.
        aHidden[v] = 0; // default: shown until a filter hides this edge.
      }
      tube.setAttribute("color", new BufferAttribute(colors, 3));
      tube.setAttribute("aDirection", new BufferAttribute(aDir, 1));
      tube.setAttribute("aFlowSpeed", new BufferAttribute(aSpeed, 1));
      tube.setAttribute("aFlowDensity", new BufferAttribute(aDensity, 1));
      tube.setAttribute("aConfidence", new BufferAttribute(aConf, 1));
      tube.setAttribute("aPulsePhase", new BufferAttribute(aPhase, 1));
      tube.setAttribute("aFocus", new BufferAttribute(aFocus, 1));
      tube.setAttribute("aHidden", new BufferAttribute(aHidden, 1));

      parts.push(tube);
      ranges.push({ start: cursor, count: vCount, baseR, baseG, baseB });
      metas.push({ s: meta.s, t: meta.t, kind: meta.kind });
      cursor += vCount;
    }

    // Free the previous geometry before swapping.
    this.geometry.dispose();
    if (parts.length === 0) {
      this.geometry = new BufferGeometry();
    } else {
      const merged = mergeGeometries(parts, false);
      this.geometry = merged ?? new BufferGeometry();
      for (const p of parts) p.dispose();
    }
    this.mesh.geometry = this.geometry;
    this.edgeRanges = ranges;
    this.edgeMetas = metas;

    // Refresh adjacency for focus walks.
    this.adjacency.clear();
    for (const m of metas) {
      let a = this.adjacency.get(m.s);
      if (!a) { a = new Set(); this.adjacency.set(m.s, a); }
      a.add(m.t);
      let b = this.adjacency.get(m.t);
      if (!b) { b = new Set(); this.adjacency.set(m.t, b); }
      b.add(m.s);
    }
  }

  /** Advance the shader clock; call once per frame from the render loop. */
  setTime(seconds: number): void {
    this.material.uniforms["uTime"].value = seconds;
  }

  /** Vertex offsets for each edge, exposed for tests + heatmap callers. */
  getEdgeRanges(): readonly EdgeColorRange[] {
    return this.edgeRanges;
  }

  /** Edge metadata (endpoints + kind) parallel to `getEdgeRanges()`. */
  getEdgeMetas(): readonly EdgeMeta[] {
    return this.edgeMetas;
  }

  /**
   * Hide edges where the predicate returns false. Pass `null` to show
   * everything. Updates only the `aHidden` attribute — the geometry,
   * colours, and focus state are preserved across toggles.
   */
  setVisibilityFilter(pred: ((meta: EdgeMeta) => boolean) | null): void {
    const attr = this.geometry.getAttribute("aHidden");
    if (!attr) return;
    const arr = attr.array as Float32Array;
    for (let i = 0; i < this.edgeRanges.length; i++) {
      const r = this.edgeRanges[i];
      const m = this.edgeMetas[i];
      const hide = pred ? !pred(m) : false;
      const v = hide ? 1 : 0;
      const end = r.start + r.count;
      for (let j = r.start; j < end; j++) arr[j] = v;
    }
    (attr as BufferAttribute).needsUpdate = true;
  }

  /**
   * Recolor tubes by per-node heat. Pass `null` (or a 0 maxCount) to
   * restore base colors. Edge heat is `max(node_heat[s], node_heat[t]) /
   * max_count`.
   */
  applyHeatmap(nodeHeat: Map<string, number> | null, maxCount: number): void {
    const colorAttr = this.geometry.getAttribute("color");
    if (!colorAttr) return;
    const arr = colorAttr.array as Float32Array;
    const denom = maxCount > 0 ? maxCount : 1;
    const ranges = this.edgeRanges;
    const metas = this.edgeMetas;
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

  /**
   * Walk the edge graph from `selectedId` up to `hops` hops and return
   * the set of node ids that should remain in focus. Returns null when
   * focus mode is disabled (no selection or zero hops).
   */
  computeFocusSet(selectedId: string | null, hops: number): Set<string> | null {
    if (!selectedId || hops <= 0) return null;
    const inFocus = new Set<string>([selectedId]);
    let frontier: string[] = [selectedId];
    for (let h = 0; h < hops; h++) {
      const next: string[] = [];
      for (const id of frontier) {
        const nb = this.adjacency.get(id);
        if (!nb) continue;
        for (const o of nb) {
          if (!inFocus.has(o)) {
            inFocus.add(o);
            next.push(o);
          }
        }
      }
      if (next.length === 0) break;
      frontier = next;
    }
    return inFocus;
  }

  /**
   * Highlight edges within `hops` of `selectedId`. Pass `null` to restore
   * full intensity on every edge.
   */
  setFocus(selectedId: string | null, hops: number): void {
    const focusAttr = this.geometry.getAttribute("aFocus");
    if (!focusAttr) return;
    const arr = focusAttr.array as Float32Array;
    const ranges = this.edgeRanges;
    const metas = this.edgeMetas;

    const inFocus = this.computeFocusSet(selectedId, hops);
    if (!inFocus) {
      for (let i = 0; i < arr.length; i++) arr[i] = 1;
      (focusAttr as BufferAttribute).needsUpdate = true;
      return;
    }

    for (let i = 0; i < ranges.length; i++) {
      const r = ranges[i];
      const m = metas[i];
      // An edge is "in focus" iff both endpoints are reachable. With 2-hop
      // focus this lights up the selected node, its neighbours, and the
      // edges between those neighbours.
      const inEdge = inFocus.has(m.s) && inFocus.has(m.t);
      const value = inEdge ? 1 : 0;
      const end = r.start + r.count;
      for (let v = r.start; v < end; v++) arr[v] = value;
    }
    (focusAttr as BufferAttribute).needsUpdate = true;
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

/** Cheap deterministic FNV-1a → unit float in [0, 1). */
function pseudoRandom(s: string): number {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0) / 0xffffffff;
}
