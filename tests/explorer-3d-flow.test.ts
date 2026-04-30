/**
 * Slice C tests — splines, tubes, particles.
 *
 * plans/EXPLORER_3D_MODE.md §10.1.
 *
 * Three.js classes themselves run fine in Node; we only avoid creating a
 * `WebGLRenderer` (no GL context here).
 */

import { describe, expect, it } from "vitest";
import { SplineSet } from "../explorer/src/three/splines";
import { TubeSystem } from "../explorer/src/three/TubeSystem";
import {
  ParticleSystem,
  pushParticlesForEdge,
} from "../explorer/src/three/ParticleSystem";
import type { ExplorerEdge, ExplorerNode } from "../explorer/src/types";

function smallGraph(): { nodes: ExplorerNode[]; edges: ExplorerEdge[] } {
  const nodes: ExplorerNode[] = [
    { id: "a", type: "feature", label: "A", degree: 3, health: 1, confidence: 0.9 },
    { id: "b", type: "workflow", label: "B", degree: 2, health: 1, confidence: 0.7 },
    { id: "c", type: "data_model", label: "C", degree: 1, health: 1, confidence: 0.5 },
  ];
  const edges: ExplorerEdge[] = [
    { s: "a", t: "b", kind: "validated", conf: 1.0 },
    { s: "b", t: "c", kind: "tension", conf: 0.6 },
    { s: "a", t: "c", kind: "dream", conf: 0.4 },
  ];
  return { nodes, edges };
}

describe("SplineSet", () => {
  it("creates one curve per visible edge and skips orphans", () => {
    const { nodes, edges } = smallGraph();
    const orphans: ExplorerEdge[] = [
      ...edges,
      { s: "ghost", t: "a", kind: "fact", conf: 1 },
    ];
    const splines = new SplineSet(nodes, orphans);
    expect(splines.curves).toHaveLength(edges.length);
    expect(splines.metas).toHaveLength(edges.length);
  });

  it("applyLayout positions the endpoints of each curve at s/t", () => {
    const { nodes, edges } = smallGraph();
    const splines = new SplineSet(nodes, edges);
    splines.applyLayout([
      { id: "a", x: 0, y: 0, z: 0 },
      { id: "b", x: 5, y: 0, z: 0 },
      { id: "c", x: 0, y: 5, z: 0 },
    ]);
    const ab = splines.curves[0];
    const start = ab.getPointAt(0);
    const end = ab.getPointAt(1);
    // Tolerance because Catmull-Rom interpolation can drift the sampled
    // start/end if the control point is far off-axis. Our 1.4-unit cap
    // keeps the drift well under this tolerance for short edges.
    expect(Math.hypot(start.x - 0, start.y - 0, start.z - 0)).toBeLessThan(0.001);
    expect(Math.hypot(end.x - 5, end.y - 0, end.z - 0)).toBeLessThan(0.001);
  });

  it("produces deterministic mid offsets for the same edge id", () => {
    const { nodes, edges } = smallGraph();
    const positions = [
      { id: "a", x: 0, y: 0, z: 0 },
      { id: "b", x: 5, y: 0, z: 0 },
      { id: "c", x: 0, y: 5, z: 0 },
    ];
    const s1 = new SplineSet(nodes, edges);
    const s2 = new SplineSet(nodes, edges);
    s1.applyLayout(positions);
    s2.applyLayout(positions);
    for (let i = 0; i < s1.curves.length; i++) {
      const m1 = s1.curves[i].points[1];
      const m2 = s2.curves[i].points[1];
      expect(m1.x).toBeCloseTo(m2.x, 9);
      expect(m1.y).toBeCloseTo(m2.y, 9);
      expect(m1.z).toBeCloseTo(m2.z, 9);
    }
  });
});

describe("TubeSystem", () => {
  it("rebuild merges per-edge tubes into a single geometry", () => {
    const { nodes, edges } = smallGraph();
    const splines = new SplineSet(nodes, edges);
    splines.applyLayout([
      { id: "a", x: 0, y: 0, z: 0 },
      { id: "b", x: 5, y: 0, z: 0 },
      { id: "c", x: 0, y: 5, z: 0 },
    ]);
    const tubes = new TubeSystem(splines);
    try {
      tubes.rebuild();
      const pos = tubes.mesh.geometry.getAttribute("position");
      const col = tubes.mesh.geometry.getAttribute("color");
      expect(pos.count).toBeGreaterThan(0);
      // Same vertex count for color and position — the merge preserved both.
      expect(col.count).toBe(pos.count);
    } finally {
      tubes.dispose();
    }
  });

  it("rebuild on an empty graph produces an empty geometry without throwing", () => {
    const splines = new SplineSet([], []);
    const tubes = new TubeSystem(splines);
    try {
      tubes.rebuild();
      const pos = tubes.mesh.geometry.getAttribute("position");
      expect(pos === undefined || pos.count === 0).toBe(true);
    } finally {
      tubes.dispose();
    }
  });
});

describe("pushParticlesForEdge", () => {
  it("validated kind scales with confidence (min 2)", () => {
    const out: ReturnType<typeof collect> = [];
    pushParticlesForEdge(out, 0, "validated", 1.0);
    expect(out.length).toBe(6);
    out.length = 0;
    pushParticlesForEdge(out, 0, "validated", 0.0);
    expect(out.length).toBe(2);
  });

  it("tension emits 2 forward + 2 back", () => {
    const out: ReturnType<typeof collect> = [];
    pushParticlesForEdge(out, 0, "tension", 0.5);
    expect(out.length).toBe(4);
    expect(out.filter((p) => p.direction === 1)).toHaveLength(2);
    expect(out.filter((p) => p.direction === -1)).toHaveLength(2);
  });

  it("candidate, dream, fact spawn fixed counts", () => {
    const c: ReturnType<typeof collect> = [];
    pushParticlesForEdge(c, 0, "candidate", 1);
    pushParticlesForEdge(c, 0, "dream", 1);
    pushParticlesForEdge(c, 0, "fact", 1);
    expect(c.filter((p) => p.kind === "candidate")).toHaveLength(3);
    expect(c.filter((p) => p.kind === "dream")).toHaveLength(4);
    expect(c.filter((p) => p.kind === "fact")).toHaveLength(2);
  });
});

describe("ParticleSystem", () => {
  it("instances one mesh slot per particle and advances offsets on update", () => {
    const { nodes, edges } = smallGraph();
    const splines = new SplineSet(nodes, edges);
    splines.applyLayout([
      { id: "a", x: 0, y: 0, z: 0 },
      { id: "b", x: 5, y: 0, z: 0 },
      { id: "c", x: 0, y: 5, z: 0 },
    ]);
    const particles = new ParticleSystem(splines);
    try {
      const expected =
        6 /* validated conf=1 */ + 4 /* tension */ + 4; /* dream */
      expect(particles.metas).toHaveLength(expected);
      expect(particles.mesh.count).toBe(expected);

      const before = particles.metas[0].offset;
      particles.update(0.5, 0.5);
      const after = particles.metas[0].offset;
      // Offset must have advanced by speed * dt (mod 1).
      expect(after).not.toBe(before);
      // Validated speed = 0.18, dt = 0.5 → +0.09.
      expect(((after - before + 1) % 1)).toBeCloseTo(0.09, 5);
    } finally {
      particles.dispose();
    }
  });

  it("update is safe on an empty graph", () => {
    const splines = new SplineSet([], []);
    const particles = new ParticleSystem(splines);
    try {
      expect(() => particles.update(0.016, 0)).not.toThrow();
      expect(particles.mesh.count).toBe(0);
    } finally {
      particles.dispose();
    }
  });
});

// Helper used by the spawn tests — local because the meta type isn't
// exported and we don't want to widen the public surface for tests.
type Particle = {
  edgeIndex: number;
  offset: number;
  speed: number;
  direction: 1 | -1;
  kind: ExplorerEdge["kind"];
};
function collect(): Particle[] {
  return [];
}
