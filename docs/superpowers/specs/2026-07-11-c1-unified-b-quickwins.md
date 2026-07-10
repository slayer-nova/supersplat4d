# C1 unified-sorting spike + B Spark quick wins — combined brief (2026-07-11)

Repo: `D:/2026/flexavatar/supersplat_spike/supersplat4d`, branch `flexavatar-atlas-4d`, IN PLACE.
NEVER push. Gates: file-scoped `npx eslint <ts files>`, `npm run build`,
`node --check public/spark-template/player.js` (repo-wide lint/tsc are RED pre-existing).

**Spark API ground truth (READ these, the vendored bundle is minified):**
`C:/Users/Admin/AppData/Local/Temp/claude/D--2026-flexavatar/0ba2b49d-f6b1-4113-8353-582b1a598433/scratchpad/spark-api/node_modules/@sparkjsdev/spark/`
— `README.md` + `dist/types/*.d.ts` (SparkRenderer.d.ts: `focalDistance`, `apertureAngle` instance
props; `controls.d.ts`: SparkControls/FpsMovement/PointerControls; `generators.d.ts` /
`splatConstructors.d.ts`: textSplats; `SplatMesh.d.ts`: mesh options incl. opacity if present).
The PLAYER imports from the vendored `./vendor/spark.module.js` — verify any symbol you use is
actually exported by the vendored 2.1.0 bundle (grep it) before relying on it.

---

## C1 — editor unified-sorting SPIKE (timeboxed; either outcome is a valid result)

**Problem:** editor viewport composites splat objects per-object (each has its own sorter) → the 4D
atlas always renders in front of statics regardless of depth. Display-only; data is fine. Spark
sorts globally and is correct (user-verified).

**Hypothesis:** PlayCanvas 2.16.0 ships `GSplatUnifiedSorter` and `GSplatComponent.unified` — the
engine-level cross-splat global sort. The fork never sets it (`splat.ts:197
entity.addComponent('gsplat', { asset })`).

**Spike protocol:**
1. READ the engine first: `node_modules/playcanvas/build/playcanvas.mjs` — find how `unified` is
   consumed (component data option? property? engine scene setting?), what the unified path changes
   about `entity.gsplat.instance` (does `instance`, `instance.sorter`, `instance.material`,
   `instance.resource` still exist / behave the same?). Also `node_modules/playcanvas/README`/types
   if present.
2. INVENTORY the fork's per-instance dependencies before changing anything:
   `grep -n "gsplat.instance" src/*.ts` — splat.ts uses `instance.sorter.setMapping` (sog4d dynamic),
   `instance.material` (state/selection shader), `instance.resource.updateTransformData/ColorData`
   (OUR atlas per-frame swap), `instance.meshInstance` etc. List every touchpoint and check each
   against the unified path's API surface.
3. TRY the minimal change: `entity.addComponent('gsplat', { asset, unified: true })` (or whatever
   the engine actually accepts) → `npm run build` → static analysis of the touchpoints.
4. VERDICT:
   - **WORKS** (build green + every touchpoint verified available/equivalent under unified):
     commit the change + a findings doc. The controller does the visual browser check afterwards.
   - **INCOMPATIBLE** (any touchpoint breaks — likely `instance.*` is per-object-path only):
     REVERT all code edits (working tree clean), commit ONLY a findings doc
     (`docs/superpowers/backlog/2026-07-11-c1-unified-spike-findings.md`) stating precisely which
     API breaks where (file:line), and the recommendation (C2 preview button as the fallback).
   Timebox: do not refactor the editor to fit unified — that is out of spike scope by definition.

---

## B — player template quick wins (all in `public/spark-template/{player.js,index.html}`)

Shared rules: zero behavior change unless the feature activates; keep v1/v2 + camera-path +
XR/grab/recenter + 🔊/🎥 semantics intact; all new UI buttons follow the existing pill styling and
stack in the bottom-left column (🔊 16px/22px, 🎥 16px/64px, new 🕹 at 16px/106px); buttons hidden
when the feature is unavailable.

### B1 · Fly navigation toggle (🕹 `#nav`)
- Import the controls from the vendored spark bundle (verify exports: `SparkControls` or
  `FpsMovement` + `PointerControls` — use what the 2.1.0 bundle actually exports; read
  `controls.d.ts` for constructor/update signatures).
- A `#nav` button toggles Orbit ↔ Fly. Fly mode: OrbitControls disabled, Spark controls
  `update(...)` called per frame (whatever the .d.ts says — likely `update(deltaTime)` or
  `update(camera, deltaTime)`); WASD+mouse (and touch via PointerControls if it comes for free).
- Interactions: activating Fly also disables the camera path (`setCamPath(false)`); activating the
  camera path (🎥) exits Fly back to Orbit. In XR the button hides (headset owns the camera).
  Button label: 🕹 lit when Fly active, dimmed when Orbit.
- Always shown (desktop); this replaces nothing — Orbit stays the default.

### B2 · VR-visible watermark via `textSplats`
- The DOM watermark/buttons are invisible in a headset. Generate a small splat-text
  "SHOOTING LAB · SLFPV.COM" (uppercase, single line) via the bundle's textSplats-equivalent export
  (check `generators.d.ts`/`splatConstructors.d.ts` for the function name + args: font size, color).
- Place it INSIDE the root `group` (so XR grab moves it with the scene): position ≈ (0, -0.42, 0),
  facing +Z, small (world height ≈ 0.02–0.03), dim grey (~40% white). Add once after the first
  object loads. If the vendored bundle does NOT export a text-splat constructor, SKIP with a code
  comment + note in the report (do not hand-roll glyph splats).

### B3 · Flythrough depth-of-field — **DROPPED BY USER (2026-07-11, do later)**
- **Implementer: make NO code changes. Return status SKIPPED immediately with notes
  "dropped by user — deferred".** The original requirement (SparkRenderer `focalDistance` +
  `apertureAngle` during camPathActive, `?dof=0` opt-out) stays recorded in the backlog for later.

### B4 · dyno splat-REVEAL entrance (upgraded — user request, official example as ground truth)
- **Ground truth (READ FIRST, downloaded official example source):**
  `C:/Users/Admin/AppData/Local/Temp/claude/D--2026-flexavatar/0ba2b49d-f6b1-4113-8353-582b1a598433/scratchpad/spark-examples/splat-reveal-effects.html`
  (sparkjs.dev "Splat Reveal Effects": `splatMesh.objectModifier = dyno.dynoBlock({gsplat: dyno.Gsplat},
  {gsplat: dyno.Gsplat}, ...)` wrapping a `dyno.Dyno` with GLSL that displaces/scales each gsplat by a
  time uniform `const animateT = dyno.dynoFloat(0)`; effects Magic/Spread/Unroll/Twister/Rain; the
  uniform is ticked per frame and the mesh is marked updated). Also
  `.../spark-examples/splat-dissolve-effects.html` for a second reference.
- **Implement a scene ENTRANCE reveal using the "Spread" effect (USER-CHOSEN — not Magic):** port
  the Spread branch's GLSL from the official example as a standalone Dyno (drop the example's
  effectType switch; hardcode Spread's math). URL param `?reveal=off` disables entirely; default ON
  for v1 AND v2 packages.
- **Timing (user-approved):** keep the current load gate (v2 = statics + all HEADs; v1 = its normal
  flow), and play the reveal RIGHT AFTER the loading bar completes, duration ~2–2.5 s — i.e. the
  loading bar is allowed to sit a moment longer and the reveal covers the visual pop-in.
- **Scope of modifiers:** at reveal start, attach the objectModifier to every currently-loaded mesh
  (statics + the HEAD frame meshes — ~12 + statics, so only a handful of shader variants). Tail
  meshes stream in AFTER the reveal window and never get the modifier. **When the reveal completes,
  REMOVE the modifier (set objectModifier = null + whatever update call the example/d.ts requires)**
  so steady-state rendering returns to the zero-cost path.
- Must not fight the frame-swap visibility logic (the modifier is orthogonal to `.visible`; the 12
  head meshes keep cycling during the reveal — that is fine and expected).
- Verify `dyno` (and the Dyno/dynoBlock/dynoFloat/Gsplat symbols used) are exported by the VENDORED
  spark.module.js 2.1.0 (grep it). Fallbacks in order: (1) dyno missing from the vendored bundle →
  simple opacity fade 0→1 over 0.8 s IF SplatMesh has a writable `opacity` (SplatMesh.d.ts); (2)
  neither available → SKIP with comment + report note.
- NOTE for the report (not this task): the official `splat-transitions` example (object→object
  transitions) is a candidate for morph-style TRANSITIONS between scene objects — record as backlog
  item D2, do not implement now.

**Gates per B task:** `node --check public/spark-template/player.js`; `npm run build`; grep the new
symbols; and each feature OFF-state = byte-equivalent behavior (reviewers walk the no-activation
path).
