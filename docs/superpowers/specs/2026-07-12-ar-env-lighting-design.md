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
- `sdf.opacity` is packed as the W of the SDF rgba (`values[0].set(sdf.color.r, .g, .b,
  sdf.opacity)`, line 8733) and rides IN the blend arithmetic — it does NOT scale `modulate`.
  ADD_RGBA therefore adds the FULL vec4 **including alpha** (lines 8981-8988). Opacity
  semantics differ per blend mode: the ADD identity is color black + opacity **0**; the
  MULTIPLY identity is color white + opacity **1** (alpha × 1 = unchanged).
- `modulate = clamp(-distance / softEdge + 0.5, 0, 1)` (lines 8938-8939) with SPHERE
  `distance = length(p) - radius` (line 8848): the gradient band is only ±softEdge/2 around
  the sphere SURFACE; splats deeper inside than softEdge/2 all saturate at modulate = 1.
- SDF association: Spark uses the `edit.sdfs` list first if non-null (`addSdf()`, line 12665),
  else gathers `SplatEditSdf` CHILDREN via `edit.traverseVisible` (line 12670). The SDF's
  spatial frame comes exclusively from `sdf.matrixWorld` (line 8728), applied to WORLD-space
  gsplat centers (`modify()` runs after `transform.applyGsplat`, line 12485) — an SDF
  registered via `addSdf()` but not parented into the scene graph ignores `group`'s transform.
- The FIRST time edits reach a mesh, `SplatMesh.update` allocates `rgbaDisplaceEdits` and sets
  `generatorDirty` → `constructGenerator` (lines 12677-12699): a one-time dyno-graph/program
  rebuild PER editable mesh (accumulator program cache is keyed per generator object, ~9353).
  Steady-state color/position/softEdge changes are change-detected uniform/texture writes
  (encode path 8658-8752, capacity floor 16 so no realloc) — no recompile.
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
- WebXR Lighting Estimation: `session.requestLightProbe()` — REJECTS when the feature wasn't
  granted, and on platforms where the method is entirely absent (Quest builds without the
  lighting-estimation module, Safari/visionOS) the call THROWS a synchronous TypeError, which
  a plain `.catch()` never sees; per frame `xrFrame.getLightEstimate(probe)` → may be null early; result has
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
  unchanged). Intent, explicitly: new exports default ON via the dialog (which writes
  `manifest.player.arLight = true`); the built-in player default **off** applies ONLY to
  packages without `manifest.player.arLight`. Parse in `resolvePlayerConfig` into
  `arLightEnabled` alongside the other params (same warn-on-garbage style).
- Debug mode: `?arlightdebug=1` — forces the grading layers ON outside AR with a synthetic
  animated estimate (slow sine: brightness 0.15→1.1, tint warm→cool, light direction orbiting).
  Purpose: desktop verification + effect tuning without a phone. Works regardless of arlight
  flag; document in README under a "debug" note.

## Player implementation (`public/spark-template/player.js` — the only runtime file)

### Session request
Add `'light-estimation'` to `optionalFeatures` for BOTH modes (optional = harmless where
unsupported; only AR grants it in practice).

### Module state + layers (created once at load when enabled)

```js
let arLightLayers = null;   // { ambientEdit, ambientSdf, primaryEdit, primarySdf }
let lightProbe = null;      // XRLightProbe when granted
let arLightActive = false;  // estimates currently being applied (layers stay attached)
```

When `arLightEnabled` (or `?arlightdebug=1`), create and attach the layers **once at load**,
right after scene setup, with identity values (ambient: white, opacity 1 — MULTIPLY identity;
primary: black, opacity 0 — ADD identity), so the one-time per-mesh generator rebuild (vendor
spark.module.js:12677-12688 — it hits EVERY editable SplatMesh: all avatar frame meshes +
statics, each missing the per-generator program cache) happens behind the loading bar instead
of at AR session start. AR activation/deactivation then only flips `arLightActive` and writes
colors (uniform-only updates — no recompile).

`createArLightLayers()` — all geometry derives from one clamped
`const R = Math.max(sceneRadius, 0.05)`:
- ambient: `new SplatEdit({ rgbaBlendMode: SplatEditRgbaBlendMode.MULTIPLY, sdfSmooth: 0.1,
  softEdge: 1.0 })` + one `SplatEditSdf` SPHERE, `radius = Math.max(10, R * 6)`,
  positioned at the scene center (0, 0, 0 in group space), `color` white, `opacity: 1`
  (MULTIPLY identity: alpha × 1 = unchanged, vendor spark.module.js:8975-8976).
  The big radius makes MULTIPLY effectively uniform over the whole scene — the absolute
  floor is fine HERE because uniform coverage is intended.
- primary: `new SplatEdit({ rgbaBlendMode: SplatEditRgbaBlendMode.ADD_RGBA, sdfSmooth: 0.1,
  softEdge: R * 3.5 })` + one SPHERE SDF, `radius = R * 2.5`, offset `d * (R * 3)` from the
  group origin (see per-frame update), color black, `opacity: 0` — **always**. ADD_RGBA adds
  alpha too (vendor spark.module.js:8982); a nonzero opacity adds `modulate * opacity` to every
  affected splat's alpha, opacifying semi-transparent splats (hair wisps, silhouette
  anti-aliasing) and hardening the whole avatar. Color-only additive accent = the alpha
  component must stay 0. Note opacity semantics differ per blend mode: MULTIPLY needs 1,
  ADD_RGBA needs 0.
  Geometry rationale: the sphere SURFACE must pass through the scene — the softEdge band
  around distance 0 is what creates the directional gradient (modulate math at vendor
  spark.module.js:8938). With radius 2.5R / offset 3R the SDF distance across the scene spans
  ≈ [-0.5R, +1.5R], so modulate falls from ~0.6 on the light-facing side to ~0 on the far
  side. NO absolute floors (`Math.max(2, …)`) and no fixed softEdge: those are valley-scale
  constants that saturate modulate to a uniform 1.0 across any head-scale scene
  (sceneRadius ≲ 0.65, incl. the default fallback 0.35) — the same class of scale bug the
  reveal effect fixed with revealK. `SplatEdit.softEdge` is re-encoded every frame (vendor
  spark.module.js:8716-8723), so setting it in `createArLightLayers()` after `sceneRadius`
  is known is safe.
- Attach each `SplatEditSdf` as a THREE **child** of its `SplatEdit` via `edit.add(sdf)` and
  leave `edit.sdfs` null — Spark gathers child SDFs by traversal (vendor
  spark.module.js:12670) and reads the SDF's frame from `matrixWorld` (8728), so the SDF MUST
  be in the scene graph under `group` for group-space positions to be correct. Do NOT use
  `addSdf()` alone: an orphan SDF ignores `group`'s transform, which is guaranteed to
  misplace the primary accent after the automatic `recenter()` 350 ms into every XR session
  (player.js:297). Keep both `SplatEdit`s at identity transform directly under the root
  `group` (global edits — not under any SplatMesh); the child SDFs then inherit grab/scale
  automatically. Store refs. Layers stay attached for the page's lifetime — deactivation
  resets colors/opacity to the identity values above instead of detaching (no re-rebuild,
  and `?arlightdebug=1` layers survive XR round-trips).

### Activation
- After `await renderer.xr.setSession(session)` resolves (NEVER between `requestSession` and
  `setSession` — a throw there would abort AR entry on exactly the platforms that must
  silently no-op), run:

  ```js
  let probe = null;
  if (mode === 'immersive-ar' && arLightEnabled &&
      typeof session.requestLightProbe === 'function') {
    try { probe = await session.requestLightProbe(); } catch (e) { probe = null; }
  }
  ```

  A plain `.catch()` misses the synchronous TypeError thrown when the method itself is absent
  (Quest builds without the lighting-estimation module, Safari/visionOS) — hence the `typeof`
  guard + try/catch. If null (Quest/desktop-AR-emu), log once
  `'AR light estimation unavailable — skipping'` and do nothing.
- If granted: bail out unless the session is still current
  (`renderer.xr.getSession() === session` and `!session.ended` — the user may have exited
  during the await; otherwise the flags leak and the layers keep the previous room's grading).
  Then reset `ambientSdf.color` to white and `primarySdf.color` to black so the new session
  starts neutral until the first estimate lands, and set `lightProbe = probe`,
  `arLightActive = true`. (Layers already exist from load — nothing to create here.)
- Session end: hook the existing module-level `renderer.xr.addEventListener('sessionend', …)`
  (player.js:299 — the same handler that resets the group transform; `enterXR` itself tracks
  no session end): set `arLightActive = false`, `lightProbe = null`, and reset both SDF
  colors to identity (ambient white, primary black). Do NOT detach the layers — they were
  created at load, and detaching would kill `?arlightdebug=1` grading after one XR
  round-trip; the identity reset is harmless in debug mode because the synthetic estimate
  rewrites the colors every frame. VR sessions never grant a probe, so the unconditional
  reset is a no-op for them.

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
- Primary light: `d = primaryLightDirection` (unit, TOWARD the light), read ONLY via
  `.x/.y/.z` (DOMPointReadOnly is not numerically indexable). Placement is fully
  group-local: each frame, rotate the world-space light direction into group space
  (`dirLocal = _v.set(d.x, d.y, d.z)
  .applyQuaternion(group.getWorldQuaternion(_q).invert()).normalize()`) and set
  `primarySdf.position.copy(dirLocal).multiplyScalar(R * 3)` — offset AND radius then live
  in the same (group-local) units, so recenter/grab/scale cannot decouple them; the
  per-frame recompute keeps the accent world-stable under group rotation. `sceneCenter` :=
  the group origin (0, 0, 0 in group space). Off-center v2 scenes degrade the primary
  placement (accepted — same convention as the reveal effect); `sceneRadius` is XZ-only.
  Intensity `I_c = primaryLightIntensity.{x,y,z}` (again `.x/.y/.z` ONLY); tone-map
  `a_c = I_c / (1 + I_c)` and `primarySdf.color.setRGB(a_r*AR_PRIMARY_GAIN, …)` with
  `AR_PRIMARY_GAIN = 0.35`. `primarySdf.opacity` stays 0, always — ADD_RGBA adds alpha too
  (vendor spark.module.js:8982); a nonzero opacity opacifies semi-transparent splats. A
  color-only additive accent = the alpha component must stay 0. ADD_RGBA then adds a soft
  directional glow on the light-facing side.
- Throttle: applying every frame is fine (SplatEdit uploads are tiny); no throttling in v1.

### Debug mode (`?arlightdebug=1`)
On load (after scene ready): create/attach the same layers, and in the render loop feed a
synthetic estimate: `Y` sweeping 0.15→1.1 over 8 s (sine), tint oscillating warm (1,0.85,0.7)
↔ cool (0.8,0.9,1), light direction orbiting the Y axis at 0.2 rad/s with intensity (1,1,0.9).
Reuses `applyLightEstimate` with a duck-typed object. Pin the contract explicitly — the
ambiguity that matters breaks REAL AR, the one path with no automated gate:
`sphericalHarmonicsCoefficients` is read by numeric index (`sh[0..2]` — works for both the
real Float32Array(27) and a plain Array); `primaryLightDirection` and
`primaryLightIntensity` are read ONLY via `.x/.y/.z` (real estimates are DOMPointReadOnly —
`[0]`/`[1]`/`[2]` return undefined → NaN colors on the phone while an array-shaped debug
fake still passes desktop smoke). The synthetic estimate MUST therefore supply `{x, y, z}`
objects for both, and its SH values must be L0 coefficients (divide the desired irradiance
by 0.886227) so the debug sweep range matches the documented brightness range.

## README.md (package root — ships with every export)

Add to the params table:
`arlight` | `on` `off` | 預設跟隨匯出設定(新匯出的包預設 on,經 `manifest.player.arLight`;
舊包/未設定時預設 off) | AR 模式讀取手機環境光(Android),讓
模型亮度/色溫貼合現場;Quest/不支援的裝置自動忽略
Plus a debug note for `arlightdebug=1` and one example combo (`?arlight=on`).

## Testing / gates

- `npx eslint src/ui/spark-export-dialog.ts src/spark-export.ts`; `node --check player.js`;
  `npm run build`.
- **Desktop smoke (controller):** export a package with AR lighting ON (dialog default),
  assert `manifest.player.arLight === true`; serve; load `?arlightdebug=1&reveal=off` →
  screenshots at two phases of the synthetic sweep (dark-warm vs bright-cool) must differ
  visibly, the bright side must visibly TRACK the orbiting light direction (guards against
  modulate saturating to a uniform wash), and splat-edge softness must be preserved (hair
  wisps / silhouette stay semi-transparent — guards against the ADD-alpha opacity bug);
  load WITHOUT the debug flag → renders identical to before (the layers DO exist with
  identity values when `manifest.player.arLight` is true — identity MULTIPLY/ADD leaves rgba
  untouched; no console errors); `?arlight=off` + debug still works (debug is independent).
- **Real AR:** requires the user's Android phone over https — hand over test steps, not a gate.

## Constraints

- Fork only; player.js + dialog + exporter + README. No new deps (SplatEdit ships in the
  vendored Spark). Reveal/campath/watermark/zoom/offline/maxsh behavior untouched.
- VR mode: do NOT activate layers (no estimate exists; VR scene is fully virtual).
- Commit style `feat(spark): …`; NEVER push origin; backup push on explicit request only.
