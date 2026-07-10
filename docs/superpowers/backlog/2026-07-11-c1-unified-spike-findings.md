# C1 unified-sorting spike — findings (2026-07-11)

**Verdict: INCOMPATIBLE.** `GSplatComponent.unified` (PlayCanvas 2.16.0) cannot be adopted by
this fork with a minimal change. The unified path deletes the entire `entity.gsplat.instance`
API surface the fork is built on — the very first splat load would throw in the `Splat`
constructor. Recommendation: **C2 preview button** (Spark-side preview, which already sorts
globally and is user-verified correct) as the fallback for the cross-object depth-composite
problem.

## What was tried

Minimal change per spike protocol: `src/splat.ts:197`
`entity.addComponent('gsplat', { asset })` → `entity.addComponent('gsplat', { asset, unified: true })`.
`unified` is a legit component-data property (engine `_properties` list,
`node_modules/playcanvas/build/playcanvas.mjs:84253`; setter `:82354`; documented
`playcanvas.d.ts:34159` `entity.gsplat.unified = true`).

- `npm run build`: **green** (TypeScript accepts the option; nothing breaks at compile time).
- Static analysis of every fork touchpoint against the engine's unified code path: **every
  touchpoint breaks** (detail below). The change was reverted; working tree is clean of src edits.

## How the engine consumes `unified` (playcanvas.mjs, 2.16.0)

- `_onGSplatAssetLoad` (`playcanvas.mjs:82606-82616`): when `unified`, the component creates a
  **`GSplatPlacement`** (stored in private `_placement`, initialized `:82638`) and **never creates
  a `GSplatInstance`**. There is **no public `placement` getter**; the only public escape hatch is
  `getInstanceTexture(name)` (`:82590-82595`).
- `set instance` no-ops when unified (`:82247-82250`) → `entity.gsplat.instance` stays **`null`**.
- `material` setter no-ops (`:82269-82271`) and getter returns **`null`** (`:82279-82282`;
  documented `playcanvas.d.ts:34331`: "returns null when unified is true — use
  `GSplatComponentSystem#getMaterial`", which is per camera+layer, created lazily during render).
- Sorting is scene-level: `GSplatManager` owns one **`GSplatUnifiedSorter`**
  (class `playcanvas.mjs:79940`, constructed `:81526`). Its whole API is
  `setCenters / updateCentersForSplats / setSortParameters / setSortParams`; it fires `'sorted'`
  `(count, version, orderData)` on the scene, **not** per object. Centers are copied
  (`centers.buffer.slice()`, `:79983`) and transferred to a worker — there is no mutable
  per-object `centers` array. Per-object visibility subsets are expressed as
  `placement.intervals` (a `Map` of index ranges), not a sorter mapping.
- The per-instance **`GSplatSorter`** (class `:38787`) with `setMapping(mapping)` (`:38815`) and
  the `'updated'` event (`:38873`) exists **only on the non-unified path**.
- Rendering: unified draws from a shared **work buffer** re-copied from resource textures only
  when `placement.consumeRenderDirty()` reports dirty (`:80316-80331`); custom shading is done via
  `workBufferModifier` (`:80309`), a different injection mechanism from owning the material.

## Fork touchpoints that break (fork file:line → engine unified counterpart)

All break for the same root cause — `entity.gsplat.instance === null` under unified — but they
matter differently:

1. **FATAL, load-time**: `src/splat.ts:200-210` — constructor requires `gsplat.instance` and
   `throw`s if null (engine: instance never created under unified, `playcanvas.mjs:82606-82616`).
   Every splat load fails instantly; nothing else even gets reached.
2. `src/splat.ts:213` — `instance.meshInstance.calculateSortDistance` (custom render-order):
   no `meshInstance` under unified (work-buffer rendering, `playcanvas.mjs:80316`).
3. **Our 4D atlas hot path**: `src/splat.ts:615-616` — per-frame
   `instance.resource.updateTransformData/updateColorData` texture swap. Resource is still
   reachable via the asset, but unified renders from the shared work buffer which only re-copies
   on `placement.renderDirty` (`playcanvas.mjs:80316-80331`) — and `_placement` is private, so the
   fork cannot even set `renderDirty` per frame without reaching into engine privates.
4. `src/splat.ts:964`, `:1087`, `:1099-1112`, `:1369-1378` — `instance.sorter.setMapping(...)`
   (deleted-splat visibility + sog4d segment cycling): `GSplatUnifiedSorter` has **no
   `setMapping`** (API at `playcanvas.mjs:79940-80045`); the unified equivalent is
   `placement.intervals`, private and semantically different (index ranges, not an arbitrary
   index mapping).
5. `src/splat.ts:929`, `:992`, `src/editor.ts:503`, `src/splat-serialize.ts:790`, `:821` —
   read/mutate `instance.sorter.centers` (edit-time position updates, pivot placement, export
   extents): unified copies centers into a worker (`playcanvas.mjs:79983`); no accessible array.
6. `src/splat.ts:1020`, `:1400` — `instance.material` `setDefine('FROZEN_OPACITY')` /
   `setParameter(...)` for the selection/state shader: material getter returns `null`
   (`playcanvas.mjs:82279-82282`); unified customization = `workBufferModifier` +
   `GSplatComponentSystem.getMaterial(camera, layer)` — a different architecture, not a swap-in.
7. `src/ply-sequence.ts:30` — `instance.sorter.on('updated', ...)` (first-render gate): unified
   fires `'sorted'` on the scene-level sorter (`playcanvas.mjs:79964`), not per object.
8. `src/data-processor.ts:274`, `:388`, `:453`, `src/splat-overlay.ts:85` —
   `instance.resource.getTexture('transformA')` for GPU intersect/edit passes and the overlay:
   throws on null instance as written (workaroundable via `asset.resource`, but these passes are
   part of the same per-instance material/state pipeline as #6).

## Verdict rationale + recommendation

The fork is an *editor*: it depends on per-object sorter mappings, mutable centers, and owning
each splat's material — exactly the three things unified mode centralizes away. Adopting unified
is a rewrite of the fork's splat pipeline (placements + intervals + workBufferModifier +
scene-level sort events), not a spike-scope change.

- **Recommended**: C2 — a "preview in Spark" button. The Spark player already does global
  sorting correctly (user-verified); the editor keeps its per-object pipeline for editing, and
  cross-object depth correctness is verified in the preview.
- Not recommended now: migrating the editor to placements/intervals/workBufferModifier — days of
  engine-coupled refactor with unclear support for the sog4d dynamic mapping and per-frame atlas
  texture swaps (points 3-5 above have no public unified equivalent at all in 2.16.0).
