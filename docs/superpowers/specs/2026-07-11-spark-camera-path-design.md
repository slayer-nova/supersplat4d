# Spark export — camera keyframe path (poseSets flythrough) design spec (2026-07-11)

**Goal:** The fork editor already has camera keyframe animation (SuperSplat camera poses on the
timeline, `src/camera-poses.ts`, saved as `poseSets` in `.flexscene.json` since 71550f5). Carry it into
the Spark export: `manifest.camera` in the v2 scene package, and the Spark player plays the SAME
flythrough (identical spline math), synced to the scene clock, with clean handoff to user orbit and XR.

## Source facts (verified)

- Editor flythrough: `CubicSpline.fromPointsLooping(duration, times, points, smoothness)`
  (`src/anim/spline.ts`, 131 lines, self-contained — times/knots + `calcKnots(smoothness)` +
  `fromPoints` + looping wrap-key padding). `times` = pose FRAME numbers, `points` = interleaved
  `[pos.x,pos.y,pos.z, target.x,target.y,target.z]` per key, `duration` = `timeline.frames`,
  `smoothness` = `timeline.smoothness`. Per timeline frame: `spline.evaluate(frame, out6)` →
  `camera.setPose({position, target})` (`src/camera-poses.ts:19-52`). Spline domain is **frames**.
- Pose data: `events.invoke('docSerialize.poseSets')` → `[{name, poses:[{name, frame, position:[3],
  target:[3]}]}]`; the editor uses **set 0** (`docDeserialize` reads `poseSets[0].poses`,
  `camera-poses.ts:195`). Editor animates only when ≥2 poses land inside the timeline duration
  (`fromPointsLooping` falls back to `fromPoints` for <2; rebuild filters `frame < duration`).
- Timeline: `timeline.frames` (default 180), `timeline.frameRate` (default 30),
  `timeline.smoothness` (default 1) — all event functions (`src/timeline.ts`).
- Player anchors (`public/spark-template/player.js`): `camera` (PerspectiveCamera), `controls`
  (OrbitControls, line ~67), XR session handling (~34-58, sessionstart auto-sound ~150s), the
  animObjects render loop, and the shared clock (audio-owning object uses `audioEl.currentTime`).

## Design

### Export (`src/spark-export.ts`) — additive to manifest v2

After building the objects array, read the camera path:
```ts
const poseSets = (scene.events.invoke('docSerialize.poseSets') ?? []) as any[];
const duration = scene.events.invoke('timeline.frames');
const poses = (poseSets[0]?.poses ?? [])
    .filter((p: any) => p.frame < duration)
    .sort((a: any, b: any) => a.frame - b.frame)
    .map((p: any) => ({ frame: p.frame, position: p.position, target: p.target }));
if (poses.length >= 2) manifest.camera = {
    frames: duration,
    fps: scene.events.invoke('timeline.frameRate') || 30,
    smoothness: scene.events.invoke('timeline.smoothness') ?? 1,
    poses,
};
```
- Mirrors the editor's own rebuild rules (set 0, filter `frame < duration`, sort by frame; the
  editor's Splat/scene registration passes `events` — `spark-export.ts` already holds `events` via
  `registerSparkExport(events, scene)`, use that directly rather than `scene.events` if cleaner).
- `< 2` poses → NO `manifest.camera` key (package plays exactly as today). v1 export path untouched.
- `position`/`target` ARE plain `[x,y,z]` arrays in the serialized form — `docSerialize.poseSets`
  packs each Vec3 through `pack3 = (v) => [v.x, v.y, v.z]` (`camera-poses.ts:167-185`); pass through
  verbatim, NO normalization helper needed. PlayCanvas world == Three world (proven by the scene
  feature), so NO coordinate conversion.

### Player (`public/spark-template/player.js`)

1. **Port `CubicSpline` verbatim** (the 131-line class from `src/anim/spline.ts`, TS types stripped)
   into the template as a plain-JS class. Identical `calcKnots`/`evaluateSegment`/`fromPointsLooping`
   math — the flythrough must reproduce the editor's motion exactly.
2. **Setup** (only when `manifest.camera && manifest.camera.poses.length >= 2`, works for BOTH v1 and
   v2 manifests — the field is version-independent):
   ```js
   const cam = manifest.camera;
   const times = cam.poses.map((p) => p.frame);
   const points = [];
   cam.poses.forEach((p) => { points.push(...p.position, ...p.target); });
   camSpline = CubicSpline.fromPointsLooping(cam.frames, times, points, cam.smoothness ?? 1);
   ```
3. **Playback:** in the render loop, when `camPathActive`:
   `frame = (clockSeconds * cam.fps) % cam.frames` where `clockSeconds` = the audio-owning object's
   `audioEl.currentTime` when playing, else wall-clock since `startPlayback()` — the SAME clock the
   animated objects use, so avatar frames and camera path stay in sync. Then
   `camSpline.evaluate(frame, out6)`; `camera.position.set(out[0..2])`;
   `controls.target.set(out[3..5])`; `camera.lookAt(controls.target)`.
   While active: `controls.enabled = false` (blocks input handlers) **AND the render loop must SKIP
   `controls.update()`** — source-verified: the vendored OrbitControls' `update()` ignores `enabled`,
   re-clamps the radius to `[minDistance 0.4, maxDistance 2.0]` and rewrites `camera.position` +
   `lookAt` every frame, which would fight/clamp any spline pose outside that band. The non-XR
   branch becomes `else if (!camPathActive) controls.update();`.
   Clock precision note: the sync is EXACT only against the audio-owning object (both read
   `audioEl.currentTime`); silent packages use an approximate wall clock (non-audio objects advance
   on a per-swap stepper and may drift slightly over minutes), and a looping audio shorter than the
   camera path wraps the camera at the audio loop point — both mirror pre-existing avatar behavior
   and are acceptable v1 semantics.
4. **User handoff:** a `pointerdown` OR a `wheel` event on the canvas OR pressing the toggle disables
   the flythrough (wheel included so zoom attempts aren't dead input). Known v1 UX: the FIRST press
   only stops the flythrough (OrbitControls' own pointerdown already saw `enabled=false`); the NEXT
   drag orbits — accepted. Handoff details:
   `camPathActive = false; controls.enabled = true; controls.target` stays at the last spline target
   (orbit continues smoothly from where the camera was). A persistent `🎥` toggle button — **stacked
   ABOVE `#sound`** (`left:16px; bottom:64px`, same pill styling incl. the `:hover` rule; NOT beside
   it at left:64px, which would overlap the always-visible centered `#xr` row on narrow phones) —
   re-enables it; the button shows on/off state (`🎥` lit vs dimmed via opacity). Button hidden
   entirely when the package has no camera path. Default state: **ON** when a path exists
   (showcase-first).
5. **XR:** on `sessionstart`, force `camPathActive = false` (headset owns the camera); do NOT
   auto-re-enable on sessionend (user taps 🎥 if wanted). The existing XR grab/recenter logic is
   untouched.
6. **v1/no-camera packages:** `manifest.camera` absent → no spline, no button, zero behavior change.

## Error handling

- Malformed `manifest.camera` (missing arrays, <2 poses, frames<=0) → ignore the camera block
  entirely (guarded setup), never break playback.
- `fromPointsLooping` with all poses at the same frame → spline lib handles degenerate spans; the
  guard `poses.length >= 2` plus editor-mirrored filtering matches editor behavior; no extra handling.

## Testing / gates (same regime as the scene-export feature)

1. `npx eslint src/spark-export.ts` clean; `npm run build` green;
   `node --check public/spark-template/player.js`.
2. Greps: `CubicSpline` + `fromPointsLooping` + `manifest.camera` + `🎥` present in player.js;
   `manifest.camera` written in spark-export.ts.
3. **Spline-port equivalence check (part of review):** the ported JS `calcKnots`/`evaluateSegment`/
   `fromPointsLooping` must be line-equivalent to `src/anim/spline.ts` (TS types stripped only) —
   reviewer diffs them side by side.
4. **Live browser smoke (controller):** in the editor, compose a scene + inject ≥3 camera poses
   programmatically (`scene.events.invoke('docDeserialize.poseSets', [...])` or `camera.addPose`),
   export, serve, verify: camera flies the path in the player (screenshots at two clock times differ
   in viewpoint), avatar keeps animating, `🎥` toggle + pointerdown handoff work, and a package
   WITHOUT poses behaves exactly as before.

## Scope

**v1 (this):** export set-0 poses into `manifest.camera`; player flythrough with verbatim spline port,
shared-clock sync, 🎥 toggle, pointerdown/XR handoff. **Out of scope:** multiple pose sets; editing
poses in the player; easing/duration overrides; camera FOV/roll keyframes (poses carry
position+target only — matches the editor).
