## DreamGraph v8.2.1 — Bedrock

A visual-only patch release. No structural, schema, MCP-surface, or runtime-behavior changes — only Explorer 3D rendering polish and version metadata bumps.

### Explorer — 3D mode polish

The 3D Explorer canvas (Three.js) received an end-to-end visual pass focused on cinematic readability without sacrificing performance, contrast, or anti-blowout protection:

- **Glass nodes** — crystal-style instanced shader with depth gradient, hue-preserving roll-off (`col / (1 + k·peak)` where k=0.45), large-node specular highlights, and a softer rim
- **Atmospheric tubes** — additive flow tubes with hue-preserving roll-off (k=0.55), distance attenuation that fades far edges without crushing them, and protected fresnel/flow heads
- **Tone & lights** — ACES filmic tone mapping, exposure 1.10 (1.22 in photo mode), lifted ambient/hemispheric/key/fill lights for a luxury-dark UI rather than dim-cave mode
- **Anti-aliasing** — MSAA 4× render target plus an SMAA post-pass (lazy-loaded ~61 kB chunk)
- **Bloom** — UnrealBloom (strength 0.55, radius 0.35, threshold 0.85) on top of an EffectComposer pipeline
- **Halo & aura** — degree-adaptive node aura, softer multi-stop halo gradient, photo-mode supersample (devicePixelRatio × 2, capped at 4)
- **Atmospheric depth** — fog window tuned `r·1.1 → r·3.4` so distant tubes remain visible

### Documentation

- Guide page **7. The Explorer** now documents the 2D / 3D render-mode toggle, prefs (`renderMode`, `camera3d`, `cameraPresets3d`, `showGrid3d`, `bloom3d`), and per-mode interaction model
- Guide page **6. The VS Code extension** mentions the 2D / 3D toggle in the Explorer panel summary
- Guide **glossary** Explorer entry updated with both canvases
- Root `README.md` capability list and vocabulary updated to call out 2D/3D Explorer modes
- `docs/architecture.md` version bumped to **8.2.1**; extension blurb updated for 2D Sigma.js + 3D Three.js Explorer

### Versioning

- Core package version updated to `8.2.1`
- CLI/daemon package metadata updated to `8.2.1`
- VS Code extension package metadata updated to `8.2.1`
- Explorer package metadata updated to `8.2.1`
- Root README and installation documentation updated for **v8.2.1 — Bedrock**

### Compatibility

- No data-store schema changes, no migration steps required
- No MCP tool, resource, or workflow additions / removals
- No CLI surface changes
- All v8.2.0 instances upgrade in place — restart running daemons to load the new runtime, reload the VS Code window to pick up the new extension, reload the Explorer panel/tab to load the new SPA bundle

### Verified Against

- Release: `v8.2.1 — Bedrock`
- Core package version: `8.2.1`
- CLI/daemon version: `8.2.1`
- VS Code extension version: `8.2.1`
- Explorer version: `8.2.1`
