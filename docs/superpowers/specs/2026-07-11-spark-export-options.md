# Spark export options — dialog + 5 reveal effects + camera autoplay/manual (2026-07-11)

Repo: `D:/2026/flexavatar/supersplat_spike/supersplat4d`, branch `flexavatar-atlas-4d`, IN PLACE.
NEVER push. Gates: `npx eslint <touched ts files>` clean; `npm run build`;
`node --check public/spark-template/player.js` (repo-wide lint/tsc RED pre-existing — never gate on them).

**Why:** the player hardcodes the Spread reveal and camera-path autoplay; the user wants to CHOOSE at
export time: which entrance effect (all five from the official example), how long, and whether the
camera path autoplays / waits for the 🎥 button / is omitted.

**Ground truth files:**
- Official 5-effect example (ALL the GLSL to port):
  `C:/Users/Admin/AppData/Local/Temp/claude/D--2026-flexavatar/0ba2b49d-f6b1-4113-8353-582b1a598433/scratchpad/spark-examples/splat-reveal-effects.html`
  (one `dyno.Dyno` with `effectType: "int"` input and GLSL branches for Magic=0? — read the file for
  the exact mapping — Spread, Unroll, Twister, Rain; plus per-effect camera positions you can ignore).
- Spark API d.ts: `.../scratchpad/spark-api/node_modules/@sparkjsdev/spark/dist/types/`.
- Dialog precedent in the fork: `src/ui/export-popup.ts` (the PLY export options popup) + how it is
  invoked from `src/file-handler.ts`; simpler dialog precedent: `src/ui/flexavatar-loader.ts`.

## Manifest contract (v2 additions — written by the exporter, read by the player)

```json
"player": {
  "reveal": { "effect": "spread" | "magic" | "unroll" | "twister" | "rain" | "off", "sec": 4.5 },
  "camera": { "autoplay": true | false }
}
```
- `player.camera` present ONLY when a camera path is exported. Choosing "Don't include" in the dialog
  omits BOTH `manifest.camera` and `player.camera`.
- Old packages have no `player` key → player falls back to built-ins (spread / 4.5 / autoplay).

**Precedence (player side): URL param > manifest.player > built-in default.**
URL params (extend the existing ones, keep back-compat):
- `?reveal=off|spread|magic|unroll|twister|rain` (existing `off` keeps working)
- `?revealsec=N` (0.5–20, existing)
- `?campath=auto|manual|off` (new; `off` = ignore manifest.camera entirely)

## Task 1 — player: five effects + manifest defaults + camera manual mode
(`public/spark-template/player.js` only)

1. **Port the official example's WHOLE effect Dyno** (all five GLSL branches, `effectType` int input)
   replacing the current Spread-only Dyno. Keep our shared uniforms: `revealT` (time), `revealK`
   (scene-scale), plus a new `revealEffect` (`dyno.dynoInt(...)` — verify the int-uniform constructor
   name in the d.ts / vendored bundle; the example itself passes `effectType` — read how it feeds it).
2. **Scale-normalization for ALL effects** (the fix that made Spread work on 0.3u heads): run each
   effect's position math in normalized space —
   `vec3 p = localPos * k;  ...effect math on p...  outCenter = p / k;`
   i.e. multiply the input center by `k` BEFORE the effect branch and divide the result by `k` AFTER,
   so every absolute-unit constant (spread wave, magic noise offsets, rain drop height, twister
   angle-by-height, unroll distance) behaves as if the scene were valley-scale. Relative scale mixes
   (`mix(vec3(0), scales, f)`) are scale-free — leave them. This SUBSUMES the current Spread-specific
   `l * k` (rewrite Spread the same normalized-space way; identical result since its math is xz-radial).
3. **Effect selection:** `revealEffectName` resolved by precedence (URL > manifest.player.reveal.effect
   > 'spread'); map name→effectType int per the example's mapping; `'off'` → reveal disabled (same as
   today's `?reveal=off`). Unknown name → warn + fall back to spread. REVEAL_MS from
   URL `revealsec` > manifest.player.reveal.sec > 4.5.
4. **Effect end-time:** the example's effects settle at different `t`; keep the existing
   REVEAL_T_END=7 mapping for all five in v1 (they all substantially settle by tt≈20 in normalized
   space; if a branch visibly snaps at removal, extend that branch's end handling with a final 200 ms
   opacity crossfade — implementer judgement, document what you did).
5. **Camera manual mode:** resolve `campathMode` (URL `campath` > manifest.player.camera.autoplay
   [true→auto, false→manual] > auto; URL/manifest absent + no camera block → none).
   - `auto`: current behavior (starts active, synced to the shared clock, aligned with the avatar
     timeline).
   - `manual`: `camPathActive` starts FALSE; 🎥 button visible and dimmed; when the user first
     activates it, the path starts from ITS OWN frame 0: store `camPathOffsetSec = <current clock>`
     at activation and use `frame = ((clock - camPathOffsetSec) * fps) % frames` (offset stays 0 in
     auto mode so autoplay alignment is unchanged). Re-toggling restarts from 0 again (recompute the
     offset each activation).
   - `off`: as if `manifest.camera` were absent (no spline, no 🎥).
6. Zero behavior change for old packages (no `player` key, no URL params): spread/4.5/autoplay —
   byte-equivalent decisions to today.
Gates: node --check; npm run build; greps: `magic|unroll|twister|rain` present in the Dyno GLSL,
`campath=` URL handling present.

## Task 2 — exporter: options dialog + manifest.player
(`src/spark-export.ts` + ONE new file `src/ui/spark-export-dialog.ts` + minimal wiring)

1. **Dialog** (model on `src/ui/export-popup.ts` — pcui Container/SelectInput/NumericInput/Button;
   plain English strings, no localization keys needed):
   - Title: "SPARK PLAYER EXPORT".
   - **Camera path** select: `Autoplay` / `Manual (🎥 button)` / `Don't include` — default Autoplay.
     When the scene has <2 valid camera poses, show the select disabled with hint text
     "(no camera poses on the timeline)" and treat as Don't include.
   - **Entrance effect** select: `Spread` (default) / `Magic` / `Unroll` / `Twister` / `Rain` / `None`.
   - **Duration (s)** numeric: default 4.5, min 0.5, max 20, step 0.5; disabled when effect = None.
   - `Export` / `Cancel` buttons. Cancel → no export.
2. **Wire into `sparkExport`:** show the dialog FIRST (after the exportables/zero-object check, so a
   scene with nothing exportable still gets the existing info popup without a dialog); on Export,
   proceed with the chosen options; on Cancel, return silently.
3. **Manifest:** write `player: { reveal: { effect, sec }, ...(cameraIncluded ? { camera: { autoplay } } : {}) }`.
   `effect` lowercase name; `None` → `"off"` (and `sec` still written, harmless). When the user picks
   "Don't include" (or <2 poses), skip the `camera` block entirely (existing `camPoses.length >= 2`
   guard extends with the dialog choice).
4. eslint clean on both ts files; npm run build.

## Out of scope
Per-effect parameter tuning UI; remembering last-used options (nice-to-have later); re-vendoring the
demo repo's template (separate follow-up).
