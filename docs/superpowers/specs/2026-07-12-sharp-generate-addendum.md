# Generate from Image: SHARP model support — Addendum Spec

**Date:** 2026-07-12
**Repo:** supersplat4d fork, branch `flexavatar-atlas-4d`
**Base spec:** `2026-07-12-lito-generate-from-image-design.md` (the pipeline, dialog shell,
error mapping, one-run enforcement, and import contract all carry over UNCHANGED — this
addendum only adds a second model to the existing feature).

## Goal

The File ▸ Generate from Image… dialog gains a **Model** choice: **LiTo** (current, SH3,
object-centric) or **SHARP** (Apple ml-sharp via ComfyUI-Sharp — SH0, scene-level, no
background removal). Same UX: pick image → Generate → PLY auto-imports.

## Validated facts (probed live on 2026-07-12 against ComfyUI 8190 — do not re-derive)

- Registered nodes: `LoadSharpModel { device: ['auto','cuda','mps','cpu'] def 'auto',
  checkpoint_path?: '' }` → SHARP_MODEL; `SharpPredict { model, image,
  focal_length_mm?: FLOAT def 30.0 min 0 max 500 (0 = auto), output_prefix?: 'sharp' }` →
  [ply_path STRING, extrinsics, intrinsics], **output_node: true**;
  `PreviewGaussianSharp { ply_path }`, output_node: true.
- **A graph ending at SharpPredict completes with EMPTY history outputs `{}`** (probed:
  status success, no ui payload) — the import step would have nothing to read.
  **`PreviewGaussianSharp` MUST terminate the graph**; its history output is
  `{"<id>": {"ply_file": ["probe2_sharp_1783806360027.ply"], "filename": [...],
  "file_size_mb": [...]}}` — note the value is a **relative basename**, not an absolute
  path like LiTo's `file_path`.
- Output file lands in the ComfyUI output root: `<output_prefix>_<epoch_ms>.ply` — the
  timestamp is server-side, so the name CANNOT be derived client-side; always read it from
  history outputs.
- SHARP PLY = SH0: 14 props (xyz + f_dc×3 + opacity + scale×3 + rot×4, no normals, no
  f_rest), ~66 MB / 1,179,648 splats for a 518-ish input. Loads through the same editor
  PLY path (`/view?filename=<name>&type=output&subfolder=`).
- SHARP runs in the HOST ComfyUI python (plain custom node, no comfy-env isolation);
  checkpoint auto-downloads from Hugging Face on first LoadSharpModel (already cached on
  this machine). Warm generation ≈ 30–45 s.
- ComfyUI-Sharp assets (apple.png etc.) share the same input folder as LiTo's.

## Scope

```
src/ui/lito-generate-dialog.ts   MOD   Model select row + per-model row visibility + focal row
src/lito-generate.ts             MOD   sharp graph builder + generalized output extraction
```

NO spark-export changes: SHARP objects have zero f_rest → `detectShBands` returns 0 → they
take the SH0 baked path automatically, and the 'lito' Keep-SH name filter doesn't match
`*_sharp_*` names. State this in a code comment where the sharp graph is built.

## Dialog changes

1. **Model row** — FIRST row (above Image): label `Model`, SelectInput:
   - `lito` → `LiTo (Apple) — object, SH3` (**defaultValue**)
   - `sharp` → `SHARP (Apple) — scene, SH0`
   Persisted to `localStorage['lito.genModel']` (read at construction with fallback
   `'lito'`; invalid stored values fall back to `'lito'`). Written by the PIPELINE after a
   successful queue, alongside the existing `lito.comfyUrl` write (same single persistence
   point; persist the captured `opts.model`, not the live select value).
2. **Per-model row visibility** (toggle on Model change AND on show()-restore):
   - lito: show Remove background / Sampling steps / CFG scale / Seed; hide Focal length.
   - sharp: hide those four; show **Focal length (mm, 0 = auto)** — NumericInput min 0,
     max 500, step 0.1, precision 1, default 30.
3. `LitoGenerateOptions` gains `model: 'lito' | 'sharp'` and `focalMm: number`. `collect()`
   always fills both (focalMm from the input regardless of visibility).
4. `setBusy` must disable the Model select and Focal input like the other rows.
5. Everything else (image row, URL row, status row, buttons, Enter/Escape guards, busy
   semantics, show() reset of status) — UNCHANGED.

## Pipeline changes (`src/lito-generate.ts`)

1. Graph builder becomes per-model. LiTo graph: UNCHANGED. SHARP graph (wire shape
   identical to the base spec — `{"class_type", "inputs"}`, links `["<id>", <idx>]`):

   ```
   "1": LoadSharpModel        { device: "auto" }
   "2": LoadImage             { image: <uploaded name> }
   "3": SharpPredict          { model: ["1",0], image: ["2",0], focal_length_mm: opts.focalMm, output_prefix: <stem>_sharp }
   "4": PreviewGaussianSharp  { ply_path: ["3",0] }
   ```

   `<stem>` = same sanitize rule as the base spec. `client_id` stays `'supersplat-lito'`.
2. **Output extraction generalized**: from history `outputs`, take the first node value that
   has a `file_path` OR `ply_file` array with a non-empty string first element; `basename` =
   text after the last `/` or `\` (a no-op for SHARP's relative names). Everything
   downstream (the `/view` import URL, hideSilent-around-import, `[undefined]` failure
   detection, statuses) — UNCHANGED.
3. Missing-node error message becomes pack-aware:
   `error.type === 'missing_node_type'` → `` `${extra_info.class_type ?? 'node'} missing —
   check ComfyUI-LiTo / ComfyUI-Sharp install` `` (extra_info may be absent — guard it).
4. Persist `opts.model` to `localStorage['lito.genModel']` at the existing post-queue
   persistence point.
5. Timeout, polling, abort classification, one-run enforcement — UNCHANGED.

## Testing / gates

- `npx eslint src/lito-generate.ts src/ui/lito-generate-dialog.ts` clean; `npm run build` green.
- **Live smoke (controller):** dialog → Model = SHARP → apple.png → Generate → expect
  `Done — <stem>_sharp_<ts>.ply added to scene` within 3 min, element present; switch back
  to Model = LiTo → row visibility flips correctly → run one LiTo generation (regression,
  ~20 s warm) → Done. Screenshot with both generated objects in the scene.
- Dialog-only check: re-open after a SHARP run — model select restores 'sharp' from
  localStorage, focal row visible, status cleared.

## Constraints

Same as the base spec (fork only, no new deps, `feat(lito): …`, never push origin).
