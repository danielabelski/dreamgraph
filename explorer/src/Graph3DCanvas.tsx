/**
 * DreamGraph Explorer — 3D canvas (Slice D: polish + interaction).
 *
 * plans/EXPLORER_3D_MODE.md §12.D
 *
 * Slice D additions on top of Slice C:
 *   - Per-type node shapes (in `NodeSystem`).
 *   - Hover + click picking via Raycaster on the InstancedMesh buckets,
 *     wired to the same selection state the 2D canvas uses.
 *   - `UnrealBloomPass` post-processing (toggleable).
 *   - `prefers-reduced-motion` honored for particle motion.
 *   - Keyboard shortcuts: B (bloom), Space (pause particles), G (grid),
 *     R (reset camera), F (frame all), Esc (clear selection).
 *
 * Out of scope for v1: SSE pulse bursts, cycle-wave sphere, GPU shader
 * picking, label sprites — see the plan §3.2.4–§3.2.6.
 */

import { useEffect, useRef } from "react";
import {
  AdditiveBlending,
  Box3,
  CanvasTexture,
  Color,
  Raycaster,
  Sprite,
  SpriteMaterial,
  SRGBColorSpace,
  Vector2,
  Vector3,
  WebGLRenderTarget,
  type PerspectiveCamera,
} from "three";
import {
  fetchHeatmap,
  patchExplorerPrefs,
  type ExplorerPrefs,
  type HeatmapResult,
} from "./api";
import type { GraphSnapshot } from "./types";
import type { ExplorerNodeType as ExplorerNodeTypeAlias } from "./types";
import type { GraphEvent } from "./sse";
import { createScene, hasWebGL2, tuneSceneForBounds } from "./three/scene";
import { LayoutBridge } from "./three/layout3d";
import { Minimap3D } from "./three/Minimap3D";
import { NodeSystem } from "./three/NodeSystem";
import { SplineSet } from "./three/splines";
import { TubeSystem } from "./three/TubeSystem";
import { WavefrontSystem } from "./three/WavefrontSystem";
import { DensityHaze } from "./three/DensityHaze";
import { LabelOverlay } from "./three/LabelOverlay";
import type { FilterState } from "./filters";
import { defaultFilters } from "./filters";

interface Graph3DCanvasProps {
  prefs: ExplorerPrefs;
  snapshot: GraphSnapshot;
  /** Currently selected node id (lifted from `App`, shared with 2D mode). */
  selected?: string | null;
  /** Click handler — same shape as `GraphCanvas.onSelect`. */
  onSelect?: (nodeId: string | null) => void;
  /**
   * Live SSE stream from the daemon. Used to spawn wavefronts on
   * `dream.cycle.completed` and could power per-node pulses in a
   * follow-up. The newest event is at index 0; we only act on the head.
   */
  liveEvents?: GraphEvent[];
  /** Sidebar visibility filters — parity with 2D mode. */
  filters?: FilterState;
  /** Surface a fatal init error to the parent so it can fall back to 2D. */
  onFatal?: (message: string) => void;
}

export default function Graph3DCanvas({
  prefs,
  snapshot,
  selected,
  onSelect,
  liveEvents,
  filters,
  onFatal,
}: Graph3DCanvasProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  // Latest values in refs so the long-lived effect can read them without
  // tearing down the scene on every prop change.
  const prefsRef = useRef(prefs);
  prefsRef.current = prefs;
  const snapshotRef = useRef(snapshot);
  snapshotRef.current = snapshot;
  const filtersRef = useRef<FilterState>(filters ?? defaultFilters());
  filtersRef.current = filters ?? defaultFilters();
  const selectedRef = useRef<string | null>(selected ?? null);
  const onSelectRef = useRef(onSelect);
  onSelectRef.current = onSelect;
  const statusRef = useRef<HTMLDivElement | null>(null);
  /** Imperative handle filled in by the mount effect; null until then. */
  const apiRef = useRef<{
    setSelected(id: string | null): void;
    triggerWave(color?: number | string): void;
    applyFilters(): void;
  } | null>(null);

  // Push selection updates from React → renderer without re-mounting.
  useEffect(() => {
    selectedRef.current = selected ?? null;
    apiRef.current?.setSelected(selected ?? null);
  }, [selected]);

  // Push filter updates without re-mounting the scene. The renderer
  // applies them via per-instance scale + per-vertex hide attributes.
  useEffect(() => {
    apiRef.current?.applyFilters();
  }, [filters]);

  // Trigger a wavefront whenever a new dream.cycle.completed event
  // arrives. We key off the seq of the head event so a stable list
  // doesn't re-fire on every render.
  const lastWaveSeqRef = useRef<number>(0);
  useEffect(() => {
    if (!liveEvents || liveEvents.length === 0) return;
    const head = liveEvents[0];
    if (head.kind !== "dream.cycle.completed") return;
    if (head.seq <= lastWaveSeqRef.current) return;
    lastWaveSeqRef.current = head.seq;
    apiRef.current?.triggerWave(0xa0dcff);
  }, [liveEvents]);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    if (!hasWebGL2()) {
      onFatal?.("WebGL2 not available on this device — falling back to 2D.");
      return;
    }

    let disposed = false;
    let raf = 0;
    let cleanup: (() => void) | null = null;

    (async () => {
      const [{ OrbitControls }, composerMod, renderPassMod, bloomMod, smaaMod] =
        await Promise.all([
          import("three/examples/jsm/controls/OrbitControls.js") as Promise<
            typeof import("three/examples/jsm/controls/OrbitControls.js")
          >,
          import("three/examples/jsm/postprocessing/EffectComposer.js") as Promise<
            typeof import("three/examples/jsm/postprocessing/EffectComposer.js")
          >,
          import("three/examples/jsm/postprocessing/RenderPass.js") as Promise<
            typeof import("three/examples/jsm/postprocessing/RenderPass.js")
          >,
          import("three/examples/jsm/postprocessing/UnrealBloomPass.js") as Promise<
            typeof import("three/examples/jsm/postprocessing/UnrealBloomPass.js")
          >,
          import("three/examples/jsm/postprocessing/SMAAPass.js") as Promise<
            typeof import("three/examples/jsm/postprocessing/SMAAPass.js")
          >,
        ]);

      if (disposed) return;

      // Detect whether the user has actually moved the camera in a prior
      // session — the seed default is `[40,24,40] / [0,0,0]`. If those are
      // still in effect we'll fit the whole cloud on first paint instead
      // of showing the tiny default viewpoint, which only ever suits the
      // ~10-node sample graph.
      const _camPos = prefsRef.current.camera3d.position;
      const _camTgt = prefsRef.current.camera3d.target;
      const hasSavedCamera = !(
        _camPos[0] === 40 && _camPos[1] === 24 && _camPos[2] === 40 &&
        _camTgt[0] === 0 && _camTgt[1] === 0 && _camTgt[2] === 0
      );

      const bundle = createScene({
        container,
        cameraPosition: prefsRef.current.camera3d.position,
        cameraTarget: prefsRef.current.camera3d.target,
        showGrid: prefsRef.current.showGrid3d,
      });

      const controls = new OrbitControls(bundle.camera, bundle.renderer.domElement);
      controls.enableDamping = true;
      controls.dampingFactor = 0.08;
      // OrbitControls' keyboard pan is opt-in via `listenToKeyEvents()` —
      // we never call it, so the camera doesn't move from key presses
      // even before the input-focus guard kicks in.
      controls.target.set(...prefsRef.current.camera3d.target);
      controls.update();

      // Build the renderable graph from the current snapshot.
      const snap = snapshotRef.current;
      const nodeSystem = new NodeSystem(snap.nodes);
      const splines = new SplineSet(snap.nodes, snap.edges);
      const tubeSystem = new TubeSystem(splines);
      const wavefrontSystem = new WavefrontSystem();
      const densityHaze = new DensityHaze(snap.nodes.length);
      const labelOverlay = new LabelOverlay(container);
      densityHaze.addTo(bundle.scene);
      nodeSystem.addTo(bundle.scene);
      tubeSystem.addTo(bundle.scene);
      wavefrontSystem.addTo(bundle.scene);

      // Selected-node backglow halo — a camera-facing sprite with a
      // soft radial gradient so the glow has feathered edges (a solid
      // sphere produces a hard-edged disc when fog/blend can't fade it).
      // Additive blending lets it brighten anything behind it without
      // occluding tubes or other nodes.
      const haloCanvas = document.createElement("canvas");
      haloCanvas.width = 256;
      haloCanvas.height = 256;
      {
        const ctx = haloCanvas.getContext("2d");
        if (ctx) {
          const grd = ctx.createRadialGradient(128, 128, 0, 128, 128, 128);
          // Phase 7 — softer, less-white core. Previous core was a near
          // pure-white dot that, after bloom, presented as a flashlight
          // bulb on top of hubs. We pull the core toward blue-cyan and
          // drop its opacity ~12% so the bloom rays still read as a halo
          // around an energetic nucleus instead of a hot white blob.
          // Outer mid + rim stops are unchanged so the blue bloom rays
          // and feathered falloff stay intact.
          grd.addColorStop(0.0, "rgba(170, 215, 252, 0.86)");
          grd.addColorStop(0.18, "rgba(155, 205, 252, 0.62)");
          grd.addColorStop(0.55, "rgba(110, 180, 245, 0.18)");
          grd.addColorStop(1.0, "rgba(80, 150, 220, 0.0)");
          ctx.fillStyle = grd;
          ctx.fillRect(0, 0, 256, 256);
        }
      }
      const haloTex = new CanvasTexture(haloCanvas);
      haloTex.needsUpdate = true;
      const haloMat = new SpriteMaterial({
        map: haloTex,
        color: new Color(0xa8d8ff),
        transparent: true,
        // Phase 9 — reduced halo opacity ~20% (0.95 → 0.76) so the
        // selected-node glow is a clear focus indicator instead of
        // dominating the whole scene.
        opacity: 0.76,
        depthWrite: false,
        depthTest: true,
        blending: AdditiveBlending,
        toneMapped: false,
      });
      const haloMesh = new Sprite(haloMat);
      haloMesh.visible = false;
      // Render after tubes/nodes so the halo blends on top.
      haloMesh.renderOrder = 5;
      bundle.scene.add(haloMesh);
      const updateHaloFor = (id: string | null): void => {
        if (!id) {
          haloMesh.visible = false;
          return;
        }
        const pos = nodeSystem.getPosition(id);
        if (!pos) {
          haloMesh.visible = false;
          return;
        }
        // Size the halo to the visible node radius times a constant so it
        // protrudes a bit beyond the geometry without dominating it.
        const node = snap.nodes[nodeIndexById.get(id) ?? -1];
        const degree = node?.degree ?? 0;
        const r = node ? Math.max(1.4, 0.6 + Math.log1p(degree) * 0.45 + 0.25 * node.confidence) : 1.4;
        haloMesh.position.set(pos.x, pos.y, pos.z);
        // Phase 9 — selected-node glow trimmed ~20%. The halo size and
        // opacity were dialled back so the glow remains a clear focus
        // signal without dominating the surrounding graph.
        //   degree  0 → scale ≈ 5.6,  opacity ≈ 0.78 (tight, calmer)
        //   degree 10 → scale ≈ 6.6,  opacity ≈ 0.69
        //   degree 30 → scale ≈ 7.4,  opacity ≈ 0.59
        //   degree 80 → scale ≈ 8.4,  opacity ≈ 0.45 (wide, soft)
        const auraGrowth = Math.log1p(degree) * 0.65; // ≈ ln(deg+1) bonus
        haloMesh.scale.setScalar(r * (5.6 + auraGrowth));
        const coreOpacity = Math.max(0.45, 0.78 - degree * 0.0042);
        haloMat.opacity = coreOpacity;
        haloMesh.visible = true;
      };
      // Map node id → index in snap.nodes for fast haze visibility writes.
      const nodeIndexById = new Map<string, number>();
      for (let i = 0; i < snap.nodes.length; i++) nodeIndexById.set(snap.nodes[i].id, i);
      const labelById = new Map<string, string>();
      for (const n of snap.nodes) labelById.set(n.id, n.label || n.id);
      const degreeById = new Map<string, number>();
      for (const n of snap.nodes) degreeById.set(n.id, n.degree);
      /** Top node ids by degree (full sorted list). The active label cap
       *  comes from `currentLabelCap`, which the adaptive controller
       *  scales down under load. */
      const topByDegreeFull = [...snap.nodes]
        .sort((a, b) => b.degree - a.degree)
        .map((n) => n.id);
      const DEFAULT_LABEL_CAP = 8;
      let currentLabelCap = DEFAULT_LABEL_CAP;
      const topByDegree = (): string[] => topByDegreeFull.slice(0, currentLabelCap);

      /** 2-hop dimming radius for focus mode (Slice F2). */
      const FOCUS_HOPS = 2;
      /** Most-recent focus set (selection + 2-hop neighbours), or null. */
      let currentFocusSet: Set<string> | null = null;
      const applyFocusToScene = (id: string | null): void => {
        // Compute once via TubeSystem (it owns the adjacency map) and
        // share the result with NodeSystem so node + edge dimming agree.
        const focusSet = tubeSystem.computeFocusSet(id, FOCUS_HOPS);
        currentFocusSet = focusSet;
        tubeSystem.setFocus(id, FOCUS_HOPS);
        nodeSystem.setFocus(focusSet);
        refreshLabels();
      };

      /**
       * Visibility predicates from the active filter state. Re-derived
       * on every `applyFilters` call so prefs.minConfidence / type/kind
       * toggles take effect without rebuilding the scene.
       */
      const applyFilters = (): void => {
        const f = filtersRef.current;
        nodeSystem.setVisibilityFilter((meta) => {
          if (!f.nodeTypes.has(meta.type)) return false;
          // Mirror 2D behaviour: confidence threshold gates dream nodes;
          // for non-dream nodes the threshold is informational only —
          // hiding all features at min-conf > 0 would empty the canvas.
          if (meta.type === "dream_node") {
            const n = snap.nodes[nodeIndexById.get(meta.id) ?? -1];
            if (n && n.confidence < f.minConfidence) return false;
          }
          return true;
        });
        tubeSystem.setVisibilityFilter((edge) => {
          if (!f.edgeKinds.has(edge.kind)) return false;
          // Need the original edge for confidence; look it up by endpoints.
          // Tubes are 1:1 with snap.edges in declaration order, so we can
          // index alongside getEdgeMetas() rather than searching here —
          // but a hash-keyed lookup keeps us safe against future ordering.
          const conf = edgeConfByKey.get(`${edge.s}\u0000${edge.t}\u0000${edge.kind}`) ?? 1;
          if (conf < f.minConfidence) return false;
          // Hide edges whose endpoint nodes are themselves filtered out.
          if (!f.nodeTypes.has(typeById.get(edge.s) ?? "feature")) return false;
          if (!f.nodeTypes.has(typeById.get(edge.t) ?? "feature")) return false;
          return true;
        });
        // Density haze should track node visibility too, otherwise hidden
        // clusters keep glowing in the background.
        const visibleVec: boolean[] = new Array(snap.nodes.length);
        for (let i = 0; i < snap.nodes.length; i++) {
          const n = snap.nodes[i];
          visibleVec[i] = f.nodeTypes.has(n.type)
            && (n.type !== "dream_node" || n.confidence >= f.minConfidence);
        }
        densityHaze.setVisibility(visibleVec);
        refreshLabels();
        renderStatusSafe();
      };
      // Pre-built lookups so the per-toggle filter pass stays O(edges).
      const edgeConfByKey = new Map<string, number>();
      for (const e of snap.edges) {
        edgeConfByKey.set(`${e.s}\u0000${e.t}\u0000${e.kind}`, e.conf);
      }
      const typeById = new Map<string, ExplorerNodeTypeAlias>();
      for (const n of snap.nodes) typeById.set(n.id, n.type);

      /**
       * Recompute which labels to show. Selection (with its 2-hop set)
       * wins; otherwise we fall back to the top-N hubs by degree, gated
       * by the active filter so hidden nodes never get a label.
       */
      const refreshLabels = (): void => {
        const f = filtersRef.current;
        const passesFilter = (id: string): boolean => {
          const t = typeById.get(id);
          if (!t || !f.nodeTypes.has(t)) return false;
          return true;
        };
        const ids = currentFocusSet
          ? [...currentFocusSet].filter(passesFilter)
          : topByDegree().filter(passesFilter);
        const targets = ids
          .map((id) => {
            const pos = nodeSystem.getPosition(id);
            if (!pos) return null;
            return {
              id,
              label: labelById.get(id) ?? id,
              x: pos.x,
              y: pos.y,
              z: pos.z,
            };
          })
          .filter((t): t is NonNullable<typeof t> => t !== null);
        labelOverlay.setActive(targets);
      };

      /** Status renderer is defined later; this guard avoids TDZ. */
      let renderStatusSafe = (): void => {};

      // Minimap overlay (Slice E2). DOM-based; sits absolutely over the
      // canvas so it survives a renderer rebuild without state loss.
      const minimap = new Minimap3D();
      minimap.attachTo(container);

      // Apply the initial selection — it might have been set in 2D before
      // the user toggled to 3D, so we shouldn't wait for a click. Focus
      // wiring happens after the first layout completes (rebuild() must
      // populate the tubeSystem attributes first).
      nodeSystem.setSelected(selectedRef.current);

      // Post-processing pipeline. Bloom thresholds matched to plan §3.2.6.
      // Phase 7 — 4× multisampled main render target so polygon edges
      // (especially diagonal tubes against the dark background) are
      // resolved before any post-processing. WebGL2 honours the
      // `samples` field on WebGLRenderTarget; on WebGL1 it's ignored
      // silently and the SMAA pass below picks up the slack. Cost: one
      // resolve blit per frame — negligible at our pixel counts.
      const composer = new composerMod.EffectComposer(
        bundle.renderer,
        new WebGLRenderTarget(container.clientWidth, container.clientHeight, {
          samples: 4,
          // Match the renderer's working colour space so tone mapping +
          // sRGB output stays consistent through the post chain.
          colorSpace: SRGBColorSpace,
        }),
      );
      composer.addPass(new renderPassMod.RenderPass(bundle.scene, bundle.camera));
      const bloomPass = new bloomMod.UnrealBloomPass(
        new Vector2(container.clientWidth, container.clientHeight),
        0.45, // strength  — Phase 9: lowered 0.55 → 0.45 so bloom adds glow without dominating
        0.32, // radius    — slightly tighter so bloom stays a halo, not a wash
        0.88, // threshold — only true peaks bloom (rest is tone-mapped)
      );
      composer.addPass(bloomPass);
      // Phase 7 — SMAA pass after bloom catches any remaining sub-pixel
      // jaggies that survive MSAA (e.g. inside the bloom blur, on the
      // hot edges of additive tubes). It's a single full-screen pass
      // running on the post-bloom buffer, ~0.3 ms at 1080p, and it
      // doesn't touch label DOM or UI which sit above the canvas.
      // Newer three.js versions accept no constructor args and size
      // themselves via composer.setSize / pass.setSize.
      const smaaPass = new smaaMod.SMAAPass();
      composer.addPass(smaaPass);
      // Baseline bloom values — captured so adaptive scaling can derive
      // reduced strengths/radii from a single source of truth and
      // restore exactly on rescue → recovery.
      const BASE_BLOOM_STRENGTH = bloomPass.strength;
      const BASE_BLOOM_RADIUS = bloomPass.radius;

      let bloomEnabled = true;
      const updateBloomEnabled = (on: boolean): void => {
        bloomEnabled = on;
        // Adaptive RESCUE tier suppresses bloom for performance; respect that.
        bloomPass.enabled = on && currentTier !== "RESCUE";
      };

      // ———— Adaptive quality controller (5 tiers) ————
      // Granular FPS-driven controller that scales pixel ratio, bloom,
      // label count and flow animation in matched steps so quality
      // degrades gracefully under load and recovers cleanly afterwards.
      //
      //   BEST     (>=60 fps) : full DPR, bloom 100%, labels 8, flow on
      //   HEALTHY  (45..60)   : same as BEST (deadband)
      //   SOFT     (30..45)   : full DPR, bloom 70%/75% radius, labels 6
      //   MEDIUM   (20..30)   : pr 1.0,   bloom 50%/65% radius, labels 4
      //   RESCUE   (<20)      : pr 0.7,   bloom OFF,            labels 2, flow paused
      //
      // Hysteresis: 2 consecutive samples to step down (~2 s),
      //             4 consecutive samples to step up (~4 s).
      // Photo capture overrides everything (see screenshot handler).
      type QualityTier = "BEST" | "HEALTHY" | "SOFT" | "MEDIUM" | "RESCUE";
      const TIER_ORDER: QualityTier[] = ["RESCUE", "MEDIUM", "SOFT", "HEALTHY", "BEST"];
      const DEVICE_PR = Math.min(window.devicePixelRatio || 1, 2);
      interface TierProfile {
        pixelRatio: number;
        bloomScale: number;     // 0 = off
        bloomRadiusScale: number;
        labelCap: number;
        adaptiveFlowPaused: boolean;
      }
      const PROFILES: Record<QualityTier, TierProfile> = {
        BEST:    { pixelRatio: DEVICE_PR, bloomScale: 1.0,  bloomRadiusScale: 1.0,  labelCap: 8, adaptiveFlowPaused: false },
        HEALTHY: { pixelRatio: DEVICE_PR, bloomScale: 1.0,  bloomRadiusScale: 1.0,  labelCap: 8, adaptiveFlowPaused: false },
        SOFT:    { pixelRatio: DEVICE_PR, bloomScale: 0.7,  bloomRadiusScale: 0.75, labelCap: 6, adaptiveFlowPaused: false },
        MEDIUM:  { pixelRatio: 1.0,       bloomScale: 0.5,  bloomRadiusScale: 0.65, labelCap: 4, adaptiveFlowPaused: false },
        RESCUE:  { pixelRatio: 0.7,       bloomScale: 0.0,  bloomRadiusScale: 0.5,  labelCap: 2, adaptiveFlowPaused: true  },
      };
      let currentTier: QualityTier = "BEST";
      let photoMode = false;
      // Adaptive flow pause is independent from the user/OS reduced-motion
      // preference so that recovering from RESCUE doesn't override a
      // user's choice to keep flow paused.
      let adaptiveFlowPaused = false;
      let downSamples = 0;
      let upSamples = 0;
      const DOWN_STEP_SAMPLES = 2;
      const UP_STEP_SAMPLES = 4;
      const applyTier = (tier: QualityTier): void => {
        if (tier === currentTier && !photoMode) return;
        currentTier = tier;
        const p = PROFILES[tier];
        // Pixel ratio + composer size — only re-apply on change to avoid
        // tearing down render targets every frame.
        const targetPr = p.pixelRatio;
        if (Math.abs(bundle.renderer.getPixelRatio() - targetPr) > 0.01) {
          bundle.renderer.setPixelRatio(targetPr);
          composer.setPixelRatio(targetPr);
          const w = container.clientWidth;
          const h = container.clientHeight;
          if (w > 0 && h > 0) {
            bundle.renderer.setSize(w, h, false);
            composer.setSize(w, h);
          }
        }
        // Bloom: scale strength/radius around captured baseline.
        bloomPass.strength = BASE_BLOOM_STRENGTH * p.bloomScale;
        bloomPass.radius = BASE_BLOOM_RADIUS * p.bloomRadiusScale;
        bloomPass.enabled = bloomEnabled && p.bloomScale > 0;
        // Label cap — refresh only if the cap actually changed so we
        // don't churn the DOM pool on every tier evaluation.
        if (currentLabelCap !== p.labelCap) {
          currentLabelCap = p.labelCap;
          // refreshLabels is hoisted via function-scope let; safe to call.
          refreshLabels();
        }
        adaptiveFlowPaused = p.adaptiveFlowPaused;
      };
      const stepTier = (delta: number): void => {
        const idx = TIER_ORDER.indexOf(currentTier);
        const next = Math.max(0, Math.min(TIER_ORDER.length - 1, idx + delta));
        if (next !== idx) applyTier(TIER_ORDER[next]);
      };
      const feedAdaptiveFps = (fps: number): void => {
        if (photoMode) return;
        // Map fps → desired tier band.
        let target: QualityTier;
        if (fps >= 60) target = "BEST";
        else if (fps >= 45) target = "HEALTHY";
        else if (fps >= 30) target = "SOFT";
        else if (fps >= 20) target = "MEDIUM";
        else target = "RESCUE";
        const targetIdx = TIER_ORDER.indexOf(target);
        const curIdx = TIER_ORDER.indexOf(currentTier);
        if (targetIdx < curIdx) {
          // Need to step down (toward RESCUE).
          downSamples++;
          upSamples = 0;
          if (downSamples >= DOWN_STEP_SAMPLES) {
            stepTier(-1);
            downSamples = 0;
          }
        } else if (targetIdx > curIdx) {
          // Need to step up (toward BEST). Slower to recover than to drop.
          upSamples++;
          downSamples = 0;
          if (upSamples >= UP_STEP_SAMPLES) {
            stepTier(+1);
            upSamples = 0;
          }
        } else {
          // At target — bleed counters back toward zero so brief excursions
          // don't accumulate across long stretches at the right tier.
          if (downSamples > 0) downSamples--;
          if (upSamples > 0) upSamples--;
        }
      };

      // Honor prefers-reduced-motion for the shader-flow drift on tubes.
      // Bloom and camera damping stay on — only the moving flow pulses
      // are paused (uTime stops advancing). RESCUE-tier flow pause is
      // tracked separately so toggling tiers doesn't override the user's
      // OS-level motion preference.
      const reducedMotionMql = window.matchMedia("(prefers-reduced-motion: reduce)");
      let userFlowPaused = reducedMotionMql.matches;
      const onMotionPrefChange = (e: MediaQueryListEvent): void => {
        userFlowPaused = e.matches;
      };
      reducedMotionMql.addEventListener("change", onMotionPrefChange);

      // Heatmap mode (Slice E1). Off by default; toggle with H. While on,
      // we re-fetch the aggregate every 30s so newly-routed events show
      // up without forcing the user to bounce the view. The window is
      // fixed at 1 hour for v1 — a UI affordance can land later.
      let heatmapOn = false;
      let heatmapTimer: ReturnType<typeof setInterval> | null = null;
      let lastHeatmap: HeatmapResult | null = null;
      const HEATMAP_REFRESH_MS = 30_000;
      const HEATMAP_WINDOW_S = 3600;
      const refreshHeatmap = async (): Promise<void> => {
        if (!heatmapOn) return;
        const result = await fetchHeatmap(HEATMAP_WINDOW_S);
        if (disposed || !heatmapOn) return;
        lastHeatmap = result;
        const map = new Map<string, number>(result.nodes);
        tubeSystem.applyHeatmap(map, result.max_count);
        renderStatus();
      };
      const setHeatmapEnabled = (on: boolean): void => {
        if (heatmapOn === on) return;
        heatmapOn = on;
        if (on) {
          void refreshHeatmap();
          heatmapTimer = setInterval(refreshHeatmap, HEATMAP_REFRESH_MS);
        } else {
          if (heatmapTimer) {
            clearInterval(heatmapTimer);
            heatmapTimer = null;
          }
          lastHeatmap = null;
          tubeSystem.applyHeatmap(null, 0);
          renderStatus();
        }
      };

      // Persist camera changes back to the daemon, but only when the user
      // stops moving — otherwise we'd POST every frame.
      let saveTimer: ReturnType<typeof setTimeout> | null = null;
      const queueCameraSave = (): void => {
        if (saveTimer) clearTimeout(saveTimer);
        saveTimer = setTimeout(() => {
          const pos = bundle.camera.position;
          const tgt = controls.target;
          void patchExplorerPrefs({
            camera3d: {
              position: [pos.x, pos.y, pos.z],
              target: [tgt.x, tgt.y, tgt.z],
            },
          });
        }, 600);
      };
      controls.addEventListener("end", queueCameraSave);

      // Camera tween (Slice E3 + Slice F fly-to). Used for preset recall,
      // selection fly-to, and double-click zoom. Track the in-flight tween
      // so a new request cancels the first cleanly instead of fighting it.
      const PRESET_TWEEN_MS = 450;
      const FLY_TWEEN_MS = 700;
      const ZOOM_TWEEN_MS = 380;
      /** Comfortable orbit distance when flying to a node. */
      const FLY_DISTANCE = 32;
      /** Skip flight tween if camera is already within this radius of target. */
      const FLY_SKIP_RADIUS = FLY_DISTANCE * 1.6;
      /** Each double-click pulls the camera this fraction closer (floored). */
      const ZOOM_IN_FACTOR = 0.55;
      const ZOOM_MIN_DISTANCE = 8;
      let activeTween:
        | {
            startedAt: number;
            durationMs: number;
            fromPos: Vector3;
            fromTarget: Vector3;
            toPos: Vector3;
            toTarget: Vector3;
          }
        | null = null;
      const startCameraTween = (
        toPos: Vector3,
        toTarget: Vector3,
        durationMs: number,
      ): void => {
        activeTween = {
          startedAt: performance.now(),
          durationMs,
          fromPos: bundle.camera.position.clone(),
          fromTarget: controls.target.clone(),
          toPos: toPos.clone(),
          toTarget: toTarget.clone(),
        };
      };
      /** Snap (no tween) — used on first mount when there's a pre-selection
       *  inherited from 2D mode. A flight from the persisted camera pose
       *  would feel like a glitch on every toggle, so we just teleport. */
      const snapCameraTo = (toPos: Vector3, toTarget: Vector3): void => {
        activeTween = null;
        bundle.camera.position.copy(toPos);
        controls.target.copy(toTarget);
        controls.update();
      };
      const tickPresetTween = (nowMs: number): void => {
        if (!activeTween) return;
        const t = Math.min(1, (nowMs - activeTween.startedAt) / activeTween.durationMs);
        // smoothstep for a calmer arrival than pure linear lerp.
        const e = t * t * (3 - 2 * t);
        bundle.camera.position.lerpVectors(activeTween.fromPos, activeTween.toPos, e);
        controls.target.lerpVectors(activeTween.fromTarget, activeTween.toTarget, e);
        if (t >= 1) {
          activeTween = null;
          // Persist the new resting pose just like a manual move would.
          queueCameraSave();
        }
      };
      /**
       * Compute a camera pose that frames `nodeId` at `distance` along the
       * current view direction, then either tween or snap there.
       *
       * Returns false if the node has no position yet (layout still pending)
       * so callers can defer until the first applyPositions().
       */
      const flyToNode = (
        nodeId: string,
        opts: { instant?: boolean; distance?: number; force?: boolean } = {},
      ): boolean => {
        const pos = nodeSystem.getPosition(nodeId);
        if (!pos) return false;
        const target = new Vector3(pos.x, pos.y, pos.z);
        const currentDist = bundle.camera.position.distanceTo(target);
        // No-op if we're already comfortably close — avoids a jarring tween
        // when the user clicks adjacent nodes while inspecting a cluster.
        if (!opts.force && !opts.instant && currentDist < FLY_SKIP_RADIUS) return true;
        const dir = new Vector3().subVectors(bundle.camera.position, controls.target);
        if (dir.lengthSq() < 1e-6) dir.set(0, 0, 1);
        dir.normalize();
        const distance = opts.distance ?? FLY_DISTANCE;
        const camPos = target.clone().addScaledVector(dir, distance);
        if (opts.instant) snapCameraTo(camPos, target);
        else startCameraTween(camPos, target, FLY_TWEEN_MS);
        return true;
      };
      /** Double-click handler: pull closer to `nodeId` (or current target
       *  if nodeId is null) by ZOOM_IN_FACTOR, floored at ZOOM_MIN_DISTANCE. */
      const zoomCloser = (nodeId: string | null): void => {
        let target: Vector3;
        if (nodeId) {
          const pos = nodeSystem.getPosition(nodeId);
          if (!pos) return;
          target = new Vector3(pos.x, pos.y, pos.z);
        } else {
          target = controls.target.clone();
        }
        const dir = new Vector3().subVectors(bundle.camera.position, target);
        const currentDist = dir.length();
        if (currentDist <= ZOOM_MIN_DISTANCE + 0.01) return;
        const newDist = Math.max(ZOOM_MIN_DISTANCE, currentDist * ZOOM_IN_FACTOR);
        dir.normalize();
        const camPos = target.clone().addScaledVector(dir, newDist);
        startCameraTween(camPos, target, ZOOM_TWEEN_MS);
      };
      const savePresetForSelected = (): void => {
        const id = selectedRef.current;
        if (!id) {
          renderStatus("select a node first");
          return;
        }
        const pos = bundle.camera.position;
        const tgt = controls.target;
        const next: Record<string, { position: [number, number, number]; target: [number, number, number] }> = {
          ...(prefsRef.current.cameraPresets3d ?? {}),
          [id]: {
            position: [pos.x, pos.y, pos.z],
            target: [tgt.x, tgt.y, tgt.z],
          },
        };
        void patchExplorerPrefs({ cameraPresets3d: next });
        renderStatus(`preset saved → ${id}`);
      };
      const recallPresetForSelected = (): void => {
        const id = selectedRef.current;
        if (!id) {
          renderStatus("select a node first");
          return;
        }
        const preset = prefsRef.current.cameraPresets3d?.[id];
        if (!preset) {
          renderStatus(`no preset for ${id}`);
          return;
        }
        startCameraTween(
          new Vector3(...preset.position),
          new Vector3(...preset.target),
          PRESET_TWEEN_MS,
        );
        renderStatus(`recall → ${id}`);
      };

      // Raycaster + a single shared NDC vector → no per-pointer alloc.
      const raycaster = new Raycaster();
      const ndc = new Vector2();
      let lastHoverId: string | null = null;
      let lastHoverAt = 0;
      const HOVER_THROTTLE_MS = 33; // ≈30 Hz, per plan §5.2.

      // Compact hover tooltip: degree / health / confidence. Pure DOM so
      // the screenshot capture (which reads the WebGL canvas only) doesn't
      // include it.
      const tooltip = document.createElement("div");
      Object.assign(tooltip.style, {
        position: "absolute",
        zIndex: "7",
        font: "11px/1.35 ui-sans-serif, system-ui, sans-serif",
        color: "#e8efff",
        background: "rgba(8,12,18,0.86)",
        border: "1px solid rgba(168,196,232,0.30)",
        borderRadius: "6px",
        padding: "6px 8px",
        pointerEvents: "none",
        whiteSpace: "pre",
        display: "none",
        transform: "translate(12px, 12px)",
      } satisfies Partial<CSSStyleDeclaration>);
      tooltip.dataset["dgOverlay"] = "tooltip";
      container.appendChild(tooltip);
      const showTooltip = (id: string, clientX: number, clientY: number): void => {
        const node = snap.nodes[nodeIndexById.get(id) ?? -1];
        if (!node) {
          tooltip.style.display = "none";
          return;
        }
        const rect = container.getBoundingClientRect();
        tooltip.style.left = `${clientX - rect.left}px`;
        tooltip.style.top = `${clientY - rect.top}px`;
        tooltip.textContent =
          `${node.label || node.id}\n` +
          `degree: ${node.degree}  health: ${node.health.toFixed(2)}  conf: ${node.confidence.toFixed(2)}`;
        tooltip.style.display = "block";
      };
      const hideTooltip = (): void => {
        tooltip.style.display = "none";
      };

      // ———— Screenshot button ————
      // Translucent monochrome camera glyph in the top-right corner. The
      // capture path renders a single fresh frame through the composer
      // and then reads the WebGL drawing buffer (preserveDrawingBuffer
      // is enabled in scene.ts). All HTML overlays — tooltip, HUD,
      // minimap, label DOM, status pill, the button itself — live above
      // the canvas, so they're naturally absent from the saved PNG.
      const shotBtn = document.createElement("button");
      shotBtn.type = "button";
      shotBtn.title = "Save screenshot (PNG)";
      shotBtn.setAttribute("aria-label", "Save screenshot");
      shotBtn.dataset["dgOverlay"] = "screenshot";
      // Inline SVG keeps the button asset-free and dependency-free.
      shotBtn.innerHTML =
        '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
        '<path d="M4 8h3l2-2h6l2 2h3v11H4z"/>' +
        '<circle cx="12" cy="13" r="3.5"/>' +
        "</svg>";
      Object.assign(shotBtn.style, {
        position: "absolute",
        top: "12px",
        right: "12px",
        zIndex: "6",
        width: "30px",
        height: "30px",
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        color: "#cdd9ee",
        background: "rgba(8,12,18,0.45)",
        border: "1px solid rgba(255,255,255,0.12)",
        borderRadius: "6px",
        cursor: "pointer",
        opacity: "0.45",
        transition: "opacity 120ms ease",
        padding: "0",
      } satisfies Partial<CSSStyleDeclaration>);
      shotBtn.addEventListener("mouseenter", () => {
        shotBtn.style.opacity = "0.9";
      });
      shotBtn.addEventListener("mouseleave", () => {
        shotBtn.style.opacity = "0.45";
      });
      shotBtn.addEventListener("click", () => {
        // ———— Photo mode ————
        // Force the highest-quality settings for the capture so the
        // saved PNG looks pristine even if the live view is currently
        // running on a degraded adaptive tier. We snapshot the current
        // tier, render once at full quality, read back, then restore.
        const prevTier = currentTier;
        photoMode = true;
        // Detach the controller from the live tier so applyTier doesn't
        // short-circuit. Phase 7 \u2014 force a true 2\u00d7 supersample over the
        // device pixel ratio (capped at 4) so the saved PNG resolves
        // edges and bloom rays well below one display pixel before the
        // PNG encoder downsamples to the canvas backing store. Combined
        // with MSAA 4\u00d7 and the SMAA pass already in the live composer
        // chain this produces near reference-quality stills.
        const photoPr = Math.min((window.devicePixelRatio || 1) * 2, 4);
        bundle.renderer.setPixelRatio(photoPr);
        composer.setPixelRatio(photoPr);
        const w = container.clientWidth;
        const h = container.clientHeight;
        if (w > 0 && h > 0) {
          bundle.renderer.setSize(w, h, false);
          composer.setSize(w, h);
        }
        bloomPass.strength = BASE_BLOOM_STRENGTH;
        bloomPass.radius = BASE_BLOOM_RADIUS;
        bloomPass.enabled = true;
        // Photo mode: lift exposure a touch and add a small rim boost
        // for cinematic punch. ACES tone mapping protects against
        // clipping even at the higher exposure, so the saved PNG is
        // dramatic without going milky. Restored in restoreLiveQuality.
        const prevExposure = bundle.renderer.toneMappingExposure;
        bundle.renderer.toneMappingExposure = 1.16;
        nodeSystem.setRimBoost(1.20);
        // Force a synchronous render so the readback below sees the
        // current frame even if requestAnimationFrame hasn't ticked
        // since the last paint.
        try {
          composer.render();
        } catch {
          /* render errors are surfaced elsewhere; capture is best-effort */
        }
        const canvas = bundle.renderer.domElement;
        const restoreLiveQuality = (): void => {
          photoMode = false;
          bundle.renderer.toneMappingExposure = prevExposure;
          nodeSystem.setRimBoost(1.0);
          // Force re-application of the previous tier (applyTier
          // short-circuits when tier === currentTier; clearing it first
          // sidesteps that without exposing a separate "force" path).
          currentTier = "BEST";
          applyTier(prevTier);
        };
        const finalize = (blob: Blob | null): void => {
          try {
            if (!blob) return;
            const url = URL.createObjectURL(blob);
            const a = document.createElement("a");
            a.href = url;
            const ts = new Date()
              .toISOString()
              .replace(/[:.]/g, "-")
              .replace("T", "_")
              .slice(0, 19);
            a.download = `dreamgraph-3d-${ts}.png`;
            document.body.appendChild(a);
            a.click();
            a.remove();
            setTimeout(() => URL.revokeObjectURL(url), 1500);
          } finally {
            // Always restore live-view quality so a failed save can't
            // strand the renderer at 3x pixel ratio.
            restoreLiveQuality();
          }
        };
        if (typeof canvas.toBlob === "function") {
          canvas.toBlob(finalize, "image/png");
        } else {
          // Fallback for environments where toBlob is unavailable.
          const dataUrl = canvas.toDataURL("image/png");
          fetch(dataUrl).then((r) => r.blob()).then(finalize).catch(() => {
            restoreLiveQuality();
          });
        }
      });
      container.appendChild(shotBtn);

      const updateHover = (clientX: number, clientY: number): void => {
        const rect = container.getBoundingClientRect();
        ndc.x = ((clientX - rect.left) / rect.width) * 2 - 1;
        ndc.y = -((clientY - rect.top) / rect.height) * 2 + 1;
        raycaster.setFromCamera(ndc, bundle.camera);
        const hit = nodeSystem.raycast(raycaster);
        const id = hit ? hit.id : null;
        if (id !== lastHoverId) {
          lastHoverId = id;
          nodeSystem.setHovered(id);
          container.style.cursor = id ? "pointer" : "";
        }
        if (id) showTooltip(id, clientX, clientY);
        else hideTooltip();
      };

      const onPointerMove = (e: PointerEvent): void => {
        const now = performance.now();
        if (now - lastHoverAt < HOVER_THROTTLE_MS) return;
        lastHoverAt = now;
        updateHover(e.clientX, e.clientY);
      };
      const onPointerLeave = (): void => {
        if (lastHoverId !== null) {
          lastHoverId = null;
          nodeSystem.setHovered(null);
          container.style.cursor = "";
        }
        hideTooltip();
      };
      // Selection (Slice F2 fix): OrbitControls captures the pointer on
      // mousedown and synthesises drag events, which can swallow native
      // `click` events on some pointer-event implementations. Track the
      // pointer ourselves and treat a tiny down→up delta as a click —
      // anything beyond ~5px is assumed to be an orbit drag instead.
      let downX = 0;
      let downY = 0;
      let downAt = 0;
      const CLICK_PIXEL_SLOP = 6;
      const CLICK_TIME_MS = 400;
      const onPointerDown = (e: PointerEvent): void => {
        if (e.button !== 0) return;
        downX = e.clientX;
        downY = e.clientY;
        downAt = performance.now();
      };
      const onPointerUp = (e: PointerEvent): void => {
        if (e.button !== 0) return;
        const dx = e.clientX - downX;
        const dy = e.clientY - downY;
        if (Math.hypot(dx, dy) > CLICK_PIXEL_SLOP) return;
        if (performance.now() - downAt > CLICK_TIME_MS) return;
        const rect = container.getBoundingClientRect();
        ndc.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
        ndc.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;
        raycaster.setFromCamera(ndc, bundle.camera);
        const hit = nodeSystem.raycast(raycaster);
        onSelectRef.current?.(hit ? hit.id : null);
      };
      // Double-click: zoom toward the picked node (or current target if the
      // user double-clicked empty space). Native `dblclick` fires alongside
      // our pointerup-driven click, which is fine — apiRef.setSelected only
      // tweens when the camera is far away, so the second event cleanly
      // hands off to zoomCloser().
      const onDoubleClick = (e: MouseEvent): void => {
        const rect = container.getBoundingClientRect();
        ndc.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
        ndc.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;
        raycaster.setFromCamera(ndc, bundle.camera);
        const hit = nodeSystem.raycast(raycaster);
        zoomCloser(hit ? hit.id : selectedRef.current);
      };
      container.addEventListener("pointermove", onPointerMove);
      container.addEventListener("pointerleave", onPointerLeave);
      container.addEventListener("pointerdown", onPointerDown);
      container.addEventListener("pointerup", onPointerUp);
      container.addEventListener("dblclick", onDoubleClick);

      // Run the force layout off-thread, then push positions into both
      // systems and frame the camera. Failures are non-fatal — a bare
      // graph at the origin is still better than a crashed canvas.
      const bridge = new LayoutBridge();
      let framedYet = false;
      let lastPositions: { id: string; x: number; y: number; z: number }[] = [];
      let currentLayoutMode: "force" | "radial" = prefsRef.current.layoutMode3d ?? "force";
      // Most-recent layout duration in ms — measured from compute() call to
      // applyPositions(), so the status reflects ACTUAL work, not uptime.
      let lastLayoutMs = 0;
      let layoutStartedAt = performance.now();

      const applyPositions = (
        positions: { id: string; x: number; y: number; z: number }[],
      ): void => {
        // Defence in depth: a single NaN/Infinity from the simulation
        // (e.g. two coincident nodes with strong charge) blows up Box3,
        // sends the camera to NaN-space, and produces a black canvas
        // with zero error output. Snap any bad value to 0 so the rest
        // of the pipeline can recover gracefully.
        let badCount = 0;
        for (const p of positions) {
          if (!Number.isFinite(p.x)) { p.x = 0; badCount++; }
          if (!Number.isFinite(p.y)) { p.y = 0; badCount++; }
          if (!Number.isFinite(p.z)) { p.z = 0; badCount++; }
        }
        if (badCount > 0) {
          // eslint-disable-next-line no-console
          console.warn(`[explorer-3d] sanitised ${badCount} non-finite layout coords`);
        }
        lastLayoutMs = Math.round(performance.now() - layoutStartedAt);
        lastPositions = positions;
        nodeSystem.applyLayout(positions);
        splines.applyLayout(positions);
        tubeSystem.rebuild();
        // Re-apply the current focus state so the freshly-built tube
        // attribute buffer reflects the active selection.
        applyFocusToScene(selectedRef.current);
        // Re-apply filters now that NodeSystem has fresh matrices, otherwise
        // a filter set before the first layout would visually no-op.
        applyFilters();
        // Push positions into the density haze so dense regions glow.
        // We need positions in the same index order as `snap.nodes`; the
        // layout result may not preserve that order, so re-key by id.
        const hazePositions = snap.nodes.map((n) => {
          const p = positions.find((q) => q.id === n.id);
          return p ?? { id: n.id, x: 0, y: 0, z: 0 };
        });
        densityHaze.setPositions(hazePositions);
        // Labels need fresh world positions to project; refresh once here
        // and the throttled overlay handles the per-frame projection.
        refreshLabels();

        // Recompute wavefront bounds + minimap nodes once layout settles.
        const c = new Vector3();
        let radius = 10;
        if (positions.length > 0) {
          const box = new Box3();
          const v = new Vector3();
          for (const p of positions) {
            v.set(p.x, p.y, p.z);
            box.expandByPoint(v);
          }
          box.getCenter(c);
          const size = new Vector3();
          box.getSize(size);
          radius = Math.max(size.x, size.y, size.z) * 0.5 || 10;
        }
        wavefrontSystem.setBounds(c, radius);
        // Re-tune fog + far plane: the radial layout can produce a cloud
        // many times larger than the force layout's, and the static
        // 30→120 fog from createScene() blacks out everything past it.
        tuneSceneForBounds(bundle.scene, bundle.camera, radius);
        minimap.setNodes(positions.map((p) => ({ id: p.id, x: p.x, z: p.z })));
        if (!framedYet) {
          framedYet = true;
          // Parity with 2D: if a node was already selected (e.g. picked in
          // 2D mode before the user toggled to 3D), snap the camera onto it
          // instead of framing the whole cloud. Snap (not tween) on first
          // paint so the toggle feels instant rather than glitchy.
          const sel = selectedRef.current;
          if (sel && flyToNode(sel, { instant: true, force: true })) {
            // flyToNode already positioned the camera.
          } else if (!hasSavedCamera) {
            // Fresh session (no persisted viewpoint) → fit the whole cloud
            // so the first frame shows the entire graph rather than the
            // hard-coded `[40,24,40]` default which only suits small graphs.
            frameAll(positions, bundle.camera, controls);
          }
          queueCameraSave();
        }
      };

      const runLayoutNow = (mode: "force" | "radial"): void => {
        currentLayoutMode = mode;
        layoutStartedAt = performance.now();
        bridge
          .compute(
            snap.nodes.map((n) => ({ id: n.id })),
            snap.edges.map((e) => ({ s: e.s, t: e.t, conf: e.conf })),
            mode === "radial"
              ? { mode: "radial", radialRoot: selectedRef.current ?? undefined }
              : { mode: "force" },
          )
          .then((positions) => {
            if (disposed) return;
            applyPositions(positions);
            renderStatus(`layout: ${mode}`);
          })
          .catch((err: unknown) => {
            if ((err as Error).message === "layout-superseded") return;
            // eslint-disable-next-line no-console
            console.warn("[explorer-3d] layout failed:", err);
          });
      };

      // Kick off the initial layout using the persisted mode.
      runLayoutNow(currentLayoutMode);

      const renderStatus = (toast?: string): void => {
        if (!statusRef.current) return;
        const sel = selectedRef.current;
        const bits = [
          `<strong>3D</strong>`,
          `${snap.nodes.length} nodes`,
          `${snap.edges.length} edges`,
          `layout ${lastLayoutMs} ms`,
          `bloom ${bloomEnabled ? "on" : "off"}`,
          (userFlowPaused || adaptiveFlowPaused) ? "paused" : "flowing",
        ];
        if (heatmapOn) {
          bits.push(
            lastHeatmap
              ? `heat ${lastHeatmap.total_events} ev/${Math.round(
                  lastHeatmap.window_seconds / 60,
                )}m`
              : "heat loading",
          );
        }
        if (sel) bits.push(`sel <strong>${sel}</strong>`);
        if (toast) bits.push(`<em>${toast}</em>`);
        statusRef.current.innerHTML = bits.join(" · ");
      };

      // Resize observer — keep the renderer + composer in step with the
      // flex/grid container without polling rAF for size deltas.
      const resize = (): void => {
        const w = container.clientWidth;
        const h = container.clientHeight;
        if (w === 0 || h === 0) return;
        bundle.renderer.setSize(w, h, false);
        composer.setSize(w, h);
        bundle.camera.aspect = w / h;
        bundle.camera.updateProjectionMatrix();
      };
      const ro = new ResizeObserver(resize);
      ro.observe(container);

      // Keyboard controls — scoped to window with no-op when typing in an
      // input/textarea so the SearchBar still receives normal characters.
      const onKeyDown = (e: KeyboardEvent): void => {
        // Disable every hotkey while focus is in any kind of editable
        // surface so typing in the search bar / inspector inputs / textareas
        // never accidentally triggers camera or layout actions. We check
        // both `e.target` AND `document.activeElement` because focus can
        // live somewhere other than the event target (e.g. a portalled
        // dialog input) and either signal alone misses cases.
        const targets: (Element | null)[] = [
          e.target as Element | null,
          document.activeElement,
        ];
        for (const t of targets) {
          if (!t) continue;
          const tag = (t as HTMLElement).tagName;
          if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;
          if ((t as HTMLElement).isContentEditable) return;
          // ARIA-textbox role used by some custom editor widgets.
          if ((t as HTMLElement).getAttribute?.("role") === "textbox") return;
        }
        if (e.key === "b" || e.key === "B") {
          updateBloomEnabled(!bloomEnabled);
          renderStatus();
        } else if (e.code === "Space") {
          userFlowPaused = !userFlowPaused;
          renderStatus();
          e.preventDefault();
        } else if (e.key === "f" || e.key === "F") {
          if (lastPositions.length > 0) frameAll(lastPositions, bundle.camera, controls);
        } else if (e.key === "h" || e.key === "H") {
          setHeatmapEnabled(!heatmapOn);
        } else if (e.shiftKey && (e.key === "S" || e.key === "s")) {
          savePresetForSelected();
          e.preventDefault();
        } else if (e.shiftKey && (e.key === "R" || e.key === "r")) {
          recallPresetForSelected();
          e.preventDefault();
        } else if (e.key === "l" || e.key === "L") {
          // Slice E4: cycle 3D layout strategy.
          const next: "force" | "radial" =
            currentLayoutMode === "force" ? "radial" : "force";
          // Reset framing so the new shape gets centered + zoomed to fit.
          framedYet = false;
          runLayoutNow(next);
          void patchExplorerPrefs({ layoutMode3d: next });
        } else if (e.key === "Escape") {
          onSelectRef.current?.(null);
        }
      };
      window.addEventListener("keydown", onKeyDown);

      let lastFrame = performance.now();
      let flowClock = 0;
      // ———— Diagnostic HUD (opt-in) ————
      // GPU + FPS + draw-call counters. Hidden by default for release
      // builds; toggled on via the VS Code command
      // `dreamgraph.toggleGpuMetrics` (which posts a message into the
      // Explorer iframe) or by setting `localStorage['dg.gpuMetrics']=1`
      // and reloading. Persisted to localStorage so the choice survives
      // a refresh.
      const GPU_METRICS_KEY = "dg.gpuMetrics";
      const readGpuPref = (): boolean => {
        try {
          return window.localStorage?.getItem(GPU_METRICS_KEY) === "1";
        } catch {
          return false;
        }
      };
      const writeGpuPref = (on: boolean): void => {
        try {
          window.localStorage?.setItem(GPU_METRICS_KEY, on ? "1" : "0");
        } catch {
          /* localStorage disabled — best effort only */
        }
      };
      let hudVisible = readGpuPref();
      const hud = document.createElement("div");
      Object.assign(hud.style, {
        position: "absolute",
        bottom: "12px",
        left: "12px",
        zIndex: "6",
        font: "11px/1.35 ui-monospace, Menlo, Consolas, monospace",
        color: "#a8c4e8",
        background: "rgba(8,12,18,0.72)",
        border: "1px solid rgba(255,255,255,0.10)",
        borderRadius: "6px",
        padding: "6px 8px",
        pointerEvents: "none",
        whiteSpace: "pre",
        maxWidth: "360px",
        display: hudVisible ? "block" : "none",
      } satisfies Partial<CSSStyleDeclaration>);
      hud.dataset["dgOverlay"] = "hud";
      container.appendChild(hud);
      // Read the unmasked vendor/renderer once — it never changes for the
      // life of the context, and the lookup costs a sync GL call.
      let gpuLine = "GPU: unknown";
      try {
        const gl = bundle.renderer.getContext();
        const dbg = gl.getExtension("WEBGL_debug_renderer_info");
        const vendor = dbg ? gl.getParameter(dbg.UNMASKED_VENDOR_WEBGL) : "?";
        const rend = dbg ? gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : "?";
        gpuLine = `GPU: ${rend}\nvendor: ${vendor}`;
        // SwiftShader / llvmpipe / software is the canonical CPU-fallback
        // signature. Highlight it so the user can't miss it.
        const r = String(rend).toLowerCase();
        if (r.includes("swiftshader") || r.includes("llvmpipe") || r.includes("software")) {
          hud.style.color = "#ffb86b";
          hud.style.borderColor = "rgba(255,184,107,0.6)";
          gpuLine += "\n⚠ SOFTWARE RENDERER (CPU fallback)";
        }
      } catch {
        gpuLine = "GPU: lookup failed";
      }
      let fpsFrames = 0;
      let fpsLastSec = performance.now();
      let fpsValue = 0;
      const updateHud = (): void => {
        if (!hudVisible) return;
        const info = bundle.renderer.info;
        hud.textContent =
          `${gpuLine}\n` +
          `FPS: ${fpsValue.toFixed(0)}  draws: ${info.render.calls}  tris: ${info.render.triangles}\n` +
          `geom: ${info.memory.geometries}  tex: ${info.memory.textures}  pr: ${bundle.renderer.getPixelRatio().toFixed(2)}  q: ${currentTier}${photoMode ? " (photo)" : ""}`;
      };
      const setHudVisible = (on: boolean): void => {
        hudVisible = on;
        hud.style.display = on ? "block" : "none";
        writeGpuPref(on);
        if (on) updateHud();
      };
      // Listen for the VS Code command relay (postMessage from the host
      // webview) and a same-origin standalone toggle. Either path is safe
      // — the listener only acts on a known message type.
      const onWindowMessage = (e: MessageEvent): void => {
        const data = e.data as { type?: string; visible?: boolean } | null;
        if (!data || typeof data !== "object") return;
        if (data.type === "dreamgraph.toggleGpuMetrics") {
          setHudVisible(typeof data.visible === "boolean" ? data.visible : !hudVisible);
        }
      };
      window.addEventListener("message", onWindowMessage);
      // Minimap camera marker only needs to track at user-perceivable
      // rates — mutating SVG attributes every frame triggers per-frame
      // SVG layout work in the browser, which is pure CPU cost for no
      // visible benefit. ~12 Hz is plenty for a corner widget.
      let minimapLastUpdate = 0;
      const MINIMAP_INTERVAL_MS = 80;
      const tick = (): void => {
        if (disposed) return;
        const now = performance.now();
        const dt = Math.min(0.1, (now - lastFrame) / 1000);
        lastFrame = now;
        controls.update();
        // Advance the shader clock for tube flow pulses; freezing it on
        // pause keeps every pulse at its current position rather than
        // skipping forward when motion resumes.
        if (framedYet && !userFlowPaused && !adaptiveFlowPaused) flowClock += dt;
        tubeSystem.setTime(flowClock);
        nodeSystem.setTime(flowClock);
        wavefrontSystem.tick(now / 1000);
        tickPresetTween(now);
        if (now - minimapLastUpdate >= MINIMAP_INTERVAL_MS) {
          minimap.setCamera(bundle.camera, controls.target);
          minimapLastUpdate = now;
        }
        labelOverlay.update(
          bundle.camera,
          container.clientWidth,
          container.clientHeight,
        );
        composer.render();
        // FPS counter — simple 1-second window. Cheaper than a moving
        // average and accurate enough for diagnostics.
        fpsFrames++;
        if (now - fpsLastSec >= 1000) {
          fpsValue = (fpsFrames * 1000) / (now - fpsLastSec);
          fpsFrames = 0;
          fpsLastSec = now;
          feedAdaptiveFps(fpsValue);
          updateHud();
        }
        raf = requestAnimationFrame(tick);
      };
      raf = requestAnimationFrame(tick);

      apiRef.current = {
        setSelected(id) {
          nodeSystem.setSelected(id);
          applyFocusToScene(id);
          updateHaloFor(id);
          // Travel to the new selection. flyToNode short-circuits if the
          // camera is already nearby (so clicking around a cluster doesn't
          // judder) and gracefully no-ops if the layout hasn't produced a
          // position for `id` yet — the first applyPositions() handles
          // that case via the framedYet branch.
          if (id) flyToNode(id);
          renderStatus();
        },
        triggerWave(color = 0xa0dcff) {
          wavefrontSystem.trigger(performance.now() / 1000, color);
        },
        applyFilters,
      };
      // Bind the safe wrapper now that renderStatus is in scope.
      renderStatusSafe = () => renderStatus();

      cleanup = () => {
        if (saveTimer) clearTimeout(saveTimer);
        if (heatmapTimer) clearInterval(heatmapTimer);
        controls.removeEventListener("end", queueCameraSave);
        controls.dispose();
        ro.disconnect();
        reducedMotionMql.removeEventListener("change", onMotionPrefChange);
        container.removeEventListener("pointermove", onPointerMove);
        container.removeEventListener("pointerleave", onPointerLeave);
        container.removeEventListener("pointerdown", onPointerDown);
        container.removeEventListener("pointerup", onPointerUp);
        container.removeEventListener("dblclick", onDoubleClick);
        window.removeEventListener("keydown", onKeyDown);
        window.removeEventListener("message", onWindowMessage);
        bridge.dispose();
        nodeSystem.dispose();
        tubeSystem.dispose();
        wavefrontSystem.dispose();
        densityHaze.dispose();
        labelOverlay.dispose();
        minimap.dispose();
        hud.remove();
        tooltip.remove();
        shotBtn.remove();
        haloMesh.parent?.remove(haloMesh);
        haloTex.dispose();
        haloMat.dispose();
        composer.dispose();
        bloomPass.dispose();
        bundle.dispose();
        apiRef.current = null;
      };
    })().catch((err: unknown) => {
      onFatal?.((err as Error).message || "Failed to initialize 3D renderer.");
    });

    return () => {
      disposed = true;
      if (raf) cancelAnimationFrame(raf);
      cleanup?.();
    };
    // Intentionally only depend on mount — prefs and snapshot are read via
    // refs so toggling grid/quality at runtime won't tear the scene down.
    // Slice E will add a snapshot-delta path that re-runs the layout in
    // place and updates the existing systems.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div className="canvas-wrap canvas-3d">
      <div ref={containerRef} className="canvas" />
      <div className="status" ref={statusRef}>
        <strong>3D</strong> · slice D · laying out…
      </div>
    </div>
  );
}

/**
 * Compute a bounding box from positions, then move the camera back so the
 * whole cloud fits in the current FOV with a comfortable margin.
 */
function frameAll(
  positions: readonly { x: number; y: number; z: number }[],
  camera: PerspectiveCamera,
  controls: { target: Vector3; update(): void },
): void {
  if (positions.length === 0) return;
  const box = new Box3();
  const v = new Vector3();
  for (const p of positions) {
    v.set(p.x, p.y, p.z);
    box.expandByPoint(v);
  }
  const center = new Vector3();
  const size = new Vector3();
  box.getCenter(center);
  box.getSize(size);
  const radius = Math.max(size.x, size.y, size.z) * 0.5 || 10;
  // Account for both vertical AND horizontal field of view so the
  // farthest visible node sits near whichever edge clamps first — wide
  // viewports use horizontal FOV, tall ones use vertical.
  const fovV = (camera.fov * Math.PI) / 180;
  const aspect = Math.max(0.001, camera.aspect);
  const fovH = 2 * Math.atan(Math.tan(fovV / 2) * aspect);
  const limitFov = Math.min(fovV, fovH);
  // 1.05x margin keeps a small breathing room around extreme nodes
  // without padding the camera so far back that everything looks tiny.
  const distance = (radius / Math.tan(limitFov / 2)) * 1.05;
  const dir = new Vector3(1, 0.6, 1).normalize();
  camera.position.copy(center).add(dir.multiplyScalar(distance));
  controls.target.copy(center);
  camera.lookAt(center);
  controls.update();
}
