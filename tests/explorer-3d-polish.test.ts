/**
 * Slice D tests — per-type node buckets + hover/select state.
 *
 * plans/EXPLORER_3D_MODE.md §12.D.
 *
 * Notes:
 *   - The test suite can't `import "three"` directly because the package
 *     lives under `explorer/node_modules/three` (workspaced SPA), so we
 *     stick to the NodeSystem public surface, which is JS-only.
 *   - Raycaster behavior is exercised manually + by the integration build;
 *     it would otherwise need a three import here.
 */

import { describe, expect, it } from "vitest";
import { NodeSystem } from "../explorer/src/three/NodeSystem";
import type { ExplorerNode, ExplorerNodeType } from "../explorer/src/types";

function node(id: string, type: ExplorerNodeType): ExplorerNode {
  return { id, type, label: id.toUpperCase(), degree: 1, health: 1, confidence: 0.7 };
}

describe("NodeSystem (Slice D — per-type buckets)", () => {
  it("creates one InstancedMesh per distinct node type", () => {
    const nodes: ExplorerNode[] = [
      node("a", "feature"),
      node("b", "feature"),
      node("c", "workflow"),
      node("d", "tension"),
    ];
    const sys = new NodeSystem(nodes);
    try {
      // Internal buckets aren't on the public surface; addTo lets us count
      // them via a probe scene.
      const probe = { children: [] as unknown[], add(o: unknown) { this.children.push(o); } };
      sys.addTo(probe as never);
      // 3 distinct types in the input → 3 meshes added to the scene.
      expect(probe.children).toHaveLength(3);
      expect(sys.metas).toHaveLength(nodes.length);
    } finally {
      sys.dispose();
    }
  });

  it("metas include the source type so the inspector can group them", () => {
    const nodes: ExplorerNode[] = [
      node("f", "feature"),
      node("w", "workflow"),
      node("t", "tension"),
    ];
    const sys = new NodeSystem(nodes);
    try {
      const types = sys.metas.map((m) => m.type).sort();
      expect(types).toEqual(["feature", "tension", "workflow"]);
    } finally {
      sys.dispose();
    }
  });

  it("setSelected/setHovered are idempotent and survive id transitions", () => {
    const nodes: ExplorerNode[] = [node("a", "feature"), node("b", "workflow")];
    const sys = new NodeSystem(nodes);
    try {
      sys.applyLayout([
        { id: "a", x: 0, y: 0, z: 0 },
        { id: "b", x: 5, y: 0, z: 0 },
      ]);
      sys.setSelected("a");
      sys.setSelected("a"); // no-op
      sys.setHovered("b");
      sys.setHovered(null);
      // Switching selection should not throw on the prior id and should
      // continue to report correct positions (highlight state is purely
      // visual — coords are invariant under it).
      sys.setSelected("b");
      expect(sys.getPosition("b")).toEqual({ x: 5, y: 0, z: 0 });
      sys.setSelected(null);
      expect(sys.getPosition("a")).toEqual({ x: 0, y: 0, z: 0 });
    } finally {
      sys.dispose();
    }
  });

  it("setSelected/setHovered ignore unknown ids without throwing", () => {
    const sys = new NodeSystem([node("a", "feature")]);
    try {
      expect(() => sys.setSelected("ghost")).not.toThrow();
      expect(() => sys.setHovered("ghost")).not.toThrow();
    } finally {
      sys.dispose();
    }
  });

  it("getPosition returns null for unknown ids", () => {
    const sys = new NodeSystem([node("a", "feature")]);
    try {
      expect(sys.getPosition("ghost")).toBeNull();
    } finally {
      sys.dispose();
    }
  });

  it("dispose clears metas and lookup map", () => {
    const sys = new NodeSystem([node("a", "feature")]);
    sys.dispose();
    expect(sys.metas).toHaveLength(0);
    expect(sys.getPosition("a")).toBeNull();
  });
});
