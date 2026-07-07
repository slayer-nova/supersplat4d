# FlexAvatar atlas-video 4D node integration

This fork loads **FlexAvatar attribute-atlas bakes** (a driven FLEX talking-head performance
encoded as an mp4 attribute atlas + `meta.json`) as a first-class 3D-Gaussian-Splat node that
transforms and plays on the shared timeline, alongside the fork's native static/`.sog4d` nodes.

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

**Slice B COMPLETE (B1–B5).** Next: Slice C (per-clip timeline-synced `<audio>`).

## Dev notes

- **`public/bakes/` is gitignored** (the atlas mp4 is tens of MB — runtime test data, not source).
  To run the demo, drop a bake directory (`atlas.mp4` + `meta.json` [+ `audio.m4a`]) under
  `public/bakes/<name>/` and use `?loadatlas=./bakes/<name>/`. Bakes are produced by the main
  FlexAvatar repo's `POST /api/bake` (`web_demo/server.py`).
- **Serve each rebuild on a FRESH port** (`npx serve dist -l 30XX -C`) — the fork's `serve`
  hard-caches `index.js`, so a same-URL reload runs stale code after a rebuild.
