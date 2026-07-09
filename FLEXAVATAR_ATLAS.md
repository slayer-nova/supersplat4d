# FlexAvatar atlas-video 4D node integration

This fork loads **FlexAvatar attribute-atlas bakes** (a driven FLEX talking-head performance
encoded as an mp4 attribute atlas + `meta.json`) as a first-class 3D-Gaussian-Splat node that
transforms and plays on the shared timeline, alongside the fork's native static/`.sog4d` nodes.

## Loading avatars

- **In-app:** **File ▸ Load FlexAvatar…** opens a dialog (`src/ui/flexavatar-loader.ts`) that lists the
  bake folders under `/bakes` and adds the chosen one to the CURRENT scene (no reload), so a
  composition is built up interactively. Discovery = `flexAvatar.listBakes` (the dev `serve` returns a
  JSON dir listing for `Accept: application/json`; falls back to an optional `bakes/index.json`); load
  = `flexAvatar.load(base)` (= `assetLoader.loadAtlas` + `scene.add`, same as the URL path). A manual
  path field covers bakes served elsewhere. Registered in `scene-manifest.ts` + `editor.ts` + `menu.ts`.
- **URL args** (below) still work for direct/deep links.

## Entry points (URL args, `src/main.ts`)

- `?loadatlas=./bakes/<name>/` — load the bake as an **animated** node (pre-decode all frames,
  play on the timeline).
- `?loadatlas=./bakes/<name>/&atlasframe=N` — load a **single static** frame `N` (no animation).

`<name>` is a bake directory served same-origin under `public/bakes/<name>/` containing
`atlas.mp4` + `meta.json` (+ optional `audio.m4a`).

## Architecture

- **`src/loaders/atlas.ts`** (new) — ports our web player's `rebuild()` byte-for-byte: an atlas
  video frame (`ImageData`) → an antimatter15 32-byte `.splat` buffer → `deserializeFromSSplat`
  → `GSplatData`. `loadAtlasAllFrames(base)` does a 2-pass decode: full-N decode + a **union
  keep-mask** (keep gaussian `i` if its opacity clears `OP_MIN` in ANY frame), then compacts
  every frame to the same fixed count `K` so slot `j` maps to the same surface point in every
  frame (index-stable).
- **`src/loaders/splat.ts`** — now also exports `deserializeFromSSplat` (reused by `atlas.ts`).
- **`src/asset-loader.ts`** — `loadAtlas(base, frameIndex, animate)` wraps a frame's `GSplatData`
  in a `Splat` node; the animate path attaches the decoded frame set to the node. `atlasOrientation`
  is **identity** (`Vec3(0,0,0)`): our atlas decode already emits an upright, +Z-facing buffer, so
  the node opens on an upright, face-on 3/4 portrait under supersplat's default camera. (A normal
  `.splat` needs `defaultOrientation`'s roll-180 because its buffer is Y-down; ours does not.)
- **`src/splat.ts`** — `isAtlas` / `atlasFrames` / `applyAtlasFrame(i)` / `updateAtlasPlayback()`.
  `updateAtlasPlayback` runs every `onUpdate`, reads `timeline.frame`, and on a frame change calls
  `applyAtlasFrame`, which swaps the node's GPU data **in place** via
  `resource.updateTransformData(gd)` + `resource.updateColorData(gd)`. No per-frame resort is
  needed — the sorter's frame-0 depth order stays visually valid for a talking head's tiny,
  index-stable inter-frame motion, and self-corrects the moment the camera moves.

## Black-flash-during-playback bug — root cause + fix (2026-07-08)

**Symptom:** during timeline *playback* (not paused/scrubbed) the whole canvas — splats **and**
the MiniStats/Debug HUD — flashed black on roughly every other frame.

**Root cause:** a single `this.makeLocalBoundDirty()` call inside `applyAtlasFrame`. It sets
`scene.boundDirty = true`, which forces `DataProcessor.calcBound()` (`src/data-processor.ts`) to
run. `calcBound` is a **GPU pass** — `drawQuadWithShader` to a separate render target, then
`setRenderTarget` / `updateBegin` / `updateEnd` / `readPixels`. Executed mid-frame (every frame
playback advanced), it switched the active render target off the backbuffer and clobbered that
frame's main scene render → the entire canvas (including the HUD) went black for that frame.

**Fix:** delete the per-frame `makeLocalBoundDirty()` call. The node's bound is computed once at
load and is correct for a talking head (tiny, index-stable motion) — it does not need per-frame
recomputation.

**How it was pinned:** screenshots of a live WebGL canvas are unreliable (readback timing), so the
actual framebuffer was sampled on every `app.on('postrender')` via `gl.readPixels` (center 60×60,
count frames where luma≈0). Results were unambiguous: black frames correlated **1:1** with frames
`applyAtlasFrame` ran; isolation showed `makeLocalBoundDirty()` **alone → 50% black**, while the two
texture uploads **without** it → **0% black**. Verified fixed: 0% black over 180 consecutive
playback frames on the built bundle.

**Disproven theories (do not re-chase):**
- `sorter.setMapping` / `sorter.centers` are **not** the cause — the native `.sog4d` dynamic path
  calls `setMapping(indices)` every frame-change (gated on `!pendingSort`) and plays smoothly;
  removing them did not fix the flash.
- Not a `preserveDrawingBuffer:false` composite race — forcing it true did not help.
- `app.autoRender` is unconditionally `true` (`src/scene.ts`), so on-demand render-gating was never
  the cause.

## Default view / orientation (2026-07-08)

Atlas nodes used to open on the **upside-down back** of the head. Cause: `atlasOrientation` was
`Vec3(0,180,180)` (≡ 180° about X), which flipped the already-correct decoded buffer both
upside-down and backward. Fix: `atlasOrientation = Vec3(0,0,0)` (identity) — the decode already
yields an upright, +Z-facing buffer, so with supersplat's default camera (azim ~334, elev ~3) the
node opens on an upright, face-on 3/4 portrait. Verified on the built bundle.

## Tier 2 — multi-track NLE timeline (Slice A: clip data model)

Turns the single global playhead (every node did `localFrame = globalFrame % itsLength`) into an
NLE where each node's frames come from **clips** placed on tracks. Foundation slice — data model +
frame mapping, no UI yet.

- **`src/clip-store.ts`** (new): the single source of truth. A **Source** = an imported node (a 4D
  atlas `Splat`, `frameCount` frames). A **Clip** = `{sourceId, sourceName, trackIndex, startFrame,
  sourceIn, sourceOut, timeScale, loop}` — a trimmed, speed-scaled span of one source placed on a
  track row. Event API on the bus (mirrors `timeline.ts`): `clip.registerSource(name,frameCount,
  fps)→id`, `clip.unregisterSource`, `clip.update`, `clip.remove`, `clip.list`, and the resolver
  `clip.resolve(sourceId, globalFrame) → {active, localFrame}`. The store owns the timeline length
  (`max(startFrame+clipLen)`) and asserts dynamic mode, replacing the per-node `timeline.setDynamic`
  calls that clobbered each other with multiple nodes.
- **Import** auto-creates a default full-range clip on the next free track → behaviour-identical to
  before until the UI lets you move/trim/add clips. Removing a node drops its source + clips.
- **`src/splat.ts`**: `updateAtlasPlayback` resolves its frame via `clip.resolve`; when **no clip
  covers the playhead the node is hidden** (`entity.enabled = visible && _clipVisible`, composing
  with the user's eye-toggle) — NLE convention. `add()` registers the node as a source instead of
  firing its own `setDynamic`.
- **Persistence**: clips serialize by `sourceName` (`docSerialize.clips`); on load they wait in a
  pending list and reattach when the matching node re-registers (`clip.registerSource`), so load
  order does not matter. (Same-name collision handling is deferred to the UI slice.)
- **Verified (runtime instrumentation, no UI):** default clip auto-created; resolver correct for
  trim (`[20,40)`→plays 20‥39), move (`startFrame 30`→hidden before, offset after), and speed
  (`timeScale 2`→2 source-frames/timeline-frame); node's `entity.enabled` actually flips off in the
  gap and on over the clip; normal playback still 0% black through the new path.
- **Scope note:** clip-drives the 4D atlas nodes (the feature target). Native `.sog4d`/TRBF nodes
  keep their existing `%len` mapping; static nodes stay always-visible.

### Slice B — multi-track timeline UI (Premiere-style; cross-track drag in v1)

Rewrites `src/ui/timeline-panel.ts` from a single ruler row into a left name-gutter + frame ruler +
stacked track lanes, fed by the clip store. Ruler and every lane are equal-width flex cells right of
a fixed 92px gutter, so clip bars align to the ruler by construction (`xOfFrame` mirrors the Ticks
`PAD`). Styling in `src/ui/scss/timeline-panel.scss` (dark theme, accent `#937EE2`).

- **B1 (DONE, verified):** render track rows + per-source-colored clip bars (name label + trim-handle
  DOM) + a playhead line through the lanes; rebuild on `clip.changed`/`timeline.frames`/resize; scrub
  via the existing ruler. Verified in Chrome: two sources (FOOD_3 magenta, BG_Room green) on two
  tracks, a moved clip's bar shifts to its `startFrame`, playhead spans rows and aligns to the ruler.
- **B2 (DONE, verified):** drag a clip body horizontally → `clip.update({startFrame})`, with snapping
  to 0, the playhead, and other clips' start/end edges (~8px magnet). Bar moves live, commits on
  release. Verified in Chrome: dragged FOOD_3 0→11 (free) then snapped exactly to the playhead at 30;
  timeline length recomputed.
- **B3 (DONE, verified):** drag the left/right edge handles to trim. Right handle → `sourceOut`;
  left handle → `sourceIn` + `startFrame` together (content-anchored, NLE trim-in). The store clamps
  both to the source's real `[0, frameCount]` range in `clip.update`. Verified in Chrome: right-trim
  71→52, left-trim in-point 0→7 with startFrame following (`sourceIn === startFrame`); at playhead 0
  (before the trimmed start) the node correctly hides.
- **B4 (DONE, verified):** click a clip to select (highlight + a per-clip inspector strip showing
  name / range / `loop` toggle / `speed`=timeScale / ＋clip / ✕ delete); click empty lane to deselect.
  Verified: loop→true, speed→2, delete removes + auto-hides the inspector.
- **B5 (DONE, verified):** `clip.add` places another clip of a source at the playhead on a free
  track; dragging a clip vertically moves it between track rows (new track past the last row),
  guarded by an overlap check (`overlaps()`) that rejects the vertical move onto an occupied span.
  Verified: ＋clip added a 2nd FOOD_3 clip at the playhead; a clip dragged down landed on a new track 2.

- **B-polish (DONE, verified):** a **resize divider** on the panel's top edge (`.tl-resize`, drag to
  grow/shrink the timeline; the viewport above flexes since both live in the `#main-container` flex
  column), and **vertical scroll** on the track-list (`overflow-y: auto`) so many tracks scroll with
  the ruler kept fixed. Verified: 6 track rows scroll at the default 96px height; dragging the handle
  up grew the track area to 236px showing all rows.

**Slice B COMPLETE (B1–B5 + resize/scroll polish).**

### Per-bake fps (DONE, verified)

Clips play at their **own bake's frame rate** regardless of the timeline fps, so 15fps and 30fps bakes
mix correctly. A source is `fps` fps; on a `timelineFps` timeline at `timeScale` speed it occupies
`(sourceFrames × timelineFps) / (fps × timeScale)` TIMELINE frames, and `clip.resolve` advances the
source frame by `timelineFrames × fps × timeScale / timelineFps`. `clip.list` now includes each clip's
`sourceFps`; the timeline UI uses the same math for bar width and trim (source-frame ↔ pixel). The
store re-syncs on `timeline.frameRate` change. `fps == timelineFps` reduces to the old 1:1 mapping, so
30fps bakes are unchanged. Verified: a 15fps 30-frame source is 60 timeline frames wide and advances
at half the timeline rate (tl 10→src 5, 30→15, 58→29); a 30fps source is unchanged (tl 10→src 10).

### Slice C — per-clip timeline-synced audio (DONE, verified)

Each 4D atlas node plays the bake's `audio.m4a` in sync with its clip. One `<audio>` per source node
(several active nodes mix). `meta.audio` → `splat.audioUrl` (asset-loader), element created in
`Splat.add()`, cleaned up in `destroy()`. `Splat.syncAudio()` (called each frame from
`updateAtlasPlayback`) drives it off the resolved clip: `currentTime = sourceLocalFrame / fps`,
`playbackRate = clip.timeScale` (so `clip.resolve` now also returns `timeScale`); it only re-seeks
when drift exceeds ~80ms (avoids constant-seek stutter), pauses when the timeline is paused or the
node is off its clip, and follows scrubbing. Autoplay unlocks via the play-button gesture (browser
sticky activation). Verified in Chrome: FOOD_3 audio duration 2.37s (= 71f/30fps); during play it
tracks the frame (~40–57ms startup-latency drift); pause → audio pauses; scrub to frame 15 → audio
`currentTime` 0.5 exactly. Known-minor: ~50ms play-start latency (tunable via the drift threshold);
scrubbed/paused sync is exact.

### Slice T3 — scene-manifest export/import (DONE, verified)

The editor's **save format**. `src/scene-manifest.ts` (`registerSceneManifest(events, scene)`) builds
a compact JSON — every gaussian object (static `.ply`/`.splat` or a 4D atlas bake) with its transform,
plus all multi-track clips and the timeline fps/frames — and reloads it. Heavy media stays external
(atlas nodes carry their bake `url`; a new `splat.atlasBase` records it). Events: `flexScene.manifest`
(build the object), `flexScene.export` (download `.flexscene.json`; also a **File ▸ Export ▸ FlexAvatar
Scene…** menu item), `flexScene.import(manifest)` (rebuild). Import order: `invoke`
`docDeserialize.clips` to seed the clips as `pending`, then load each source — clips reattach as each
node re-registers by name (no duplicate default). `?loadscene=<url>` fetches + imports on startup.

Manifest: `{ version, type:'flexavatar-scene', fps, frames, smoothness, sources:[{kind,name,url,transform}],
clips:[{sourceName,trackIndex,startFrame,sourceIn,sourceOut,timeScale,loop}],
poseSets:[{name,poses:[{name,frame,position,target}]}] }`.

**Camera keyframe animation (`poseSets`).** SuperSplat's own camera-pose system (`src/camera-poses.ts`,
active) keyframes camera `{position,target}` at frames → a **looping cubic-spline flythrough** that
plays as the timeline advances (the addKey/removeKey timeline buttons author it; keyframes show as
diamonds on the ruler). Export saves it verbatim from `docSerialize.poseSets` (same shape as the native
`.ssproj`); import restores `timeline.setFrames`(length) + `timeline.setSmoothness` **before**
`docDeserialize.poseSets` (the spline duration IS `timeline.frames` and it drops keys past it — a
clip-less camera scene would otherwise lose the animation), and the poses are restored LAST so the
spline builds against the settled length. The standalone player then **autoplays the camera flythrough**
— no keyframe UI needed. NOTE: import now also restores the timeline LENGTH from `manifest.frames`
(previously only `fps` was restored — a latent gap). `package-scene.js` carries `poseSets` through
untouched (JSON passthrough alongside the source-url rewrites). Verified in Chrome: a sphere scene with
keys at frame 0 (`[3,.5,0]`) and 30 (`[0,.5,3]`) → the spline yields `[2.47,.5,.53]`@8, `[1.5,.5,1.5]`
@15, `[0,.5,3]`@30, and the player visibly orbits X-front→Z-front on playback. (A background browser
tab pauses RAF → playback only advances when the tab is foreground; irrelevant to a real viewer.)

**Source-URL stability (review #6, option A):** three `kind`s each reference a STABLE served location
so the scene reloads — `atlas` → the bake dir (`atlasBase`); `sog4d`/`splat` → a served file URL via
`servedUrl()`. A same-origin http(s) URL is kept (made relative). A NON-reloadable source — `blob:`/
`data:` (dropped file) or `local-asset-*` (the synthetic id the loader gives in-memory content, e.g. a
`.sog4d`'s derived sub-splats) — falls back to the `./models/<name>` convention and is collected; on
export the user is warned (console + popup) to place those files under `public/models/`. Import loads
by kind (`atlas`→`loadAtlas`, else `assetLoader.load` dispatching on the filename ext) and dedupes
`sog4d` by URL (one `.sog4d` recreates all its sub-splats). Result: served atlas/static/sog4d
round-trip; locally-dropped objects round-trip once placed under `public/models/` (no more misleading
"stable" URLs). LIMITATION: a `.sog4d` that auto-splits into sub-splats has no served per-part file, so
its parts stay flagged unless the original `.sog4d` URL is recorded on them (a loader change, deferred).

**Round-trip verified in Chrome:** exported a FOOD_3 scene (transform `[0.5,0.1,0]`, clip start 10 /
in 5 / out 60 / loop), reloaded via `?loadscene=` on a fresh page → node, transform, and the exact
clip all restored (`roundTripOK`), timeline length 65, single clip (no default duplicate). **Gotcha
fixed:** `docDeserialize.clips` is a registered *function* — seed it with `events.invoke`, not `fire`.

**Tier 2 editor COMPLETE: Slice A (data model) + Slice B (B1–B5 + polish) + Slice C (audio) + T3
(save/load).** The multi-track NLE editor is end-to-end: import → compose/trim/arrange → play (video
+ audio) → save → reload.

## Standalone player + packaging (Option A) — deployable shares

Turn a saved scene into a **self-contained static folder** you can host anywhere, opening read-only in
a minimal playback UI. Two pieces:

**1. Player mode (`?player=1`, `src/main.ts` + `src/ui/scss/player-mode.scss`).** Adds `player-mode`
to `<body>` and hides all authoring chrome via CSS — `#menu`, scene/data panels, both toolbars,
mode-toggle, view/color panels, tools, the app/cursor labels, and the MiniStats HUD
(`events.fire('miniStats.setVisible', false)`). The timeline stays but is stripped to **play button +
ruler/scrub + clip bars** (settings-controls, prev/next/add/remove-key buttons, the inspector, and the
resize handle are hidden; `.tl-clip` is `pointer-events:none`). Camera **orbit still works** (default
controller, not gated). After the load finishes, main.ts fires `timeline.setPlaying` (400 ms delay) so
the scene **autoplays**. Verified in Chrome: chrome hidden, autoplay advancing, drag-orbit changes
`scene.camera.azim`.

**2. Progress bar during decode (`src/asset-loader.ts` + `src/loaders/atlas.ts`).** The animated atlas
pre-decode is multi-second, so `loadAtlasAllFrames(base, onProgress)` reports a 0..1 fraction (0–0.9
"Decoding frames" in pass-1, 0.9–1.0 "Compacting frames" in pass-2, yielding every 16 frames).
`loadAtlas` drives the shared **Progress overlay** (`progressStart`/`progressUpdate`/`progressEnd`,
progress in PERCENT) unless a caller passes its own `onProgress` (a multi-source scene import owns one
unified bar). Verified: the 356-frame NewEra bake shows "Loading … / Decoding frames" + a filling bar.

**3. Packaging script (`scripts/package-scene.js`, pure Node/CommonJS).**
`node scripts/package-scene.js <scene.flexscene.json> [--out DIR] [--dist DIR] [--manifest-name NAME]
[--keep-eruda]`. Given a built `dist/` + a manifest, it emits a folder = the JS/CSS bundle (copied by
**exclusion** — everything except the asset dirs `bakes/models/scenes` and root model files, since
chunk names are content-hashed) + the manifest + **only** the bakes/models the manifest references
(atlas → dir, sog4d/splat → file; cross-origin http sources kept as absolute URLs, not bundled), with
`index.html` rewritten to **auto-open in player mode** (a classic `<script>` after `<base>` does
`history.replaceState` to `?loadscene=./<manifest>&player=1`) and eruda stripped. Serve the folder and
the root URL redirects straight into the playing scene. Verified end-to-end: a FOOD_3 manifest packaged
to 31 files / only `bakes/FOOD_3/`, served on a fresh port → auto-navigated to player mode, rendered,
autoplayed, orbited. **Gotcha:** strip eruda BEFORE injecting the auto-nav `<script>`, and use a
`</script>`-boundary-safe regex (`<script>(?:(?!</script>)[\s\S])*?eruda\.init\(\)…`) — otherwise the
greedy eruda-init match swallows everything from the injected script up to `eruda.init()`, deleting the
manifest/css/jszip links.

### SOG static compression at package time (DONE, verified)

Static (non-4D) sources are SHRUNK when packaging: a raw `.ply` source → a compressed `.sog` (SOG v2,
a zip of `meta.json` + lossless WebP). Atlas (mp4) and `sog4d` sources are already compressed and copied
as-is; `.splat`/`.sog` copied as-is (only raw `.ply` is convertible — `ply_to_sog4d.py` reads PLY).

- **Converter:** the fork's own `ply_to_sog4d.py` (`--ply X.ply -o X.sog`, `write_sog` → SOG v2). Needs
  the FlexAvatar conda Python with `numpy`/`plyfile`/`pillow`/**`scikit-learn`** (`encode_scales`/
  `encode_sh0` k-means). Added `from __future__ import annotations` to the top so its PEP-604 `X | Y`
  annotations run on the env's Python 3.9 (was written for 3.10+).
- **No loader change was needed.** `src/asset-loader.ts::load` routes a `.sog` filename through its
  `else` branch → `loadGsplat`, and the PlayCanvas engine's gsplat loader natively parses "ply,
  compressed.ply, **sog**, sog-bundle" (`loaders/gsplat.ts:36`). So a manifest `splat` source whose
  `url`/`name` end in `.sog` loads through the same scene-import path as any static source — verified
  in Chrome (a 12k-splat sphere `.sog` renders).
- **`scripts/package-scene.js`:** for each static `.ply` source it runs the converter, writes the
  `.sog` into the output, and rewrites that source's `url`+`name` (and any clip `sourceName`) from
  `.ply` to `.sog` in the OUTPUT manifest — the raw `.ply` is never shipped. Flags: `--no-sog` (copy
  raw), `--python PATH` / `FLEXAVATAR_PYTHON` (default `python`), `--sog-script PATH`. **Graceful:** a
  missing/broken Python or a failed conversion warns and copies the raw `.ply` (no manifest rewrite) —
  packaging never aborts over one source.
- **Verified end-to-end:** a manifest referencing `models/test_sphere.ply` (0.7 MB) packaged to a
  folder whose `models/` holds only `test_sphere.sog` (0.08 MB, **8.6× smaller**; real FLEX SH gaussians
  compress far more), manifest rewritten to `.sog`, `.ply` returns 404 — served root auto-navigated to
  player mode and rendered the sphere. Fallback (`--python nope`) warned + copied the raw `.ply`.

## Spark Player export (lightweight offline share) — DONE

**File ▸ Export ▸ Spark Player…** packages the scene's primary atlas avatar as a self-contained,
**offline**, **progressive** Spark (Luma, WebGL2/three.js, MIT) 3DGS player — a far lighter share than
the full SuperSplat viewer. Motivation + benchmarks in the sibling spike `supersplat_spike/spark-player/`
(`.spz` is 2.4× smaller than raw `.splat` and Spark's runtime parse is ~15× faster than our WebCodecs
atlas decode, because the decode is done once at editor-export time, not per view).

- **`src/spark-export.ts`** (`registerSparkExport`, wired in main.ts; menu item in `ui/menu.ts`). Targets
  the selected atlas Splat (else the first `isAtlas`). Each in-memory `atlasFrames` `GSplatData` →
  `serializeSpz` (**spz-js** npm dep) → `.spz`. **No conversion needed:** `deserializeFromSSplat`
  (loaders/splat.ts) already stores PLY-native conventions spz-js wants — `scale_*`=LOG, `f_dc_*`=SH-DC,
  `opacity`=LOGIT, `rot_*`=(w,x,y,z); the encoder is a direct field copy + quaternion reorder to
  `[x,y,z,w]` (normalized). Encoding yields every 4 frames so the shared Progress overlay repaints.
- **Package** (downloaded `.zip` via the JSZip global): `index.html` + `player.js` +
  `vendor/{three.module,three.core,OrbitControls,spark.module,jszip.esm}.js` (all local → offline) +
  `frames/frame_%04d.spz` (HEAD=first 12, individual) + `rest.zip` (tail) + `audio.m4a` +
  `manifest.json {name,frames,fps,audio,format:'spz',headCount}`.
- **`public/spark-template/`** (committed, copied to `dist/` by the build) is the player app + vendored
  libs; the export fetches them from `./spark-template/*` at runtime and bundles them into the zip.
- **Progressive playback** (`spark-template/player.js`): fetch the HEAD `.spz` individually → show frame
  0 + start playback/audio in ~50 ms → background-fetch `rest.zip` and append; the loop grows to the full
  clip. One `SplatMesh` per frame, cycled by `.visible` at fps; audio drives the frame index for A/V sync
  (autoplay-blocked → a "tap for sound" fallback). Free orbit. `SparkRenderer` MUST be in the scene or
  nothing draws; our `.spz` is already Y-up (`rot=0`), heads ~0.5u at origin so camera sits at z≈0.95.
- **GOTCHA:** three 0.178's `three.module.js` re-exports from `./three.core.js` — BOTH must be vendored.
- Verified end-to-end in Chrome (FOOD_3): editor export → 52.7 MB zip (12 head + rest.zip + audio) →
  unzip + serve → progressive load, photoreal upright render, animation, orbit, audio fallback.
- **v2 (deferred):** camera-flythrough export (`poseSets` → Spark `startAnim:'animTrack'`), multi-track /
  multiple avatars, Web-Worker encoding. Full spec: `supersplat_spike/spark-player/DESIGN.md`.

## Decode speed (WebCodecs)

`loaders/atlas.ts` `decodeVideoAllFrames` decodes every frame via **mediabunny (WebCodecs)** —
`fetch → Blob → Input(BlobSource) → CanvasSink.canvases()` streams each frame in order at hardware
speed, no per-`<video>`-seek latency. Measured: a 160-frame tiktok bake load went **~30–40s → 7.6s**;
frames are pixel-identical to the old path (avatar decodes correctly). Gotchas: use `BlobSource`
(download once) not `UrlSource` — the latter's HTTP range requests get aborted by the dev `serve` and
hang; and don't pass both `width`+`height` to `CanvasSink` without `fit` (it throws) — omit them to
get native resolution (== atlas size). Falls back to the original `<video>`-seek path
(`decodeVideoAllFramesSeek`) if WebCodecs/demux is unavailable or yields the wrong frame count.

## Dev notes

- **`public/bakes/` is gitignored** (the atlas mp4 is tens of MB — runtime test data, not source).
  To run the demo, drop a bake directory (`atlas.mp4` + `meta.json` [+ `audio.m4a`]) under
  `public/bakes/<name>/` and use `?loadatlas=./bakes/<name>/`. Bakes are produced by the main
  FlexAvatar repo's `POST /api/bake` (`web_demo/server.py`).
- **Serve each rebuild on a FRESH port** (`npx serve dist -l 30XX -C`) — the fork's `serve`
  hard-caches `index.js`, so a same-URL reload runs stale code after a rebuild.
