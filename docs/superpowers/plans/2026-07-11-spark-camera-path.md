# Spark camera path — Implementation Plan

> Executed via ultracode workflow orchestration. Repo:
> `D:/2026/flexavatar/supersplat_spike/supersplat4d`, branch `flexavatar-atlas-4d`, IN PLACE.
> Spec (binding): `docs/superpowers/specs/2026-07-11-spark-camera-path-design.md`.

**Goal:** editor camera poseSets → `manifest.camera` in the Spark export; the player replays the
flythrough with the editor's exact spline math, synced to the scene clock, with 🎥 toggle +
pointerdown/XR handoff.

## Global Constraints

- Branch `flexavatar-atlas-4d` IN PLACE. NEVER `git push`. `git add` only named files.
- Gates: `npx eslint <touched ts files>` clean; `npm run build`; `node --check
  public/spark-template/player.js`. (Repo-wide lint/tsc are RED pre-existing — never gate on them.)
- The spline port must be LINE-EQUIVALENT to `src/anim/spline.ts` (TS types stripped only).
- No behavior change for packages without `manifest.camera` (v1 AND v2).
- The camera clock = the same clock the animated objects use (audio-owning object's
  `audioEl.currentTime` when playing, else wall-clock since playback start).

---

### Task 1: export — `manifest.camera` (`src/spark-export.ts`)

1. In `registerSparkExport(events, scene)`'s export body, AFTER the objects array is assembled and
   BEFORE `manifest.json` is written, add (using the `events` parameter directly):
   ```ts
   // camera keyframe path (SuperSplat poseSets, set 0) — same rules the editor's flythrough uses
   const poseSets = (events.invoke('docSerialize.poseSets') ?? []) as any[];
   const duration = (events.invoke('timeline.frames') as number) || 0;
   const camPoses = ((poseSets[0]?.poses ?? []) as any[])
       .filter(p => p.frame < duration)
       .sort((a, b) => a.frame - b.frame)
       .map(p => ({ frame: p.frame, position: p.position, target: p.target }));
   const camera = camPoses.length >= 2 ? {
       frames: duration,
       fps: (events.invoke('timeline.frameRate') as number) || 30,
       smoothness: (events.invoke('timeline.smoothness') as number) ?? 1,
       poses: camPoses
   } : null;
   ```
   and include it in the manifest object: `...(camera ? { camera } : {})` (or set conditionally) so
   the key is ABSENT when null.
2. VERIFIED: `docSerialize.poseSets` returns `position`/`target` as plain `[x,y,z]` arrays (it packs
   each Vec3 via `pack3`, `src/camera-poses.ts:167-185`) — pass them through verbatim; do NOT add a
   normalization helper (it would be dead code).
3. Gates: `npx eslint src/spark-export.ts` clean; `npm run build`.
4. Commit: `git add src/spark-export.ts` →
   `feat(spark): export camera keyframe path (poseSets) into manifest.camera`.

---

### Task 2: player — spline port + flythrough (`public/spark-template/player.js`)

1. **Port `CubicSpline`** from `src/anim/spline.ts` as a plain-JS class near the top of player.js
   (after imports). Strip ONLY TypeScript syntax (types, visibility); keep every expression,
   loop bound, and constant identical — including `calcKnots`'s smoothness math, `evaluate`'s
   segment search, `evaluateSegment`'s hermite basis, and `fromPointsLooping`'s wrap-key padding.
2. **State + setup** (module scope):
   ```js
   let camSpline = null, camData = null, camPathActive = false, camOut = new Array(6);
   let playStartMs = 0;   // set in startPlayback()
   const setupCameraPath = (manifest) => {
     const cam = manifest && manifest.camera;
     if (!cam || !Array.isArray(cam.poses) || cam.poses.length < 2 || !(cam.frames > 0)) return;
     const times = cam.poses.map((p) => p.frame);
     const points = [];
     cam.poses.forEach((p) => { points.push(p.position[0], p.position[1], p.position[2], p.target[0], p.target[1], p.target[2]); });
     camSpline = CubicSpline.fromPointsLooping(cam.frames, times, points, cam.smoothness ?? 1);
     camData = cam;
     camPathActive = true;               // default ON when a path ships (showcase-first)
     controls.enabled = false;
     if (camBtn) { camBtn.style.display = 'block'; updateCamBtn(); }
   };
   ```
   ONE call site only: insert `setupCameraPath(manifest);` in `load()` right after the manifest is
   parsed (player.js ~line 232) and BEFORE the `if (manifest.version === 2)` dispatch (line ~233) —
   that single call covers v1 AND v2 packages. Do NOT also call it inside `loadScene`.
3. **Clock + per-frame update** — in the render loop (same place the animObjects swap runs):
   ```js
   if (camPathActive && camSpline) {
     let sec;
     const audioOwner = animObjects.find((o) => o.hasAudio);
     if (audioOwner && audioEl && !audioEl.paused && audioEl.duration) sec = audioEl.currentTime;
     else sec = (t - playStartMs) / 1000;
     const fr = ((sec * camData.fps) % camData.frames + camData.frames) % camData.frames;
     camSpline.evaluate(fr, camOut);
     camera.position.set(camOut[0], camOut[1], camOut[2]);
     controls.target.set(camOut[3], camOut[4], camOut[5]);
     camera.lookAt(controls.target);
   }
   ```
   Set `playStartMs = performance.now()` inside `startPlayback()`. Do NOT run the camera update
   while `renderer.xr.isPresenting`.
   **CRITICAL — skip the orbit update while the path owns the camera:** the vendored
   `OrbitControls.update()` IGNORES `enabled` (only input handlers check it) and re-clamps the radius
   to `[minDistance 0.4, maxDistance 2.0]` + rewrites `camera.position`/`lookAt` every non-XR frame —
   it would fight/clamp the spline pose. Change the existing render-loop branch
   `else controls.update();` (player.js ~line 211) to `else if (!camPathActive) controls.update();`.
4. **🎥 toggle + handoff:**
   - `index.html`: add `<button id="campath" title="Camera flythrough on/off" style="display:none">🎥</button>`
     STACKED ABOVE `#sound` (extend the CSS selectors to `#sound, #campath { … }` and
     `#sound:hover, #campath:hover { … }`, plus a `#campath { left: 16px; bottom: 64px; }` override).
     Do NOT place it at `left:64px; bottom:22px` — that overlaps the always-visible centered `#xr`
     row on narrow phones. Hidden by default (`display:none`); shown by `setupCameraPath` only when a
     path exists.
   - player.js:
     ```js
     const camBtn = document.getElementById('campath');
     const updateCamBtn = () => { if (camBtn) camBtn.style.opacity = camPathActive ? '1' : '0.4'; };
     const setCamPath = (on) => {
       camPathActive = on && !!camSpline;
       controls.enabled = !camPathActive;
       updateCamBtn();
     };
     if (camBtn) camBtn.addEventListener('click', () => setCamPath(!camPathActive));
     renderer.domElement.addEventListener('pointerdown', () => { if (camPathActive) setCamPath(false); });
     renderer.domElement.addEventListener('wheel', () => { if (camPathActive) setCamPath(false); }, { passive: true });
     ```
   - XR: in the existing `sessionstart` handler add `if (camPathActive) setCamPath(false);`.
   - **PLACEMENT (matters — TDZ):** this whole block executes at module-eval time and touches
     `renderer` (created line ~31) and `controls` (line ~67), so it MUST live AFTER the
     OrbitControls construction — e.g. right next to the existing `soundEl` click handler
     (~lines 217-222). Do NOT put it beside the `soundEl` DECLARATION at line ~23: `renderer` is
     still in its temporal dead zone there → ReferenceError at load (node --check will NOT catch it).
     `setupCameraPath` itself is only CALLED from `load()` (after the whole module evaluated), so
     its position relative to these consts is otherwise free.
   - Known v1 UX (accepted, do not "fix"): the FIRST press only stops the flythrough (OrbitControls'
     own pointerdown saw `enabled=false`); the NEXT drag orbits.
5. Gates: `node --check public/spark-template/player.js`; greps `CubicSpline`, `fromPointsLooping`,
   `manifest.camera` (or `manifest && manifest.camera`), `campath` in player.js + index.html;
   `npm run build`.
6. Commit: `git add public/spark-template/player.js public/spark-template/index.html` →
   `feat(spark): camera flythrough in the player — verbatim spline port, 🎥 toggle, XR/orbit handoff`.

---

### Task 3 (final phase): docs + gates

`git add docs/superpowers/specs/2026-07-11-spark-camera-path-design.md
docs/superpowers/plans/2026-07-11-spark-camera-path.md` → `docs: spark camera path spec + plan`;
re-run all gates; report `git log --oneline`.
