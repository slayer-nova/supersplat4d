# Spark player / editor backlog (2026-07-11) — 待做清單

Grounded facts: vendored `spark.module.js` 2.1.0 confirmed to contain `SparkControls`, `FpsMovement`,
`PointerControls`, `textSplats`, `imageSplats`, `dyno`, `SplatGenerator`, `SplatEditSdf`,
`SplatSkinning`(48 refs), `apertureAngle`/`focalDistance`, `maxStdDev`, `sortRadial`. PlayCanvas
**2.16.0** in the fork ships `GSplatUnifiedSorter` + per-component `unified` flag (unused by the fork).
Live-deploy diagnosis (nerf-bullet-time/NewAra__Ani_Woman-spark): static `0408_v01_CUT2` =
**2,678,157 splats**, avatar rest.zip = **144 MB** → see P1/P2.

## A. Player — perf & UX fixes (from the drop-frame diagnosis)

- **P1 · Tail-loading indicator.** The load bar hides after HEADs, but rest.zip (can be >100 MB)
  streams for minutes with NO cue; during that window the audio-driven index does
  `% meshes.length` while the array grows → animation looks scrambled/dropping. Keep a slim
  progress line (or % text) until all tails complete.
- **P2 · Audio-index clamp during progressive load.** While `meshes.length < total`, hold the last
  loaded frame when `floor(audioTime*fps) >= meshes.length` instead of wrapping with `% length`
  (wrapping scrambles the phase every time a frame arrives). After full load, behavior unchanged.
- **P3 · Big-static playback cost (the real drop-frame cause).** Frame swaps flip SplatMesh
  visibility 30×/s → Spark re-sorts/re-accumulates the WHOLE visible set (2.7M splats in the field
  case) per swap; sorter lags behind → animation hitches while rAF stays 60fps. Investigate:
  (a) swap frames via per-splat opacity/dyno modifier instead of visibility flips (keeps the
  accumulated set stable?), (b) Spark sort options (`sortRadial`, update budgets), (c) export-time
  WARNING when a static object exceeds ~1M splats + optional decimation step, (d) `maxStdDev`
  quality knob exposed as a URL param.

## B. Player — Spark 2.1 feature adoption (quick wins)

- **B1 · Fly navigation**: `SparkControls`/`FpsMovement` as a toggleable mode beside OrbitControls —
  fixes the head-tuned camera envelope (maxDistance 2.0) for whole scenes. Small.
- **B2 · VR-visible watermark/title via `textSplats`**: the DOM watermark + buttons are invisible in
  a headset; render "Shooting Lab" + scene title as actual splats pinned in the scene. Small.
- **B3 · Flythrough depth-of-field**: `apertureAngle`/`focalDistance` during camera-path playback
  (cinematic showcase). Small.
- **B4 · dyno entrance/transition effects**: GPU per-splat fade-in/dissolve on load and (later)
  morph-style transitions between objects — no re-bake needed. Medium.
- **B5 · SDF highlight zones** (`SplatEditSdf`): spotlight/vignette/hide regions at runtime. Medium.

## C. Editor

- **C1 · Unified-sorting spike (do FIRST — likely fixes the viewport z-sort bug natively).**
  PlayCanvas 2.16.0 has `GSplatUnifiedSorter` + `gSplatComponent.unified`; the editor's
  atlas-always-in-front-of-statics artifact is per-object sorting + draw order. Spike (~0.5-1d):
  enable `unified: true` on our gsplat components; verify SuperSplat's custom selection/state
  shaders + our atlas in-place frame swapping still work. Risk: custom splat material may be
  incompatible with the unified path.
- **C2 · "Preview in Spark" button** (fallback / UX sugar, ~1d, zero risk): reuse the export
  pipeline in-memory → open the player in an iframe/new tab (blob URL) for WYSIWYG checks without
  manual export+unzip+serve.
- **C3 · Editor full switch to Spark: REJECTED** (entities/picking/state-texture
  selection/gizmos/pcui/sorter are PlayCanvas to the bone; months of rewrite + lose upstream).

## D. Research

- **D1 · `SplatSkinning` rig-driven avatar**: skeletal skinning of splats instead of 210 per-frame
  meshes — order-of-magnitude data reduction; needs rig data from the FLEX pipeline. Large.

## Suggested order

C1 spike → P1+P2 (small, pair) → P3 investigation → B1+B2+B3 → C2 → B4/B5 → D1.
