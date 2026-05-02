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
  InstancedBufferAttribute,
  InstancedMesh,
  type BufferGeometry,
  NormalBlending,
  Object3D,
  OctahedronGeometry,
  Raycaster,
  type Scene,
  ShaderMaterial,
  TetrahedronGeometry,
  TorusGeometry,
  UniformsLib,
  UniformsUtils,
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
  material: ShaderMaterial;
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
  /**
   * Optional focus set (Slice F2). When non-null, instances NOT in this
   * set are dimmed via a per-instance color multiplier so the eye is
   * drawn to the selected node and its 2-hop neighbourhood.
   */
  private focusSet: Set<string> | null = null;
  /**
   * Optional visibility predicate. When set, instances rejected by the
   * predicate are scaled to zero AND skipped during raycast so filtered
   * nodes don't intercept clicks meant for visible neighbours.
   */
  private visiblePredicate: ((meta: NodeInstanceMeta) => boolean) | null = null;

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
      // Slice G: glass material. Each bucket gets its own ShaderMaterial
      // clone so dispose() can free them independently, but they all
      // share the same vertex/fragment programs (three.js compiles per
      // unique shader source, so the GPU keeps a single program object).
      const material = makeGlassMaterial();
      const mesh = new InstancedMesh(geometry, material, group.length);
      mesh.frustumCulled = false;
      // Userdata lets the raycast loop map a hit back to a node id without
      // reverse-searching every meta list.
      mesh.userData["nodeBucketType"] = type;

      // Per-instance visibility flag (1 = visible, 0 = hidden by filter).
      // Stored separately from the matrix so we can toggle it without
      // recomputing positions, and respected in raycast() to skip hidden
      // hits that the scaled-to-zero matrix would otherwise still report.
      const visibleAttr = new InstancedBufferAttribute(new Float32Array(group.length), 1);
      for (let i = 0; i < group.length; i++) visibleAttr.setX(i, 1);
      mesh.geometry.setAttribute("aVisible", visibleAttr);

      const metas: NodeInstanceMeta[] = [];
      for (let i = 0; i < group.length; i++) {
        const n = group[i];
        const radius = nodeRadius(n);
        const baseColor = new Color(nodeRenderColor(n.type, n.health));
        // Push per-type colors into vivid-but-elegant territory so node
        // hues read distinctly against the dark background and the tube
        // palette. Phase 9 dialled saturation back from a +0.50 boost
        // with floor 0.62 to a +0.30 boost with floor 0.55 — colours
        // remain clearly identifiable per type but no longer push toward
        // neon. Lightness floor lifted slightly (0.42 → 0.46) to keep
        // midtones readable.
        {
          const hsl = { h: 0, s: 0, l: 0 };
          baseColor.getHSL(hsl);
          const s = Math.min(0.92, Math.max(hsl.s, 0.55) + 0.30);
          const l = Math.min(0.78, Math.max(hsl.l, 0.46));
          baseColor.setHSL(hsl.h, s, l);
        }
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
      // CRITICAL for selection: InstancedMesh raycast uses boundingSphere
      // for an early-out, but the auto-computed sphere only reflects the
      // *initial* matrix layout (everything at origin). Once nodes spread
      // out the sphere stays tiny and rays past the origin miss every
      // instance — nodes appear unselectable.
      bucket.mesh.computeBoundingSphere();
    }
  }

  /**
   * Highlight a focus subset (Slice F2). Pass `null` to clear focus and
   * restore every instance to full intensity.
   */
  setFocus(focusSet: Set<string> | null): void {
    this.focusSet = focusSet;
    for (const meta of this.metas) this.writeInstance(meta);
    for (const bucket of this.buckets.values()) {
      if (bucket.mesh.instanceColor) bucket.mesh.instanceColor.needsUpdate = true;
    }
  }

  /**
   * Apply (or clear) a visibility predicate. Hidden instances scale to
   * zero and are skipped by raycast. Pass `null` to show everything.
   */
  setVisibilityFilter(pred: ((meta: NodeInstanceMeta) => boolean) | null): void {
    this.visiblePredicate = pred;
    for (const meta of this.metas) this.writeInstance(meta);
    for (const bucket of this.buckets.values()) {
      bucket.mesh.instanceMatrix.needsUpdate = true;
      const va = bucket.mesh.geometry.getAttribute("aVisible") as InstancedBufferAttribute | undefined;
      if (va) va.needsUpdate = true;
      bucket.mesh.computeBoundingSphere();
    }
  }

  /** True iff this node is currently shown by the active filter. */
  isVisible(id: string): boolean {
    const meta = this.indexById.get(id);
    if (!meta) return false;
    if (!this.visiblePredicate) return true;
    return this.visiblePredicate(meta);
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
        const meta = bucket.metas[h.instanceId];
        if (!meta) continue;
        // Filtered-out nodes are scaled to zero but `intersectObject` can
        // still report the degenerate triangle as a hit; skip them so the
        // click falls through to whatever's actually visible behind.
        if (this.visiblePredicate && !this.visiblePredicate(meta)) continue;
        if (!best || h.distance < best.distance) {
          best = { id: meta.id, distance: h.distance };
        }
      }
    }
    return best;
  }

  addTo(scene: Scene): void {
    for (const bucket of this.buckets.values()) scene.add(bucket.mesh);
  }

  /** Advance the glass shader clock; call once per frame from the render loop. */
  setTime(seconds: number): void {
    for (const bucket of this.buckets.values()) {
      bucket.material.uniforms["uTime"].value = seconds;
    }
  }

  /**
   * Multiply rim/emissive strength by `factor` (1.0 = baseline). Used by
   * photo-mode capture to crank the glass highlights for the saved PNG
   * without touching the live interactive look. Pass 1.0 to restore.
   */
  setRimBoost(factor: number): void {
    for (const bucket of this.buckets.values()) {
      bucket.material.uniforms["uRimStrength"].value = BASE_RIM_STRENGTH * factor;
      bucket.material.uniforms["uEmissiveStrength"].value = BASE_EMISSIVE * factor;
    }
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
    const visible = !this.visiblePredicate || this.visiblePredicate(meta);
    const baseScale =
      meta.radius * (isSelected ? SELECT_SCALE : isHovered ? HOVER_SCALE : 1);
    const scale = visible ? baseScale : 0;

    this.proxy.position.set(meta.x, meta.y, meta.z);
    this.proxy.scale.setScalar(scale);
    this.proxy.updateMatrix();
    bucket.mesh.setMatrixAt(meta.index, this.proxy.matrix);

    // Mirror visibility into the per-instance attribute so the fresnel
    // shader can fade the colour out smoothly even though the geometry
    // is collapsed (mostly belt-and-braces — zero-scale already culls).
    const va = bucket.mesh.geometry.getAttribute("aVisible") as InstancedBufferAttribute | undefined;
    if (va) va.setX(meta.index, visible ? 1 : 0);

    if (isSelected || isHovered) {
      // Brighten by tinting toward white via the per-instance color.
      this.tmpColor.copy(meta.baseColor).multiplyScalar(HIGHLIGHT_TINT);
      // Three's Color clamps on read but not on multiplyScalar — clamp now
      // so HDR-bound bloom doesn't blow it past meaningful thresholds.
      this.tmpColor.r = Math.min(this.tmpColor.r, 1);
      this.tmpColor.g = Math.min(this.tmpColor.g, 1);
      this.tmpColor.b = Math.min(this.tmpColor.b, 1);
    } else {
      this.tmpColor.copy(meta.baseColor);
    }
    // Apply Slice F2 focus dimming on top of the highlight tint so the
    // selected/hovered node still pops while the rest of the graph fades.
    if (this.focusSet && !this.focusSet.has(meta.id)) {
      this.tmpColor.multiplyScalar(0.18);
    }
    bucket.mesh.setColorAt(meta.index, this.tmpColor);
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

// ─── Glass material (Slice G) ──────────────────────────────────────────
//
// Custom ShaderMaterial that gives nodes a translucent "glass architecture"
// look: faint inner body, strong fresnel rim, subtle emissive glow tinted
// by the per-instance colour. Designed to share the program across all
// node-type buckets — three.js compiles per source string, so we pay the
// link cost once even though each bucket holds its own clone for safe
// independent disposal.
//
// Uniforms:
//   uTime              — seconds, drives selection pulse if needed.
//   uOpacity           — base translucency (0..1).
//   uEmissiveStrength  — internal glow multiplier on per-instance colour.
//   uRimStrength       — fresnel highlight multiplier.
//   uRimPower          — fresnel exponent (higher = thinner rim).
//   uRimColor          — tint for the rim highlight (cool white default).
//
// We rely on three.js auto-injecting `instanceMatrix` and `instanceColor`
// when the mesh is an InstancedMesh with `instanceColor` set, so the
// vertex shader just references them under the matching `#define`s.

// Phase 6 — engineered glass / crystal pass.
// Phase 8 lifted opacity + emissive floor a touch so non-highlighted
// nodes carry visible presence after the AA chain darkened midtones.
// Rim/specular untouched (highlights already preserved by ACES).
const BASE_OPACITY = 0.62;
const BASE_EMISSIVE = 0.20;
const BASE_RIM_STRENGTH = 1.05;
const BASE_RIM_POWER = 2.8;

const NODE_VERTEX_SHADER = /* glsl */ `
#include <common>
#include <fog_pars_vertex>

attribute float aVisible;

varying vec3 vColor;
varying vec3 vNormalView;
varying vec3 vViewDir;
varying float vVisible;
// Phase 6 — per-instance scale (~node radius) so the fragment shader
// can dial up crystalline detail (sharper rim, specular, internal
// depth gradient) on large nodes without changing small-node read.
varying float vSize;
// Object-space position (unit-ish, since geometries are unit-sized).
// Used to drive a subtle vertical depth gradient inside large nodes.
varying vec3  vObjPos;

void main() {
  vVisible = aVisible;
  vObjPos = position;

  #ifdef USE_INSTANCING_COLOR
    vColor = instanceColor;
  #else
    vColor = vec3(1.0);
  #endif

  vec3 transformed = position;
  vec3 transformedNormal = normal;
  #ifdef USE_INSTANCING
    mat3 im = mat3(instanceMatrix);
    transformed = (instanceMatrix * vec4(position, 1.0)).xyz;
    transformedNormal = im * normal;
    // Average column length ≈ uniform scale (we only use uniform scale
    // upstream). Cheaper than a full svd and accurate for our case.
    vSize = (length(im[0]) + length(im[1]) + length(im[2])) / 3.0;
  #else
    vSize = 1.0;
  #endif

  vec4 mvPosition = modelViewMatrix * vec4(transformed, 1.0);
  vNormalView = normalize(normalMatrix * transformedNormal);
  vViewDir = normalize(-mvPosition.xyz);
  gl_Position = projectionMatrix * mvPosition;
  #include <fog_vertex>
}
`;

const NODE_FRAGMENT_SHADER = /* glsl */ `
#include <common>
#include <fog_pars_fragment>

uniform float uTime;
uniform float uOpacity;
uniform float uEmissiveStrength;
uniform float uRimStrength;
uniform float uRimPower;
uniform vec3  uRimColor;

varying vec3  vColor;
varying vec3  vNormalView;
varying vec3  vViewDir;
varying float vVisible;
varying float vSize;
varying vec3  vObjPos;

void main() {
  if (vVisible < 0.5) discard;

  vec3 N = normalize(vNormalView);
  vec3 V = normalize(vViewDir);
  float NoV = clamp(dot(N, V), 0.0, 1.0);

  // 0 → small leaf nodes (radius ~0.6), 1 → big hubs (radius ~1.6+).
  // Drives crystal-only embellishments so small nodes stay simple and
  // large nodes pick up specular, depth gradient, and a sharper rim.
  float largeWeight = smoothstep(0.95, 1.6, vSize);

  // Body — face/edge contrast tuned for readability over drama. Phase 9
  // lifted the dark face term (0.32 → 0.40) and softened the face
  // brighten (0.46 → 0.36) so unlit sides stay legible and lit sides
  // don't push midtones into a high-contrast cinematic look.
  float facing = pow(NoV, 0.70);
  vec3 body = vColor * (0.40 + 0.36 * facing);

  // Internal depth gradient (large nodes only) — fakes a refractive
  // top-to-bottom shift inside the volume. Phase 9 narrowed the
  // gradient (0.84–1.18 → 0.92–1.10) so large hubs read as gentle
  // glass volumes rather than high-contrast jewels.
  float vertical = clamp(vObjPos.y * 0.5 + 0.5, 0.0, 1.0);
  float depthGrad = mix(0.92, 1.10, vertical);
  body *= mix(1.0, depthGrad, largeWeight);

  // Internal emissive — tinted by instance colour so each node type
  // glows in its own hue. Trimmed slightly inside large nodes so the
  // body reads cleaner / less hazy; small nodes keep full emissive.
  vec3 emissive = vColor * uEmissiveStrength * mix(1.0, 0.85, largeWeight);

  // Fresnel rim — pow(1 - N·V). Sharpens (higher exponent) and
  // brightens on large nodes so corners and edges of crystals catch
  // light the way real glass does. Small nodes keep the gentler rim.
  float rimPow = mix(uRimPower, uRimPower + 0.6, largeWeight);
  float fresnel = pow(1.0 - NoV, rimPow);
  float rimMul = mix(uRimStrength, uRimStrength * 1.20, largeWeight);
  vec3  rimTint = mix(uRimColor, vColor + vec3(0.20), 0.55);
  vec3  rim = rimTint * fresnel * rimMul;

  // Specular — Blinn-Phong half-vector against a fixed view-space key
  // light direction (matches the world-space key light in scene.ts
  // closely enough for a stylised highlight). Tight exponent so the
  // hot spot is small, and only enabled on large nodes so leaves don't
  // sparkle and the dense-hub blowout problem doesn't return.
  vec3 L = normalize(vec3(0.40, 0.70, 0.60));
  vec3 H = normalize(L + V);
  float specTerm = pow(max(dot(N, H), 0.0), 72.0);
  vec3  specular = vec3(specTerm) * (0.55 * largeWeight);

  vec3 outCol = body + emissive + rim;
  // Soft hue-preserving roll-off — divides by (1 + maxChannel) so peaks
  // taper toward (but never reach) 1.0 while preserving the colour
  // ratio. Keeps blue nodes blue-hot, gold nodes gold-hot, etc., even
  // before tone mapping kicks in downstream.
  float peak = max(max(outCol.r, outCol.g), outCol.b);
  outCol = outCol / (1.0 + 0.45 * peak);
  // Specular sits on top of the roll-off so the highlight stays sharp
  // and white. ACES tone mapping downstream prevents it from clipping
  // even though it can briefly push channels above 1.0.
  outCol += specular;

  // Glass alpha — translucent body + rim alpha boost so silhouettes
  // remain crisp even when the body is faint. Slight per-size lift
  // keeps large hubs reading as solid volumes; clamped so additive
  // bloom on top doesn't chase past 1.0 and turn glass into milk.
  float alpha = uOpacity + fresnel * 0.34 + 0.06 * largeWeight;
  alpha = clamp(alpha, 0.0, 0.95);

  gl_FragColor = vec4(outCol, alpha);
  #include <fog_fragment>
}
`;

function makeGlassMaterial(): ShaderMaterial {
  return new ShaderMaterial({
    uniforms: UniformsUtils.merge([
      UniformsLib.fog,
      {
        uTime:             { value: 0 },
        uOpacity:          { value: BASE_OPACITY },
        uEmissiveStrength: { value: BASE_EMISSIVE },
        uRimStrength:      { value: BASE_RIM_STRENGTH },
        uRimPower:         { value: BASE_RIM_POWER },
        uRimColor:         { value: new Color(0xc8e4ff) },
      },
    ]),
    vertexShader: NODE_VERTEX_SHADER,
    fragmentShader: NODE_FRAGMENT_SHADER,
    transparent: true,
    depthWrite: false,
    depthTest: true,
    blending: NormalBlending,
    fog: true,
  });
}
