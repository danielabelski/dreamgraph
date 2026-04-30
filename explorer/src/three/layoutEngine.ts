/**
 * Pure 3D force-directed layout — runs on the worker thread, also testable
 * directly in vitest because it owns no Worker / DOM dependencies.
 *
 * plans/EXPLORER_3D_MODE.md §4. The forces and parameters here are tuned
 * to produce a recognizable cloud at the same scale as the 2D Atlas, so
 * toggling between modes feels like camera motion rather than re-layout.
 *
 * Determinism: d3-force-3d uses an internal LCG that is reset to its
 * default seed on every `forceSimulation()` call. We additionally seed
 * each node's initial position from a hash of its id, so identical
 * snapshots produce byte-identical layouts across runs.
 */

import {
  forceCenter,
  forceCollide,
  forceLink,
  forceManyBody,
  forceSimulation,
} from "d3-force-3d";

export interface LayoutNodeInput {
  /** Stable node id (also used as the seed for initial position). */
  id: string;
  /** Optional pre-existing position (e.g. carried over from a prior run). */
  x?: number;
  y?: number;
  z?: number;
}

export interface LayoutEdgeInput {
  s: string;
  t: string;
  /** 0..1 — stronger edges pull harder. */
  conf?: number;
}

export interface LayoutNodeOutput {
  id: string;
  x: number;
  y: number;
  z: number;
}

export interface LayoutOptions {
  /** Number of synchronous force ticks. 200 is a good cold-start budget. */
  ticks?: number;
  /** Target edge rest length in world units. */
  linkDistance?: number;
  /** Many-body repulsion strength (negative = repel). */
  chargeStrength?: number;
  /** Per-node collision radius. */
  collideRadius?: number;
}

const DEFAULTS: Required<LayoutOptions> = {
  ticks: 200,
  linkDistance: 8,
  chargeStrength: -30,
  collideRadius: 1.4,
};

/**
 * Cheap deterministic 32-bit string hash → in-range float.
 * Used only for seeding initial node positions; quality is not critical.
 */
function hash(str: string): number {
  let h = 2166136261 >>> 0; // FNV-1a basis
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function seededOffset(id: string, axis: number): number {
  // Three independent samples per id by mixing in the axis index.
  const h = hash(id + ":" + axis);
  // Map to [-15, 15] so the initial cloud has a sensible diameter.
  return ((h / 0xffffffff) - 0.5) * 30;
}

/**
 * Run the simulation to completion and return final positions.
 *
 * Synchronous and CPU-bound — call from a Worker for non-trivial graphs.
 */
export function runLayout(
  nodes: readonly LayoutNodeInput[],
  edges: readonly LayoutEdgeInput[],
  options: LayoutOptions = {},
): LayoutNodeOutput[] {
  const opts = { ...DEFAULTS, ...options };

  // Working copies — the simulation mutates x/y/z/vx/vy/vz in place and
  // we don't want to scribble on caller-owned snapshot objects.
  const simNodes = nodes.map((n) => ({
    id: n.id,
    x: n.x ?? seededOffset(n.id, 0),
    y: n.y ?? seededOffset(n.id, 1),
    z: n.z ?? seededOffset(n.id, 2),
  }));

  // Drop edges that point at unknown nodes — d3-force-link throws otherwise.
  const ids = new Set(simNodes.map((n) => n.id));
  const simEdges = edges
    .filter((e) => ids.has(e.s) && ids.has(e.t))
    .map((e) => ({ source: e.s, target: e.t, conf: e.conf ?? 0.5 }));

  const sim = forceSimulation(simNodes, 3)
    .alphaDecay(0.0228) // ≈ 1 - 0.001^(1/200), matches our tick budget
    .force("charge", forceManyBody().strength(opts.chargeStrength))
    .force(
      "link",
      forceLink(simEdges)
        .id((d) => (d as { id: string }).id)
        .distance(opts.linkDistance)
        // Strength scaled by confidence so validated edges pull tighter
        // than dream candidates — same intuition as the 2D layout.
        .strength((l) => 0.3 + 0.5 * (l as { conf: number }).conf),
    )
    .force("center", forceCenter(0, 0, 0).strength(0.05))
    .force("collide", forceCollide(opts.collideRadius).iterations(1))
    .stop();

  sim.tick(opts.ticks);

  return simNodes.map((n) => ({
    id: n.id,
    x: n.x,
    y: n.y,
    z: n.z,
  }));
}
