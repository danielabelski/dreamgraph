/**
 * Slice E2 minimap tests — pure SVG layer, runs under jsdom.
 *
 * @vitest-environment jsdom
 *
 * plans/EXPLORER_3D_MODE.md §12.E.
 */

import { describe, expect, it } from "vitest";
import { Minimap3D } from "../explorer/src/three/Minimap3D";

const SIZE = 140;

describe("Minimap3D", () => {
  it("renders an SVG with the expected size and is hidden from input", () => {
    const m = new Minimap3D();
    try {
      const svg = m.element;
      expect(svg.tagName.toLowerCase()).toBe("svg");
      expect(svg.getAttribute("width")).toBe(String(SIZE));
      expect(svg.getAttribute("height")).toBe(String(SIZE));
      // pointer-events:none ensures the overlay doesn't steal canvas clicks.
      expect(svg.getAttribute("style") ?? "").toContain("pointer-events:none");
    } finally {
      m.dispose();
    }
  });

  it("setNodes draws one dot per node (within cap)", () => {
    const m = new Minimap3D();
    try {
      m.setNodes([
        { id: "a", x: -5, z: 0 },
        { id: "b", x: 5, z: 0 },
        { id: "c", x: 0, z: 5 },
      ]);
      const dots = m.element.querySelectorAll(".minimap-nodes circle");
      expect(dots.length).toBe(3);
    } finally {
      m.dispose();
    }
  });

  it("setNodes downsamples when above the 800-point cap", () => {
    const m = new Minimap3D();
    try {
      const positions = Array.from({ length: 1600 }, (_, i) => ({
        id: `n${i}`,
        x: i,
        z: i,
      }));
      m.setNodes(positions);
      const dots = m.element.querySelectorAll(".minimap-nodes circle");
      // 1600 / ceil(1600/800) = 800, so we expect at most 800.
      expect(dots.length).toBeLessThanOrEqual(800);
      expect(dots.length).toBeGreaterThan(0);
    } finally {
      m.dispose();
    }
  });

  it("setCamera updates the camera marker and frustum path", () => {
    const m = new Minimap3D();
    try {
      m.setNodes([
        { id: "a", x: -10, z: -10 },
        { id: "b", x: 10, z: 10 },
      ]);
      // Plain object stand-ins for the three.js types — Minimap3D only
      // reads the documented properties, so a structural duck works.
      const camera = {
        position: { x: 0, y: 20, z: -20 },
        fov: 50,
        aspect: 16 / 9,
      } as unknown as import("three").PerspectiveCamera;
      const target = { x: 0, y: 0, z: 0 } as unknown as import("three").Vector3;
      m.setCamera(camera, target);
      const dot = m.element.querySelector("circle:not(.minimap-nodes circle)");
      expect(dot).toBeTruthy();
      const path = m.element.querySelector("path");
      expect(path?.getAttribute("d")).toBeTruthy();
      expect(path!.getAttribute("d")!.length).toBeGreaterThan(0);
    } finally {
      m.dispose();
    }
  });

  it("attachTo / dispose cleanly add and remove from a parent", () => {
    const m = new Minimap3D();
    const host = document.createElement("div");
    document.body.appendChild(host);
    try {
      m.attachTo(host);
      expect(host.contains(m.element)).toBe(true);
      m.dispose();
      expect(host.contains(m.element)).toBe(false);
    } finally {
      host.remove();
    }
  });
});
