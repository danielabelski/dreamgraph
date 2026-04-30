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
  /**
   * Layout strategy. "force" — d3-force-3d simulation (default).
   * "radial" — BFS shells from a root node distributed on Fibonacci
   * spheres. Honors `radialRoot` (defaults to highest-degree node).
   */
  mode?: LayoutMode;
  /** Root node for radial layout. Falls back to highest-degree node. */
  radialRoot?: string;
  /** Distance between concentric shells in radial mode. */
  radialShellSpacing?: number;
}

export type LayoutMode = "force" | "radial";

const DEFAULTS: Required<LayoutOptions> = {
  ticks: 200,
  linkDistance: 8,
  chargeStrength: -30,
  collideRadius: 1.4,
  mode: "force",
  radialRoot: "",
  radialShellSpacing: 14,
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
 * Dispatches to `radialLayout` when `options.mode === "radial"`; otherwise
 * runs the d3-force-3d simulation.
 */
export function runLayout(
  nodes: readonly LayoutNodeInput[],
  edges: readonly LayoutEdgeInput[],
  options: LayoutOptions = {},
): LayoutNodeOutput[] {
  if (options.mode === "radial") {
    return radialLayout(nodes, edges, options);
  }
  return forceLayout(nodes, edges, options);
}

function forceLayout(
  nodes: readonly LayoutNodeInput[],
  edges: readonly LayoutEdgeInput[],
  options: LayoutOptions,
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

/* ----------------------------------------------------------------- *
 * Radial / hierarchical layout (Slice E4)
 * ----------------------------------------------------------------- */

const RADIAL_DEFAULT_SHELL_SPACING = 14;
/** Golden angle for Fibonacci sphere distribution. */
const GOLDEN_ANGLE = Math.PI * (3 - Math.sqrt(5));

/**
 * Place nodes on concentric Fibonacci spheres by BFS depth from a root.
 *
 * - Root: `options.radialRoot` if present in the graph, else the highest
 *   in-out-degree node (ties broken by id sort for determinism).
 * - Shell `k` sits at radius `k * shellSpacing` and distributes its members
 *   evenly via the golden-angle sphere lattice. Shell 0 is the root itself
 *   at the origin.
 * - Nodes in disconnected components are appended as one extra outer
 *   shell rooted at their own highest-degree representative — they don't
 *   share lattice slots with the main tree, so they don't visually merge.
 *
 * Pure / deterministic. Linear in nodes + edges plus one BFS.
 */
export function radialLayout(
  nodes: readonly LayoutNodeInput[],
  edges: readonly LayoutEdgeInput[],
  options: LayoutOptions = {},
): LayoutNodeOutput[] {
  const shellSpacing = options.radialShellSpacing ?? RADIAL_DEFAULT_SHELL_SPACING;
  if (nodes.length === 0) return [];

  const ids = new Set(nodes.map((n) => n.id));
  const adj = new Map<string, Set<string>>();
  for (const n of nodes) adj.set(n.id, new Set());
  for (const e of edges) {
    if (!ids.has(e.s) || !ids.has(e.t)) continue;
    adj.get(e.s)!.add(e.t);
    adj.get(e.t)!.add(e.s);
  }

  // Pick root: explicit override wins; otherwise highest-degree node
  // (ties broken by id sort for stable output across runs).
  const sortedByDegree = [...nodes]
    .map((n) => ({ id: n.id, deg: adj.get(n.id)!.size }))
    .sort((a, b) => (b.deg - a.deg) || (a.id < b.id ? -1 : 1));
  const explicitRoot =
    options.radialRoot && ids.has(options.radialRoot) ? options.radialRoot : null;
  const primaryRoot = explicitRoot ?? sortedByDegree[0].id;

  // BFS shells starting from each unvisited root. Track depth per node.
  const depth = new Map<string, number>();
  const components: string[][] = [];
  const visit = (start: string): void => {
    if (depth.has(start)) return;
    const queue: string[] = [start];
    depth.set(start, 0);
    const member: string[] = [start];
    while (queue.length > 0) {
      const cur = queue.shift()!;
      const d = depth.get(cur)!;
      for (const nb of adj.get(cur)!) {
        if (depth.has(nb)) continue;
        depth.set(nb, d + 1);
        queue.push(nb);
        member.push(nb);
      }
    }
    components.push(member);
  };
  visit(primaryRoot);
  // Subsequent components: pick highest-degree unvisited node so each
  // disconnected island grows from its own meaningful center.
  for (const { id } of sortedByDegree) {
    if (!depth.has(id)) visit(id);
  }

  // Position primary component centred at origin; secondary components
  // are offset along +x by their predecessor's outer-shell radius plus
  // a margin so they don't visually overlap.
  const out: LayoutNodeOutput[] = [];
  let xOffset = 0;
  for (const member of components) {
    // Bucket this component's members by depth.
    const byDepth = new Map<number, string[]>();
    let maxDepth = 0;
    for (const id of member) {
      const d = depth.get(id)!;
      if (d > maxDepth) maxDepth = d;
      const list = byDepth.get(d) ?? [];
      list.push(id);
      byDepth.set(d, list);
    }

    for (let d = 0; d <= maxDepth; d++) {
      const shell = byDepth.get(d);
      if (!shell || shell.length === 0) continue;
      // Sort by id for deterministic slot assignment.
      shell.sort();
      if (d === 0) {
        out.push({ id: shell[0], x: xOffset, y: 0, z: 0 });
        // Any extras at depth 0 (rare — only the root sits here) get the
        // same fallback as a depth-1 single-element shell.
        for (let i = 1; i < shell.length; i++) {
          out.push({ id: shell[i], x: xOffset, y: shellSpacing, z: 0 });
        }
        continue;
      }
      const radius = d * shellSpacing;
      const n = shell.length;
      // Fibonacci-sphere lattice: y descends linearly through (-1, 1),
      // azimuth advances by the golden angle. Robust at every density.
      for (let i = 0; i < n; i++) {
        const y = 1 - (i + 0.5) * (2 / n);
        const r = Math.sqrt(Math.max(0, 1 - y * y));
        const theta = i * GOLDEN_ANGLE;
        const px = xOffset + radius * Math.cos(theta) * r;
        const py = radius * y;
        const pz = radius * Math.sin(theta) * r;
        out.push({ id: shell[i], x: px, y: py, z: pz });
      }
    }
    // Slide subsequent components further along +x so they don't overlap.
    xOffset += (maxDepth + 1) * shellSpacing * 2 + shellSpacing;
  }

  // Preserve the input order of `nodes` for stable consumers.
  const byId = new Map(out.map((p) => [p.id, p] as const));
  return nodes.map((n) =>
    byId.get(n.id) ?? { id: n.id, x: 0, y: 0, z: 0 },
  );
}
