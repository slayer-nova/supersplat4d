# Spark SCENE Export — Implementation Plan (rev 2)

> **For agentic workers:** executed via ultracode workflow orchestration (implementer + adversarial
> reviewers per task). Repo: `D:/2026/flexavatar/supersplat_spike/supersplat4d`, branch
> `flexavatar-atlas-4d`, work IN PLACE. Spec (binding, rev 2):
> `docs/superpowers/specs/2026-07-11-spark-scene-export-design.md`.

**Goal:** File ▸ Export ▸ Spark Player… exports the WHOLE scene (statics + atlases, transforms baked)
as a manifest-v2 package; the template player renders multi-object scenes and stays v1-compatible.

## Global Constraints

- Branch `flexavatar-atlas-4d` IN PLACE. NEVER `git push` (origin NOR backup). `git add` only named files.
- Canonical GSplatData quat convention: **rot_0=w, rot_1..3=x,y,z** (settled — see spec decision 6).
  spz-js input: `rotations=[x,y,z,w]` normalized; scales LOG; opacity LOGIT; colors SH-DC;
  `shDegree: 0, sh: empty` (exactly like the existing `gsplatToSpz`).
- **Bake frame = PURE `entity.getWorldTransform() × palette`** — a NEW mode. Do NOT use either
  existing `keepWorldTransform` polarity: `true` skips the world transform entirely (doc-save mode),
  `false` prepends `Rz(0,0,-180)` (PLY-round-trip frame → statics would render 180°-rolled in Spark).
- Bake math identical to `splat-serialize.ts:369-402`: `mat.transformPoint` on xyz;
  `q.set(rot_1,rot_2,rot_3,rot_0).mul2(bakeRot, q)` with **bakeRot = `Quat.setFromMat4(bakeMat)`**
  (scale-safe, includes palette); `scale_i = log(exp(scale_i) * axisScale_i)` from `bakeMat.getScale()`.
- Statics filter `state[i] & State.deleted` (`State.deleted = 4`, import from `./splat-state`).
- Manifest v2 + package layout exactly per spec; `<title>` → `Shooting Lab 4DGS Demo — <scene>`
  (em-dash U+2014); scene name = FIRST exported object's sanitized name.
- Player v1 path stays **behavior-identical** (old zips + demo `/spark/<name>/` packages keep playing).
- **Gates (repo-wide lint/tsc are RED pre-existing — do NOT use them):**
  per task = `npx eslint <files touched>` clean + `npm run build` succeeds; template changes also
  `node --check public/spark-template/player.js`.
- HEAD_FRAMES = 12; TAIL rest.zip per animated object, ZIP_STORED; names `frame_%04d.spz` global index.

---

### Task 1: Template convergence (copy the demo's improved template over the fork's)

The demo's vendored template (`D:/2026/flexavatar/flexavatar/web_demo/spark_export/spark-template/`)
is a VERIFIED strict superset of the fork's (`public/spark-template/`): fork template + persistent
`#sound` mute toggle + copyright watermark + `tailMode==='individual'` batched loader; `vendor/`
byte-identical; the fork template hasn't changed since vendoring (fork HEAD 5cb3393).

**Steps:**
1. Copy `D:/2026/flexavatar/flexavatar/web_demo/spark_export/spark-template/index.html` over
   `public/spark-template/index.html`; same for `player.js`. Do NOT touch `vendor/`.
2. Greps: `id="sound"`, `Shooting Lab Limited`, `slfpv.com` in index.html; `tailMode === 'individual'`,
   `BATCH`, `rest.zip` in player.js; NO `tapEl` / `'tap for sound'` anywhere.
3. `node --check public/spark-template/player.js` → exit 0; `npm run build` → template lands in dist/.
4. Commit: `git add public/spark-template/index.html public/spark-template/player.js` →
   `feat(spark): converge player template with demo (mute toggle, watermark, individual-tail)`.

---

### Task 2: `spark-export.ts` — whole-scene export (manifest v2)

**Files:** modify `src/spark-export.ts`; modify `src/splat-serialize.ts` (two small changes: the new
bake mode + export `SingleSplat`).

**2a. `splat-serialize.ts` — new bake mode + export (keep the diff minimal):**
- `SerializeSettings` interface: add `bakeFullWorldTransform?: boolean;` (comment: "bake the pure
  entity world transform — Spark/editor-world frame; unlike keepWorldTransform:false there is NO
  Rz(-180) PLY-round-trip prefix").
- `SplatTransformCache.getMat` (around lines 231-249): where today it does
  `if (!keepWorldTransform) { mat.setFromEulerAngles(0,0,-180); mat.mul2(mat, splat.entity.getWorldTransform()); }`,
  add the new branch FIRST: if `bakeFullWorldTransform` → `mat.copy(splat.entity.getWorldTransform())`
  (no euler prefix), then fall through to the SAME palette composition the existing code applies.
  Read the real code and keep every other line identical; `getRot`/`getScale` already derive from
  `getMat` so they inherit the mode for free.
- Export list (~line 1132-1143): add `SingleSplat`.
- Fix the ONE pre-existing lint error in this file: `splat-serialize.ts:500` trailing whitespace.

**2b. `spark-export.ts` — rewrite the export body:**
- Partition visible splats (`splat.visible === false` → skip): `atlases` (`isAtlas &&
  atlasFrames?.length`), `dynamics` (`isDynamic` → names for the warning), `statics` (rest).
  Nothing exportable → info popup ("Nothing exportable — load a static splat or FlexAvatar first."),
  return. Dynamics present → after the download starts, warning popup listing skipped names.
- **Static → one spz** via the serializer's iterator (palette/deletes/conventions inherited):
  ```ts
  import { SingleSplat } from './splat-serialize';
  import { Quat, Vec3 } from 'playcanvas';
  const MEMBERS = ['x','y','z','rot_0','rot_1','rot_2','rot_3','scale_0','scale_1','scale_2','f_dc_0','f_dc_1','f_dc_2','opacity'];
  const staticToSpz = async (splat: any): Promise<{ spz: Uint8Array, n: number }> => {
      const state = splat.splatData.getProp('state') as Uint8Array | undefined;
      const total = splat.splatData.numSplats;
      const single = new SingleSplat(MEMBERS, { bakeFullWorldTransform: true });
      let n = 0;
      for (let i = 0; i < total; i++) if (!state || (state[i] & 4) === 0) n++;   // State.deleted = 4
      const positions = new Float32Array(n * 3), scales = new Float32Array(n * 3),
            colors = new Float32Array(n * 3), alphas = new Float32Array(n), rotations = new Float32Array(n * 4);
      let k = 0;
      for (let i = 0; i < total; i++) {
          if (state && (state[i] & 4) !== 0) continue;
          single.read(splat, i);
          const d = single.data;
          positions[k * 3] = d.x; positions[k * 3 + 1] = d.y; positions[k * 3 + 2] = d.z;
          scales[k * 3] = d.scale_0; scales[k * 3 + 1] = d.scale_1; scales[k * 3 + 2] = d.scale_2;
          colors[k * 3] = d.f_dc_0; colors[k * 3 + 1] = d.f_dc_1; colors[k * 3 + 2] = d.f_dc_2;
          alphas[k] = d.opacity;
          const w = d.rot_0, x = d.rot_1, y = d.rot_2, z = d.rot_3, l = Math.hypot(w, x, y, z) || 1;
          rotations[k * 4] = x / l; rotations[k * 4 + 1] = y / l; rotations[k * 4 + 2] = z / l; rotations[k * 4 + 3] = w / l;
          k++;
      }
      return { spz: await serializeSpz({ numPoints: n, shDegree: 0, positions, scales, rotations, alphas, colors, sh: new Float32Array(0) } as any), n };
  };
  ```
- **Atlas frames → per-frame spz with the entity's full world transform baked** (constant across
  frames; atlases carry no palette edits). Extend the existing `gsplatToSpz(gd)` to
  `gsplatToSpz(gd, bake?)` where `bake = { mat, rot, scale }`:
  ```ts
  // caller, per atlas:
  const worldMat = splat.entity.getWorldTransform();
  const isIdentity = /* pos≈0, rot≈identity, scale≈1 within 1e-6 — check mat data vs Mat4.IDENTITY */;
  const bake = isIdentity ? null : {
      mat: worldMat,
      rot: new Quat().setFromMat4(worldMat),   // scale-safe (normalizes basis)
      scale: worldMat.getScale(new Vec3()),
  };
  // inside gsplatToSpz, when bake is non-null, per splat BEFORE writing the arrays:
  //   v.set(x,y,z); bake.mat.transformPoint(v, v);
  //   q.set(rx, ry, rz, rw).mul2(bake.rot, q);            // input q = (rot_1,rot_2,rot_3,rot_0)
  //   s_i' = Math.log(Math.exp(s_i) * bake.scale.<axis>);
  // identity fast path (bake=null): current behavior byte-identical (avatar-only regression property).
  ```
  NOTE: `atlasOrientation` is identity — `asset-loader.ts:22` is authoritative; the stale docstring at
  `asset-loader.ts:107-110` claiming roll/yaw-180 is WRONG, ignore it.
- **Package assembly:** `objects/` per spec. Per-atlas HEAD (min(12, frames)) →
  `objects/<id>/frames/frame_%04d.spz`; TAIL → `objects/<id>/rest.zip` via nested JSZip
  `{ compression: 'STORE' }` (mirror the existing block). Statics → `objects/<id>.spz`.
  `id = ${index}_${sanitize(splat.name)}` (existing sanitizer).
- **Audio:** first atlas with `audioUrl` (existing fetch + console.warn fallback) → `audio.m4a`;
  that object's manifest entry `audio: true`.
- **Manifest v2** exactly per spec; **scene name** = FIRST exported object's sanitized name; zip
  `${name}-spark.zip`; `<title>` rewrite:
  `index = index.replace(/<title>[\s\S]*?<\/title>/, \`<title>Shooting Lab 4DGS Demo — ${name}</title>\`);`
- **Progress:** `progressStart/Update/End` across total units (statics + Σ frames); keep the yield,
  but FIX its pre-existing lint error: `await new Promise<void>((r) => { setTimeout(r); });`
  (spark-export.ts:93 `no-promise-executor-return`).

**Gates:** `npx eslint src/spark-export.ts src/splat-serialize.ts` → 0 problems;
`npm run build` → success.
**Commit:** `git add src/spark-export.ts src/splat-serialize.ts` →
`feat(spark): whole-scene export — statics + atlases, transforms baked, manifest v2`.

---

### Task 3: `player.js` — scene loader (manifest v2) + per-object playback

**File:** `public/spark-template/player.js` (the CONVERGED one from Task 1).

**Requirements:**
1. Per-object structs replacing the module globals (`frames[]`, `frameIndex`, `lastSwap`, `fps`),
   with the v1 path constructing exactly ONE struct so its OBSERVABLE behavior is unchanged
   (instant frame-0 start, audio-sync, tailMode branch, XR auto-sound, autoplay-block fallback,
   #sound hide-when-silent, loadEl fade, fail() wrapper — all preserved):
   ```js
   const animObjects = [];   // { meshes: [], idx: 0, last: 0, fps, total, hasAudio }
   const addFrameTo = (o, u8) => { const m = new SplatMesh({ fileBytes: u8, fileType: 'spz' });
       m.visible = (o.meshes.length === 0); group.add(m); o.meshes.push(m); };
   ```
   Render-loop swap generalized:
   ```js
   for (const o of animObjects) {
     if (o.meshes.length > 1 && (t - o.last) > (1000 / o.fps)) {
       o.meshes[o.idx].visible = false;
       if (o.hasAudio && audioEl && !audioEl.paused && audioEl.duration) {
         o.idx = Math.floor(audioEl.currentTime * o.fps) % o.meshes.length;   // LOADED count — never % o.total
       } else {
         o.idx = (o.idx + 1) % o.meshes.length;
       }
       o.meshes[o.idx].visible = true;
       o.last = t;
     }
   }
   ```
2. `load()` dispatch: `manifest.version === 2` → `loadScene(manifest)`; else the EXISTING v1 body
   (including the Task 1 `tailMode` branch) reworked onto one animObject, behavior-identical.
3. `loadScene(manifest)` (adapt identifiers to the real file — `group`, `pad4`, `setBar`,
   `startPlayback`, `updateSound`, `soundEl`, `audioEl` all exist):
   ```js
   async function loadScene(manifest) {
     const objects = manifest.objects || [];
     const statics = objects.filter((o) => o.type === 'static');
     const anims   = objects.filter((o) => o.type === 'animated');
     if (manifest.audio) { audioEl = new Audio('./' + manifest.audio); audioEl.loop = true; updateSound(); }
     if (!manifest.audio && soundEl) soundEl.style.display = 'none';
     const totalUnits = statics.length + anims.reduce((s, o) => s + o.frames, 0);
     let done = 0; const bump = () => setBar(++done, totalUnits);
     for (const o of statics) {
       const buf = await fetch('./' + o.src).then((r) => { if (!r.ok) throw new Error(o.src + ' ' + r.status); return r.arrayBuffer(); });
       const m = new SplatMesh({ fileBytes: new Uint8Array(buf), fileType: 'spz' });
       group.add(m); await m.initialized; bump();
     }
     for (const o of anims) {
       const st = { meshes: [], idx: 0, last: 0, fps: o.fps || 30, total: o.frames, hasAudio: !!o.audio };
       animObjects.push(st);
       const head = Math.min(o.headCount || 1, o.frames);
       const bufs = [];
       for (let i = 0; i < head; i++) bufs.push(fetch(`./${o.dir}/frames/frame_${pad4(i)}.spz`).then((r) => r.arrayBuffer()));
       for (let i = 0; i < head; i++) { addFrameTo(st, new Uint8Array(await bufs[i])); bump(); }
     }
     startPlayback();          // v2 first paint = after statics + all HEADs (documented tradeoff)
     for (let a = 0; a < anims.length; a++) {
       const o = anims[a]; const st = animObjects[a];
       if (o.frames <= (o.headCount || 1)) continue;
       const restBuf = await fetch(`./${o.dir}/rest.zip`).then((r) => { if (!r.ok) throw new Error('rest.zip ' + r.status); return r.arrayBuffer(); });
       const zip = await JSZip.loadAsync(restBuf);
       const names = Object.keys(zip.files).filter((f) => f.toLowerCase().endsWith('.spz')).sort();
       for (let i = 0; i < names.length; i++) { addFrameTo(st, await zip.file(names[i]).async('uint8array')); bump(); }
     }
   }
   ```
   Statics-only: `startPlayback()` still runs (render loop with zero animObjects just orbits statics).
4. XR/grab/recenter/watermark untouched (they act on `group`/DOM).

**Gates:** `node --check public/spark-template/player.js`; greps: `version === 2` present AND
`tailMode === 'individual'` still present AND `rest.zip` still present; `npm run build`.
**v1 regression check (part of this task):** after build, the demo's known-good v1 package must still
load — verify by static inspection that the v1 code path is reachable and its logic unchanged
(the controller does the live browser check afterward).
**Commit:** `git add public/spark-template/player.js` →
`feat(spark): scene-manifest v2 player — multi-object, per-object playback, v1 compatible`.

---

### Task 4: docs commit + final gates

1. `git add docs/superpowers/specs/2026-07-11-spark-scene-export-design.md docs/superpowers/plans/2026-07-11-spark-scene-export.md` →
   `docs: spark scene export spec + plan (rev 2)`.
2. Full gates: `npx eslint src/spark-export.ts src/splat-serialize.ts` clean; `npm run build`;
   `node --check public/spark-template/player.js`; template greps (Task 1 set + `version === 2`).
3. Report `git log --oneline` of the new commits.
