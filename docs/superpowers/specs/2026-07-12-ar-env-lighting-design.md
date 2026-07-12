# AR Environment Lighting (Android WebXR light-estimation → SplatEdit grading) — Design Spec

**Date:** 2026-07-12
**Repo:** supersplat4d fork, branch `flexavatar-atlas-4d`
**Goal:** In AR mode on Android (Chrome/ARCore), the exported Spark player estimates the real
room's lighting per frame and grades ALL splats (statics + the FlexAvatar performance frames)
to match — brightness + color temperature via a global MULTIPLY layer, plus a directional
accent from the primary light estimate. Toggleable: export-dialog option + URL param. Target
platform is Android; devices without `light-estimation` (Meta Quest, desktop) silently no-op.

## Validated facts (scouted from the vendored Spark 2.1.0 + player.js — do not re-derive)

- Vendored `spark.module.js` exports `SplatEdit`, `SplatEditSdf`, `SplatEditSdfType`,
  `SplatEditRgbaBlendMode` with blend modes `MULTIPLY` (`target = rgba * sdfRgba`),
  `SET_RGB`, `ADD_RGBA` (`target = rgba + sdfRgba`); the blend is `mix(rgba, target, modulate)`
  where `modulate` comes from SDF distance/softEdge (shader at ~line 8975).
- A `SplatEdit` whose ancestry does NOT contain a SplatMesh is a **global edit** applied to
  every editable SplatMesh (SparkRenderer gathers via `scene.traverseVisible`, ~line 9554;
  `SplatMesh.editable` defaults true, line 12210) — avatar per-frame meshes included.
  Parenting the layers under our root `group` is fine (group is a THREE.Group).
- `SplatEditSdf extends THREE.Object3D` (line 8496): `{ type: SplatEditSdfType.SPHERE, color,
  radius, opacity }`, positioned via normal Object3D transforms (world space).
- player.js: `enterXR(mode)` requests sessions at line ~174 with
  `optionalFeatures: ['local-floor', 'bounded-floor', 'hand-tracking', 'dom-overlay']`; render
  loop is `renderer.setAnimationLoop((t) => { ... })` at line ~724 — three.js passes
  `(time, xrFrame)`; the second argument is currently unused. `renderer.xr.enabled = true`.
- WebXR Lighting Estimation: `session.requestLightProbe()` (throws/rejects when the feature
  wasn't granted); per frame `xrFrame.getLightEstimate(probe)` → may be null early; result has
  `sphericalHarmonicsCoefficients` (Float32Array(27), coefficient-major RGB interleaved:
  [r0,g0,b0, r1,g1,b1, …]), `primaryLightDirection` (DOMPointReadOnly, unit vector pointing
  FROM the probe TOWARD the light), `primaryLightIntensity` (DOMPointReadOnly rgb, HDR,
  can exceed 1). Chrome/ARCore implements this ONLY for immersive-ar on Android.
  `XRLightProbe.probeSpace` exists but v1 ignores it (treat estimate as viewer-local ambient).
- `manifest.sceneRadius` is available at load (used by reveal/zoom); fallback 0.35.
- README.md at the package root documents URL params (shipped since cc7b947) — MUST be updated.

## Option plumbing (follows the established pattern exactly)

- Export dialog (`src/ui/spark-export-dialog.ts`): BooleanInput row `AR environment lighting`
  (below 'Offline cache'), default **true**; `arLight: boolean` added to `SparkExportOptions`
  + `collect()`; no per-show reset needed beyond the existing pattern (match Offline cache row).
- Exporter (`src/spark-export.ts`): `manifest.player.arLight = options.arLight` (write the
  field always, true or false — explicit is easier to debug than absence).
- Player precedence: `?arlight=on|off` > `manifest.player.arLight` > **off** (old packages
  unchanged). Parse in `resolvePlayerConfig` into `arLightEnabled` alongside the other params
  (same warn-on-garbage style).
- Debug mode: `?arlightdebug=1` — forces the grading layers ON outside AR with a synthetic
  animated estimate (slow sine: brightness 0.25→1.1, tint warm→cool, light direction orbiting).
  Purpose: desktop verification + effect tuning without a phone. Works regardless of arlight
  flag; document in README under a "debug" note.

## Player implementation (`public/spark-template/player.js` — the only runtime file)

### Session request
Add `'light-estimation'` to `optionalFeatures` for BOTH modes (optional = harmless where
unsupported; only AR grants it in practice).

### Module state + layers (lazy, created on first activation)

```js
let arLightLayers = null;   // { ambientEdit, ambientSdf, primaryEdit, primarySdf }
let lightProbe = null;      // XRLightProbe when granted
let arLightActive = false;  // layers currently applied
```

`createArLightLayers()`:
- ambient: `new SplatEdit({ rgbaBlendMode: SplatEditRgbaBlendMode.MULTIPLY, sdfSmooth: 0.1,
  softEdge: 1.0 })` + one `SplatEditSdf` SPHERE, `radius = Math.max(10, sceneRadius * 6)`,
  positioned at the scene center (0, 0, 0 in group space), `color` white, `opacity: 1`.
  The big radius makes MULTIPLY effectively uniform over the whole scene.
- primary: `new SplatEdit({ rgbaBlendMode: SplatEditRgbaBlendMode.ADD_RGBA, sdfSmooth: 0.1,
  softEdge: 1.2 })` + one SPHERE SDF, `radius = Math.max(2, sceneRadius * 2)`, color black
  (no-op) until the first estimate.
- Both `SplatEdit`s added as children of the root `group` (global edits — not under any
  SplatMesh). Store refs; `removeArLightLayers()` detaches them (session end / debug off).

### Activation
- On AR session start (inside `enterXR` after `requestSession` succeeds, only when
  `mode === 'immersive-ar'` AND `arLightEnabled`): `lightProbe = await
  session.requestLightProbe().catch(() => null)`; if null (Quest/desktop-AR-emu), log once
  `'AR light estimation unavailable — skipping'` and do nothing. If granted: create/attach
  layers, `arLightActive = true`.
- `session.addEventListener('end', …)`: detach layers, `lightProbe = null`,
  `arLightActive = false`. (The existing enterXR already tracks session end for controls —
  hook the same place.)

### Per-frame update (render loop)
Change the loop signature to `(t, xrFrame)`. When `arLightActive && xrFrame && lightProbe`:

```js
const est = xrFrame.getLightEstimate(lightProbe);
if (est) applyLightEstimate(est);
```

`applyLightEstimate(est)` — all constants are TUNABLE, keep them as named consts at the top
of the block:
- Ambient from SH L0: `E_c = sh[c] * 0.886227` for c = r,g,b (first 3 floats). Luminance
  `Y = 0.2126*E_r + 0.7152*E_g + 0.0722*E_b`.
  - brightness multiplier `m = clamp(Y / AR_REF_LUMA, AR_MIN_MUL, AR_MAX_MUL)` with
    `AR_REF_LUMA = 0.8`, `AR_MIN_MUL = 0.15`, `AR_MAX_MUL = 1.25`.
  - tint `T_c = E_c / max(Y, 1e-4)` clamped to [0.5, 2.0], then normalized so
    `max(T_r,T_g,T_b) = 1` (tint only shifts hue, never brightens).
  - `ambientSdf.color.setRGB(m*T_r, m*T_g, m*T_b)` — MULTIPLY grades every splat.
- Primary light: `d = primaryLightDirection` (unit, TOWARD the light).
  `primarySdf.position` = group-local position of `sceneCenter + d * (sceneRadius * 3)`
  (transform the world-space offset into `group` local space with
  `group.worldToLocal(...)` so a user-grabbed scene stays consistent).
  Intensity `I_c = primaryLightIntensity.{x,y,z}`; tone-map `a_c = I_c / (1 + I_c)` and
  `primarySdf.color.setRGB(a_r*AR_PRIMARY_GAIN, …)` with `AR_PRIMARY_GAIN = 0.35`,
  `primarySdf.opacity = 1`. ADD_RGBA adds a soft directional glow on the light-facing side.
- Throttle: applying every frame is fine (SplatEdit uploads are tiny); no throttling in v1.

### Debug mode (`?arlightdebug=1`)
On load (after scene ready): create/attach the same layers, and in the render loop feed a
synthetic estimate: `Y` sweeping 0.15→1.1 over 8 s (sine), tint oscillating warm (1,0.85,0.7)
↔ cool (0.8,0.9,1), light direction orbiting the Y axis at 0.2 rad/s with intensity (1,1,0.9).
Reuses `applyLightEstimate` with a duck-typed object — keep the function agnostic (read
`.sphericalHarmonicsCoefficients`, `.primaryLightDirection`, `.primaryLightIntensity` as
plain arrays/objects).

## README.md (package root — ships with every export)

Add to the params table:
`arlight` | `on` `off` | 匯出時的選項(預設 off) | AR 模式讀取手機環境光(Android),讓
模型亮度/色溫貼合現場;Quest/不支援的裝置自動忽略
Plus a debug note for `arlightdebug=1` and one example combo (`?arlight=on`).

## Testing / gates

- `npx eslint src/ui/spark-export-dialog.ts src/spark-export.ts`; `node --check player.js`;
  `npm run build`.
- **Desktop smoke (controller):** export a package with AR lighting ON (dialog default),
  assert `manifest.player.arLight === true`; serve; load `?arlightdebug=1&reveal=off` →
  screenshots at two phases of the synthetic sweep (dark-warm vs bright-cool) must differ
  visibly; load WITHOUT the debug flag → renders identical to before (layers never created;
  no console errors); `?arlight=off` + debug still works (debug is independent).
- **Real AR:** requires the user's Android phone over https — hand over test steps, not a gate.

## Constraints

- Fork only; player.js + dialog + exporter + README. No new deps (SplatEdit ships in the
  vendored Spark). Reveal/campath/watermark/zoom/offline/maxsh behavior untouched.
- VR mode: do NOT activate layers (no estimate exists; VR scene is fully virtual).
- Commit style `feat(spark): …`; NEVER push origin; backup push on explicit request only.
