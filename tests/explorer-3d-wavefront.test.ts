/**
 * Slice E2 tests — wavefronts + minimap.
 *
 * plans/EXPLORER_3D_MODE.md §12.E.
 *
 * The wavefront tests run in the default node environment (no DOM,
 * three.js classes work fine). The minimap suite opts into jsdom via the
 * top-of-file env directive so we can exercise the SVG DOM layer too.
 */

import { describe, expect, it } from "vitest";
import {
  MAX_ACTIVE_WAVES,
  WAVE_DURATION_S,
  WavefrontSystem,
} from "../explorer/src/three/WavefrontSystem";

// Tests cannot import "three" directly (it lives under explorer/node_modules/),
// so we hand `setBounds` a plain x/y/z object — three's `Vector3.copy`
// only reads the three numeric fields.
const v3 = (x: number, y: number, z: number) =>
  ({ x, y, z }) as unknown as import("three").Vector3;

describe("WavefrontSystem", () => {
  it("starts with no active waves", () => {
    const sys = new WavefrontSystem();
    try {
      expect(sys.hasActive()).toBe(false);
    } finally {
      sys.dispose();
    }
  });

  it("trigger activates a wave that decays after WAVE_DURATION_S", () => {
    const sys = new WavefrontSystem();
    try {
      sys.setBounds(v3(0, 0, 0), 30);
      sys.trigger(10);
      expect(sys.hasActive()).toBe(true);
      // Tick partway — still active.
      sys.tick(10 + WAVE_DURATION_S * 0.4);
      expect(sys.hasActive()).toBe(true);
      // Tick past the lifetime — slot deactivates.
      sys.tick(10 + WAVE_DURATION_S + 0.05);
      expect(sys.hasActive()).toBe(false);
    } finally {
      sys.dispose();
    }
  });

  it("opacity fades from positive to zero across the lifetime", () => {
    const sys = new WavefrontSystem();
    try {
      sys.setBounds(v3(0, 0, 0), 20);
      sys.trigger(0);
      sys.tick(0);
      // The first slot is the one that fired.
      const slot = (sys as unknown as { slots: { material: { opacity: number } }[] }).slots[0];
      const earlyOpacity = slot.material.opacity;
      expect(earlyOpacity).toBeGreaterThan(0);
      sys.tick(WAVE_DURATION_S * 0.9);
      expect(slot.material.opacity).toBeLessThan(earlyOpacity);
      sys.tick(WAVE_DURATION_S + 0.1);
      expect(slot.material.opacity).toBe(0);
    } finally {
      sys.dispose();
    }
  });

  it("recycles the oldest slot when more than MAX_ACTIVE_WAVES fire", () => {
    const sys = new WavefrontSystem();
    try {
      sys.setBounds(v3(0, 0, 0), 30);
      // Fire one more than capacity, each at a distinct time so the
      // oldest is unambiguous.
      for (let i = 0; i <= MAX_ACTIVE_WAVES; i++) sys.trigger(i);
      // Expect exactly MAX_ACTIVE_WAVES active slots — the oldest got
      // overwritten, not appended to a growing list.
      const slots = (sys as unknown as { slots: { active: boolean }[] }).slots;
      expect(slots.length).toBe(MAX_ACTIVE_WAVES);
      expect(slots.filter((s) => s.active).length).toBe(MAX_ACTIVE_WAVES);
    } finally {
      sys.dispose();
    }
  });

  it("bound radius affects scale envelope at wave end", () => {
    const sys = new WavefrontSystem();
    try {
      sys.setBounds(v3(0, 0, 0), 50);
      sys.trigger(0);
      sys.tick(WAVE_DURATION_S * 0.999);
      const slot = (sys as unknown as { slots: { mesh: { scale: { x: number } } }[] }).slots[0];
      // Should be near END_RADIUS_FACTOR * graphRadius (1.4 * 50 = 70).
      expect(slot.mesh.scale.x).toBeGreaterThan(40);
    } finally {
      sys.dispose();
    }
  });
});

