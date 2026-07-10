# Spark SCENE Export — multi-object (static + 4D avatar) design spec (2026-07-11, rev 2)

**Goal:** Upgrade the fork editor's **File ▸ Export ▸ Spark Player…** from "primary atlas only" to a
**whole-scene export**: every static splat (.ply / .splat / static .sog) AND every FlexAvatar atlas
(4D avatar) in the scene, each with its **editor transform baked in**, packaged as one self-contained
offline Spark player zip. The player renders them together — statics as backdrop, avatars animating.

*(rev 2: corrected after adversarial 3-lens source review — transform-bake mode, gates, audio modulo,
quat-convention settlement, first-paint semantics.)*

## Why (current defect)

`src/spark-export.ts` today: picks ONE atlas (`selected.isAtlas || first atlas`), exports only its
`atlasFrames`, ignores every other object, and **drops even that atlas's editor transform** (raw
`GSplatData` coords). A composed scene (static SOG set + placed avatar) exports as just the avatar,
unplaced. The player template (`public/spark-template/player.js`) likewise only knows the single-avatar
layout.

## Core design decisions

1. **Transforms are BAKED into the gaussian data at export** (positions/quats/scales transformed per
   splat), NOT sent to the player as matrices. Rationale: (a) the avatar-at-identity path is the
   PROVEN Spark rendering path; (b) it sidesteps PlayCanvas↔Three convention risk entirely — the
   editor's world (RH, Y-up) equals Three's world, and whatever entity orientation a loader applied
   (e.g. the .splat/.sog `defaultOrientation` roll-180 for Y-down buffers, `asset-loader.ts:14`) is
   part of the world transform and gets baked; (c) the player stays simple (everything loads at
   identity into one root group, so the existing XR grab/scale/rotate keeps working on the whole scene).

2. **The bake frame is the PURE editor world: `entity.getWorldTransform() × transform-palette`.**
   ⚠️ NEITHER existing serializer polarity produces this (source-verified):
   - `keepWorldTransform: true` = world transform **NOT** applied at all — raw local data, the
     document-save mode (`splat-serialize.ts:27` comment; `doc.ts:168`). Statics would export unplaced.
   - `keepWorldTransform: false/omitted` (the File▸Export PLY path) bakes **`Rz(0,0,-180) · world`** —
     the serializer deliberately prepends `mat.setFromEulerAngles(0,0,-180)` (`splat-serialize.ts:235-238`,
     "undo the transform we apply at load time") so a re-import under `defaultOrientation` round-trips.
     That is the PLY-file frame, NOT editor world: an unmoved static would export its raw Y-down buffer
     and render 180°-rolled in the Spark player.
   **Therefore:** extend `SerializeSettings`/`SplatTransformCache` with a third mode
   (`bakeFullWorldTransform: true` → `mat` = `entity.getWorldTransform()` composed with the palette,
   NO euler prefix), reusing the otherwise-identical per-splat math (`splat-serialize.ts:369-402`):
   `mat.transformPoint` on xyz; `q.set(rot_1,rot_2,rot_3,rot_0).mul2(bakeRot, q)` where **bakeRot is
   derived from the SAME composed bake matrix via `Quat.setFromMat4` (scale-safe)** — not
   `entity.getRotation()`, which ignores palette transforms; `scale_i = log(exp(scale_i) * axisScale_i)`
   from the composed matrix's `getScale()`. Statics AND atlas frames use this ONE frame. (The atlas
   path may derive rotation from the entity only because atlases carry no palette edits — if in doubt,
   use `Quat.setFromMat4(worldMat)` there too.)

3. **Reuse `SingleSplat`** (`splat-serialize.ts:290`; add it to the file's export list ~line 1132) with
   the new mode for statics — palette edits, prop plumbing and conventions inherited, not reimplemented.
   Deleted splats filtered: skip `state[i] & State.deleted` (`State.deleted = 4`, `splat-state.ts`;
   every Splat's `splatData` carries a `state` prop, `splat.ts:~234`).

4. **SH bands > 0 are dropped** (spz written with `shDegree: 0`, `sh: empty`) — same as the current
   avatar path. `SingleSplat` with the 14-member list skips its SH block entirely (verified). Statics
   from PLY with SH will look slightly flatter; documented v1 limitation.

5. **sog4d DYNAMIC nodes (`splat.isDynamic`) are SKIPPED** in v1 with a warning popup naming them.
   `isDynamic` is set ONLY when the loaded resource carries a `dynManifest` (`splat.ts:185-187`) — a
   static `.sog` can NOT be mis-classified (it routes through the engine's gsplat loader,
   `asset-loader.ts:95-96` / `loaders/gsplat.ts:36`, and becomes a plain splat with the full 14-prop set).

6. **Quaternion convention — SETTLED: everything the v1 export touches is rot_0=w.** Authority chain
   (source-verified): serializer `splat-serialize.ts:393`; PlayCanvas engine SplatIterator
   (`gsplat-data.js` reads rot_0 as w); the engine's static-SOG reader writes `data.rot_0[i] = r.w`
   (`gsplat-sog-data.js:236`), and static .sog loads decompress through it. The fork's sog4d DYNAMIC
   decoder (`sog4d.ts:572`) has misleading `[qx,qy,qz,qw]` variable names — the encoder/decoder
   idx-table proof shows it too is effectively w-first — but its invalid-tag "identity" fallback
   `(0,0,0,1)` is wrong under w-first (a latent bug on a corrupt-data-only path). None of this matters
   in v1 (dynamics are skipped); re-settle before any future dynamic export. spz conversion reorders
   to `[x,y,z,w]` normalized, exactly like the existing `gsplatToSpz`.

## Package layout (v2)

```
<scene>-spark.zip
├─ index.html            (template, <title> rewritten to "Shooting Lab 4DGS Demo — <scene>")
├─ player.js  vendor/…   (template verbatim)
├─ manifest.json
├─ audio.m4a             (optional — from the FIRST atlas with audioUrl)
└─ objects/
    ├─ 0_<name>.spz          ← static object: ONE spz (transform-baked, deleted-filtered)
    └─ 1_<name>/             ← animated object (atlas): per-frame, transform-baked
        ├─ frames/frame_0000.spz … frame_0011.spz     (HEAD, min(12, N))
        └─ rest.zip                                    (TAIL, global names, ZIP_STORED)
```

`manifest.json` v2:
```json
{ "version": 2, "name": "<scene>", "audio": "audio.m4a" | null,
  "objects": [
    { "id": "0_<name>", "type": "static",   "src": "objects/0_<name>.spz", "numSplats": N },
    { "id": "1_<name>", "type": "animated", "dir": "objects/1_<name>",
      "frames": T, "fps": F, "headCount": H, "audio": true }
  ] }
```
- `id` = `<index>_<sanitized name>` (index prefix guarantees uniqueness; sanitizer =
  `replace(/\.[^.]+$/,'').replace(/[^\w.-]+/g,'_')`, same as today).
- Object order = scene order (`scene.getElementsByType(ElementType.splat)`); objects with
  `splat.visible === false` are skipped (accessor verified, `splat.ts:1619`).
- **Scene name** = the FIRST exported object's sanitized name (used for `manifest.name` AND the zip
  filename; the old selection-priority convention is dropped — its only consumer was this exporter).
- `audio: true` marks the animated object that owns the soundtrack.
- v2 animated objects are **rest.zip-tailed only** in this version (no per-object `tailMode`; the
  field is reserved — the v1 path's `tailMode:'individual'` support exists for demo-repackager
  convergence, not for v2).
- At least ONE exportable object required (statics-only scenes are legal → a static Spark viewer);
  zero objects → generalized "nothing exportable" popup.

## Player (template) changes — `public/spark-template/{player.js,index.html}`

1. **Manifest dispatch:** `manifest.version === 2` → scene loader; otherwise the EXISTING single-avatar
   path runs **behavior-identically** (old zips and the demo repackager's v1 packages — which carry
   `tailMode` but no `version` — keep playing exactly as before; the frame machinery may be
   restructured, the observable behavior may not change).
2. **Scene loader:** one root `THREE.Group` (existing `group`) holds every object's meshes at identity.
   - static → one `SplatMesh({fileBytes, fileType:'spz'})`, added once.
   - animated → per-object struct `{meshes[], idx, last, fps, total, hasAudio}` — the existing
     visibility-cycling generalized from module globals to per-object structs (v1 constructs exactly
     one struct).
   - **Audio sync modulo = LOADED mesh count**, mirroring v1 (`player.js:197`): the audio-owning object
     uses `idx = floor(audioEl.currentTime * fps) % meshes.length` (guard `meshes.length > 0`, and the
     v1 guard shape `hasAudio && audioEl && !audioEl.paused && audioEl.duration`, else wall-clock);
     `total` from the manifest is only for the loading bar / rest.zip decision. Using `% total` would
     index not-yet-loaded meshes during progressive tail load → TypeError in the render loop.
   - **First paint (v2):** playback starts after ALL statics + ALL HEAD frames have loaded (the loading
     bar spans statics + Σ animated frames). This trades v1's instant frame-0 start for simplicity;
     v1 packages keep their instant start. Documented, deliberate.
   - TAILs stream in the background per object (rest.zip, existing logic reused).
3. **XR / controls / camera:** grab/scale/rotate & recenter already operate on the root group → they
   move the whole scene; untouched. **v1 limitation (documented):** the camera/controls are
   head-tuned (FOV 20, z≈0.95, orbit min/max distance 0.4/2.0, pan disabled, recenter places the group
   ~0.9 m ahead at scale 1) — composed scenes should fit within roughly 2 units of the origin; a
   scene-bounds-aware camera is a follow-up, out of scope.
4. **Template convergence (Task 1, verified strict superset):** copy the demo's vendored template
   (`D:/2026/flexavatar/flexavatar/web_demo/spark_export/spark-template/`) over the fork's verbatim —
   byte-diff confirmed it is the fork template + persistent `#sound` mute toggle + copyright watermark
   (`© 2026 Shooting Lab Limited · All Rights Reserved · slfpv.com`) + `tailMode==='individual'`
   batched tail loader; `vendor/` byte-identical (untouched); the fork template is otherwise unused
   inside the editor (only the export fetches it), so nothing can regress.
5. **Title:** export rewrites `<title>…</title>` to `Shooting Lab 4DGS Demo — <scene>` (em-dash
   U+2014; same rule as the demo repackager).

## Export flow (`src/spark-export.ts`)

1. Collect `scene.getElementsByType(ElementType.splat)`, drop `!visible`; partition:
   atlas (`isAtlas && atlasFrames?.length`) / dynamic (`isDynamic` → collect names, skip) /
   static (rest). Nothing exportable → popup, abort. Dynamics skipped → after a successful export,
   warning popup "skipped N dynamic node(s): <names> (not supported in Spark export v1)".
2. Statics: `SingleSplat` in the new full-world mode, skip deleted, accumulate → `serializeSpz`
   (shDegree 0). Members: x,y,z, rot_0..3, scale_0..2, f_dc_0..2, opacity (state read separately).
3. Atlases: per frame, bake the entity's current **full world transform** (constant across frames;
   identity fast path → avatar-only scenes stay byte-identical with the old export) → `serializeSpz`.
   HEAD → `objects/<id>/frames/`, TAIL → `objects/<id>/rest.zip` (ZIP_STORED).
   NOTE (verified): `SingleSplat.read(splat, i)` reads `splat.splatData` — frame k>0 data lives in
   `atlasFrames[k]` and lacks the `state` prop, so the atlas path uses a small dedicated bake with
   the SAME math/conventions. Also: `atlasOrientation` is identity — `asset-loader.ts:22` is
   authoritative; the stale docstring at `asset-loader.ts:107-110` claiming roll/yaw-180 is wrong.
4. Audio: first atlas with `audioUrl` → fetch → `audio.m4a` (existing fetch + fallback); that object's
   manifest entry gets `audio: true`.
5. `manifest.json` v2 + rewritten title + `player.js` + vendor → zip → download `${scene}-spark.zip`
   (existing download mechanics; progress spans all objects; keep the `(i & 3) === 0` yield).

## Error handling

- Zero exportable objects → info popup (no zip). Dynamics present → export proceeds, then warning
  popup listing skipped names.
- Audio fetch failure → package without audio (existing behavior, console.warn).
- Any encode failure → error popup, no partial zip (existing try/catch wraps everything).

## Testing / gates (source-verified against today's repo state)

The fork has NO unit-test suite, and two would-be gates are RED today for pre-existing reasons:
`npm run lint` fails with 614 pre-existing errors repo-wide (incl. `spark-export.ts:93`
no-promise-executor-return on the yield line and `splat-serialize.ts:500` trailing space);
`npx tsc --noEmit` fails with 49 node_modules-typing errors (no `skipLibCheck`). Therefore:

1. **Type/build gate:** `npm run build` (rollup + its TypeScript plugin; green today, ~19 s).
2. **Lint gate (file-scoped):** `npx eslint <exact files each task touches>` must be clean —
   Task 2 fixes the two pre-existing errors in its files as part of the diff
   (`await new Promise<void>((r) => { setTimeout(r); })`; strip the trailing space).
3. `node --check public/spark-template/player.js`.
4. **Template greps:** `#sound` + watermark + slfpv.com in index.html; `tailMode === 'individual'`,
   `BATCH`, `rest.zip`, `version === 2` all present in player.js; no `tapEl` / `'tap for sound'`.
5. **Live browser smoke (controller, after implementation):** build + serve; compose atlas
   (`?loadatlas=./bakes/NewEra__Ani_Woman/`) + a static (e.g. the same bake `&atlasframe=0` as a
   static node), MOVE/scale the static; export; unzip; verify manifest v2 + objects/ layout; serve
   the folder: both objects render **with the editor placement** (static orientation upright — the
   Rz(180) regression check), avatar animates with audio, watermark shows; and a **v1 package still
   plays** (regression: demo `/spark/<name>/` or an old zip).

## Scope

**v1 (this):** whole-scene export (statics + atlases, transforms baked, deleted-filtered), manifest
v2, multi-object player with per-object playback + shared root group XR, template convergence
(mute/watermark/individual-tail), title rule, dynamics skipped with warning.
**Out of scope:** sog4d dynamic export (quat layout there must be re-settled first); SH>0
preservation; per-object timeline offsets; scene-bounds-aware camera; poseSets playback in the Spark
player; upload; re-vendoring the updated template into the main demo repo (follow-up).
