# Spark Export: SH-preserving statics (LiTo objects) — Design Spec v2

**Date:** 2026-07-12 (v2 — redesigned after adversarial review; v1's unbaked-transform design
is DEAD, see "Why baked" below)
**Repo:** supersplat4d fork, branch `flexavatar-atlas-4d`
**Context:** LiTo-generated PLYs carry SH degree 3 (45 `f_rest_*` props — view-dependent
specular). The current Spark export serializes ALL statics with `shDegree: 0`
(spark-export.ts:91,128), so LiTo props lose their look in the Spark player. Goal: selected
statics keep SH in the exported package; everything else (scanned scenes, avatar atlas frames)
stays on the compact SH0 path.

## Why baked (v1 postmortem — binding rationale)

v1 proposed exporting SH statics UNBAKED (raw data + node transform in the manifest) to avoid
rotating SH coefficients. Review killed it with three findings:
1. `keepWorldTransform: true` is NOT a no-transform mode — per-splat transform-PALETTE edits
   (selection move/rotate) are still baked in (splat-serialize.ts:247-251), so raw-getProp SH
   would desync from palette-rotated geometry.
2. Raw-getProp SH also skips the color-tint pipeline that f_dc goes through
   (splat-serialize.ts:425-476) — tinted objects would get adjusted DC with unadjusted SH.
3. **The serializer already rotates SH when baking**: `SplatTransformCache.getSHRot(i)` builds
   an `SHRotation` (src/sh-utils.ts) from the rotation of `getMat(i)` — the full world×palette
   matrix under `bakeFullWorldTransform: true` — and `SingleSplat.read` applies it to every
   requested `f_rest_*` member (splat-serialize.ts:411-423), plus tint (:465-476).

So the correct design is the SIMPLE one: bake SH statics exactly like SH0 statics, just with
`f_rest_*` in the SingleSplat member list. SH rotation, palette edits, and tint all come for
free from the existing serializer. No manifest transform, no player node changes, no
non-uniform-scale caveats, no reveal-effect frame inversion. Spark renders whatever the .spz
carries, per mesh.

## Validated facts (implementers: do not re-derive)

- spz-js `serializeSpz` takes `GaussianCloud { numPoints, shDegree, positions, scales,
  rotations, alphas, colors, sh: Float32Array }` with FLOAT sh — quantization happens inside
  (packGaussians: band 1 → 5-bit buckets, bands 2-3 → 4-bit buckets; values clamped to
  [-1.0, +0.992]).
- **serializeSpz returns a GZIP stream** (spz-serializer.js:42, CompressionStream('gzip')). The
  16-byte SPZ header — `shDegree` at byte offset 12 (spz-serializer.js:20) — exists only in the
  DECOMPRESSED payload. Any byte-level assertion must gunzip first.
- **spz per-point sh order** is pinned by spz-js's own PLY reader (ply-loader.js:175-180):
  interleaved `[c0.r, c0.g, c0.b, c1.r, …]`. The editor's SingleSplat data is channel-major
  planar (`f_rest_[ch * coeffs + c]`, splat-serialize.ts:182,414). Required transpose:
  `sh[(k * coeffs + c) * 3 + ch] = d[`f_rest_${ch * coeffs + c}`]` for splat k, coeff c,
  channel ch. (spz-loader.js only pins the band boundary — first 9 values/point = band 1.)
- `SingleSplat([...MEMBERS, ...shNames.slice(0, coeffs * 3)], { bakeFullWorldTransform: true })`
  reads position/scale/quat/color WITH the world×palette bake AND rotates+tints the f_rest
  members via getSHRot / the tint block (splat-serialize.ts:411-423, 465-476). `shNames` is the
  exported 45-name list at splat-serialize.ts:182.
- SH band count from prop presence: 9 f_rest → 1, 24 → 2, 45 → 3 (splat-serialize.ts:185-187);
  per-channel coeffs = {1: 3, 2: 8, 3: 15}[bands].
- LiTo PLY = SH3 (45 f_rest, verified on lamp_lito.ply). FLEX avatar atlas gaussians are SH0 by
  construction.
- Spark (@sparkjsdev/spark 2.1.0) renders SH per mesh (sh1/sh2/sh3 textures,
  evaluatePackedSH). `SplatMesh.maxSh` is consumed ONLY at generator construction
  (vendor/spark.module.js:12463 `context.splats.setMaxSh(this.maxSh)` inside
  constructGenerator); changing it later requires `m.updateGenerator()`
  (spark.module.js:12562-12568). Setting it immediately after `new SplatMesh(...)` — before
  the first render builds the generator — needs no update call and no await.
- The manifest object entry is built at spark-export.ts:259
  `manifestObjects.push({ id, type: 'static', src: `objects/${id}.spz`, numSplats: n })` —
  extend THIS push; do not construct a new entry shape (keeps `id`).
- exportMaxL2 / sceneRadius accumulation stays exactly as the baked path does today
  (baked x/z, spark-export.ts:83,118) — SH statics are baked, so nothing changes.

## Scope

```
src/spark-export.ts               MOD   SH detection + staticToSpzSh (baked, SH members) + manifest shDegree
src/ui/spark-export-dialog.ts     MOD   'Keep SH' select (off / lito / all), default 'lito'
public/spark-template/player.js   MOD   ?maxsh=N clamp only
```

Out of scope: SH for animated atlas frames (SH0 by construction), the demo repo's exporter
(web_demo — stays SH0), any player transform handling (nothing changes — packages stay fully
baked), world-frame SH rotation math (inherited from SingleSplat/SHRotation — nothing new).

## Exporter (`src/spark-export.ts`)

### Detection & selection

```ts
const detectShBands = (splat: any): number => {
    let count = 0;
    while (count < 45 && splat.splatData.getProp(`f_rest_${count}`)) count++;
    return ({ 9: 1, 24: 2, 45: 3 } as Record<number, number>)[count] ?? 0;
};
```

A static keeps SH when BOTH:
1. dialog `keepSh === 'all'`, or `keepSh === 'lito'` AND
   `String(splat.filename || splat.name || '').toLowerCase().includes('lito')`
   (matches `<stem>_lito.ply` and `lito_output*.ply`);
2. `detectShBands(splat) > 0`.

Otherwise the existing `staticToSpz` runs UNCHANGED (`keepSh === 'off'` short-circuits all
checks). The baked SH0 path must remain byte-for-byte identical — add `staticToSpzSh` as a new
function, do not thread flags through `staticToSpz`.

### `staticToSpzSh(splat, bands)` — same skeleton, three differences

1. Member list: `[...MEMBERS, ...shNames.slice(0, coeffs * 3)]` where
   `coeffs = { 1: 3, 2: 8, 3: 15 }[bands]` and `shNames` is imported from splat-serialize.ts
   (export it if not already exported — check; it is module-local today). Keep
   `{ bakeFullWorldTransform: true }`.
2. After `single.read(splat, i)`, in addition to the existing fields, transpose SH:
   `sh[(k * coeffs + c) * 3 + ch] = d[`f_rest_${ch * coeffs + c}`]` (c in [0,coeffs),
   ch in [0,3)). Allocate `sh = new Float32Array(n * coeffs * 3)` up front.
3. Call `serializeSpz({ ..., shDegree: bands, sh })`. Return `{ spz, n, shDegree: bands }`.

Everything else (deleted-state filter, quat normalization, exportMaxL2 accumulation from baked
x/z) is copied from `staticToSpz` verbatim.

### Manifest

Extend the EXISTING push (spark-export.ts:259) for SH-kept statics only:
`manifestObjects.push({ id, type: 'static', src: ..., numSplats: n, shDegree: 3 })`.
`shDegree` is informational (the .spz header is authoritative for the player); absent for
SH0 statics and all v1/old packages.

### Dialog (`src/ui/spark-export-dialog.ts`)

New row between "Entrance effect" and "Duration": label `Keep SH (view-dep. color)`,
SelectInput:
- `off` → `Off (smallest files)`
- `lito` → `LiTo objects only` (**defaultValue**)
- `all` → `All statics that have SH`

Add `keepSh: 'off' | 'lito' | 'all'` to `SparkExportOptions` + `collect()`; `show()` resets to
`'lito'`. No manifest.player field (export-time decision).

## Player (`public/spark-template/player.js`) — ?maxsh only

Parse `?maxsh` in `resolvePlayerConfig` → `maxShClamp` (integer 0..3, anything else → null).
Apply via `if (maxShClamp !== null) m.maxSh = maxShClamp;` **immediately after each
`new SplatMesh(...)`** — two choke points: the v2 statics loop (~line 921) and `addFrameTo`
(~line 338, covers all v1+v2 animated meshes). No await, no updateGenerator needed at
construction time (generator not yet built; spark.module.js:12604-12607 builds it on first
update). Do NOT set it later than construction — a post-build assignment silently no-ops
without `updateGenerator()`.

## Testing / gates

- `npx eslint src/spark-export.ts src/ui/spark-export-dialog.ts` clean;
  `node --check public/spark-template/player.js`; `npm run build` green.
- **Round-trip unit proof (controller, node + vendored spz-js):** serialize a small cloud with
  shDegree 3 and known sh values **inside [-0.9, +0.9]** (spz clamps to [-1.0, +0.992]);
  `loadSpz` it back (the loader gunzips internally); assert per-value error
  ≤ 4.5/128 (≈0.036) for the first 9 sh values of each point (band 1, 5-bit buckets) and
  ≤ 8.5/128 (≈0.067) for the rest (bands 2-3, 4-bit buckets). This pins the transpose.
- **Live smoke (controller):** editor at :3000 — import `dist/lito/lito_apple_test.ply` (SH3),
  load a NewAra atlas avatar, MOVE + ROTATE the apple via its entity, export with
  Keep SH = 'LiTo objects only'. Assert in the zip: **gunzip the apple .spz entry
  (zlib.gunzipSync), then decompressed[12] === 3**; avatar frame spz gunzipped byte 12 === 0;
  manifest apple entry has `shDegree: 3` and keeps `id`; NO transform field anywhere. Serve
  the package; screenshot — apple at the editor pose (bake correctness incl. SH rotation path);
  load again with `?maxsh=0` — still renders (clamp path).
- Regression: export with Keep SH = Off → structure identical to pre-feature exporter.

## Constraints

- Fork only (no web_demo changes). No new npm dependencies.
- `staticToSpz` (SH0 path) byte-for-byte identical behavior.
- Commit style `feat(spark): …`; NEVER push origin; backup push only on explicit request.
- Size sanity (not a gate): SH3 ≈ +45 quantized bytes/splat pre-gzip; lamp (358K) ≈ +10 MB.
