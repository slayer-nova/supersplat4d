# Generate from Image (LiTo) — Design Spec

**Date:** 2026-07-12
**Repo:** supersplat4d fork, branch `flexavatar-atlas-4d`
**Status:** validated end-to-end manually on 2026-07-11 (apple.png → 970,816-splat PLY → editor import)

## Goal

One menu action turns a photo into a 3DGS object in the current scene: **File ▸ Generate from
Image…** opens a dialog, the user picks an image, the editor drives the local ComfyUI-LiTo
pipeline over HTTP, and when generation finishes the resulting PLY is imported into the scene
automatically. Everything runs locally (RTX 5090, ComfyUI at `http://127.0.0.1:8190`).

## Non-goals (v1)

- No ComfyUI process management (server must already be running; clear error if not).
- No generation queue UI / multiple concurrent generations (one at a time; Generate disabled while running).
- No server-side cancel (closing the dialog stops the editor's polling; ComfyUI finishes the job on its own).
- No image editing/cropping UI (LiToPreprocess handles background removal + crop).
- No progress percentage (ComfyUI's per-node progress via websocket is out of scope; elapsed-seconds text is enough).

## Validated facts (from the 2026-07-11 manual run — implementers: do not re-derive)

- ComfyUI runs at port **8190** with `--enable-cors-header "*"` → browser fetch/POST from
  `localhost:3000` works, including JSON preflight.
- Registered node names: `LiToLoadModel`, `LiToPreprocess`, `LiToImageTo3D`, `LiToExportPLY`,
  `LiToPreviewPointCloud`.
- `LiToExportPLY` has `output_node: False` → a graph ending there is rejected with
  `prompt_no_outputs`. **`LiToPreviewPointCloud` must terminate the graph** (it is an output node
  and takes `file_path` from ExportPLY's string output).
- History `outputs` shape (from the preview node, id `"7"` in the manual run):
  `{"7": {"file_path": ["D:\\...\\ComfyUI\\output\\lito_apple_test.ply"]}}` — an **absolute disk
  path**; take `basename` and fetch the bytes via ComfyUI's
  `GET {url}/view?filename=<basename>&type=output&subfolder=`.
- `LiToExportPLY` auto-dedupes filenames server-side (`_0001` counter) and the actual path comes
  back in outputs — no client-side collision handling needed beyond using the returned name.
- Generation takes ~15–60 s warm, ~3 min on first run (checkpoint already downloaded to
  `models/lito/`); model result is cached by ComfyUI between runs with identical LoadModel inputs.
- The editor imports a PLY from any same/cross-origin URL via
  `events.invoke('import', [{ filename, url }])` (file-handler.ts:454); 240 MB PLY imported in 2.6 s.
- **`events.invoke('import')` NEVER rejects on a failed load** — file-handler wraps the load in
  try/catch, shows its own error popup, and resolves with `[undefined]`
  (file-handler.ts:330-333, 440). Success detection = first element of the resolved array is
  truthy. (`result.length > 0` is NOT a valid check: `[undefined].length === 1`.)
- The import path fires the full-screen `startSpinner` (asset-loader.ts:48-50), and overlay
  siblings in `#top-container` stack VERTICALLY (no z-index management) — a visible dialog gets
  pushed off-screen while the spinner shows.
- `/prompt` responds 400 `{error: {type: 'missing_node_type', extra_info: {class_type}}}` with
  EMPTY `node_errors` when a node class isn't registered (that is the missing-LiTo signature).
- `/history/{id}` stays `{}` while the prompt is queued AND while it executes; the entry appears
  only when the prompt finishes (success or error). An interrupted job (cancelled from the
  ComfyUI web UI) has `status_str: 'error'` but only an `execution_interrupted` message —
  no `execution_error` entry and no `exception_message`.
- `client_id` in the `/prompt` body is REQUIRED, not cosmetic: ComfyUI only replays
  fully-cached output-node results into history `outputs` when the prompt carries a client_id
  (execution.py `_send_cached_ui`). Same image (upload hash-dedupe) + fixed seed = fully cached
  run = empty outputs without it.

## Architecture

Three touch points, mirroring the Spark-export pattern (self-attached register function; editor.ts untouched):

```
src/ui/lito-generate-dialog.ts   NEW   pcui dialog (modeled on spark-export-dialog.ts)
src/lito-generate.ts             NEW   registerLitoGenerate(events): pipeline + dialog wiring
src/ui/menu.ts                   MOD   File menu item 'Generate from Image...'
src/main.ts                      MOD   import + registerLitoGenerate(events) beside registerSparkExport
```

### Dialog (`src/ui/lito-generate-dialog.ts`)

Reuses the `.settings-dialog` overlay/dialog shell (same as `spark-export-dialog.ts`). Header
text: `GENERATE FROM IMAGE (LITO)`.

Rows:
1. **Image** — a Button (`Choose image…`) that triggers a hidden `<input type="file"
   accept="image/png,image/jpeg,image/webp">`, plus a Label showing the chosen filename
   (placeholder `no image selected`). Below it a 96 px-tall `<img>` preview (hidden until a file
   is chosen; `URL.createObjectURL`; revoke the previous object URL ONLY when replaced by a new
   selection — never on hide, since the selection persists across close/re-open and at most one
   object URL is ever live).
2. **ComfyUI URL** — TextInput, default `http://127.0.0.1:8190`, persisted to
   `localStorage['lito.comfyUrl']` (read at construction; the pipeline persists `opts.url` — the
   value captured at Generate click, never the live TextInput value — immediately after a
   successful `/prompt` queue response; a reachable, LiTo-capable server is worth remembering
   even if the generation later fails). Trailing slashes are stripped before use.
3. **Remove background** — BooleanInput, default `true` (drives LiToPreprocess `remove_bg`).
4. **Sampling steps** — NumericInput, min 5, max 100, step 1, precision 0, default 20.
5. **CFG scale** — NumericInput, min 1, max 10, step 0.5, precision 1, default 3.0.
6. **Seed** — NumericInput, min -1, max 2147483647, precision 0, default -1
   (label text: `Seed (-1 = random)`).
7. **Status row** — a Label, hidden when idle; the pipeline writes states into it (see UX below).
   Errors additionally set a CSS class that colors the text red (inline style is acceptable).
8. Footer buttons: **Generate**, **Close**.

Public API (promise-per-run does NOT fit here — the dialog stays open across a run; use a
callback contract instead):

```ts
interface LitoGenerateOptions {
    file: File;
    url: string;        // trimmed, no trailing slash
    removeBg: boolean;
    steps: number;
    cfg: number;
    seed: number;       // -1 = randomize at queue time
}
class LitoGenerateDialog extends Container {
    show(): void;                      // clears the status row when no run is active; other fields persist
    hide(): void;                      // USER-close path: fires onClosed
    hideSilent(): void;                // programmatic hide (import step): does NOT fire onClosed
    setBusy(busy: boolean): void;      // disables Generate + input rows while a run is active
    setStatus(text: string, isError?: boolean): void;   // shows/updates the status row ('' hides it)
    onGenerate: (opts: LitoGenerateOptions) => void;    // assigned by lito-generate.ts
    onClosed: () => void;                               // fired on Close/Escape/outside-click ONLY
}
```

Behavior details:
- Generate is disabled until an image is chosen, and while busy.
- Escape / outside-click behave like Close. Escape must call `e.stopPropagation()` before
  closing so the editor's own Escape shortcut (`tool.deactivate`, main.ts:84) doesn't also fire.
- **Enter routes through the exact same guard as the Generate button** (image chosen AND not
  busy → generate; otherwise no-op). Do NOT copy the spark dialog's unconditional
  `case 'Enter': finish(collect())` (spark-export-dialog.ts:211-213) — it bypasses the disabled
  state.
- Close while busy is allowed (see cancel semantics); the dialog hides, `onClosed` fires.
- All other keydown stops propagation (as spark dialog) so editor shortcuts don't fire.

### Pipeline (`src/lito-generate.ts`)

```ts
const registerLitoGenerate = (events: Events) => { ... }
```

- Lazily constructs the dialog on first use, appends to `#top-container` (fallback
  `document.body`) — same as `registerSparkExport`.
- `events.function('lito.generate', () => showDialog())`.
- On `onGenerate(opts)` runs the async pipeline below.

**One-run-at-a-time enforcement (three layers, all required):**
1. `onGenerate` is a no-op while a run is active (explicit `running` boolean in
   lito-generate.ts, independent of the dialog's button state).
2. Capture `const run = ++runCounter` at pipeline start and check `run === runCounter` after
   **every** await (upload, queue, each poll tick, import) before touching `setStatus`,
   `setBusy`, or `localStorage` — not just in the poll loop. A stale continuation (e.g. an
   import that outlives a user close) must never write into a newer run's UI.
3. The dialog disables Generate while busy AND guards the Enter key identically.

Pipeline steps (all fetches pass one `AbortController.signal` per run; note the import step is
NOT abortable — file-handler does its own fetching):

1. **Upload** — `POST {url}/upload/image`, `FormData` with `image` = the File and
   `overwrite` = `'false'`. Response JSON `{ name, subfolder, type }`. Use the returned `name`
   (ComfyUI may rename to avoid collisions). Status: `Uploading image…`.
2. **Queue** — `POST {url}/prompt` with JSON body `{ prompt, client_id: 'supersplat-lito' }`
   (`client_id` is REQUIRED — see Validated facts; omitting it breaks fully-cached re-runs).
   Every node in `prompt` uses the wire shape `{"class_type": "<Name>", "inputs": {...}}` with
   links encoded as `["<node id string>", <output index>]`, e.g.:

   ```json
   "1": {"class_type": "LiToLoadModel", "inputs": {"checkpoint": "lito_dit_rgba (recommended)", "compile": false, "precision": "auto"}}
   ```

   Full graph (shorthand below = class_type + inputs in the wire shape above; `seed` =
   opts.seed, or `Math.floor(Math.random() * 2147483647)` when opts.seed === -1):

   ```
   "1": LiToLoadModel   { checkpoint: "lito_dit_rgba (recommended)", compile: false, precision: "auto" }
   "2": LoadImage       { image: <uploaded name> }
   "3": LiToPreprocess  { image: ["2",0], remove_bg: opts.removeBg, crop: true, fill_ratio: 0.8, keep_optical_axis: true }
   "4": LiToImageTo3D   { model: ["1",0], image: ["3",0], mask: ["3",1], sampling_steps: opts.steps, cfg_scale: opts.cfg, sampling_method: "heun", seed: <resolved seed> }
   "5": LiToExportPLY   { gaussians: ["4",0], filename: <stem>_lito }
   "6": LiToPreviewPointCloud { file_path: ["5",0] }
   ```

   `<stem>` = image filename without extension, lowercased, characters outside `[a-z0-9_-]`
   replaced with `_`, truncated to 40 chars, fallback `image` if empty.
   Response `{ prompt_id }`; a response with an `error` field or non-2xx → fail with the
   error mapping below. On success, persist `opts.url` to `localStorage['lito.comfyUrl']`
   (this is the single persistence point). Status: `Queued…`.
3. **Poll** — `GET {url}/history/{prompt_id}` every 2 s. The response stays `{}` while the
   prompt is queued AND while it executes; `history[prompt_id]` appears only when the prompt
   finishes. Once it exists:
   - `status.completed === true` → proceed to import.
   - `status.status_str === 'error'` → find the `execution_error` entry in `status.messages`
     and surface `node_type` + `exception_message` (truncate to ~200 chars); if NO
     `execution_error` entry exists (e.g. only `execution_interrupted` — job cancelled from
     the ComfyUI side), surface `Generation was interrupted or failed on the ComfyUI side`.
   Status while polling: `Generating… (<elapsed>s)` updated every tick (the label covers queue
   wait too — acceptable v1 simplification, documented here). Hard timeout: 10 min including
   queue wait — set a `timedOut` flag BEFORE calling `abort()` so the abort classifier below
   can tell timeout from user-close.
4. **Import** — from `outputs`, take the first value with a `file_path` array; `basename` =
   text after the last `/` or `\`. Because the import path shows the editor's full-screen
   spinner and `#top-container` overlays stack vertically (see Validated facts), call
   `dialog.hideSilent()` FIRST (must not fire onClosed/abort), then:

   ```ts
   const models = await events.invoke('import', [{
       filename: basename,
       url: `${opts.url}/view?filename=${encodeURIComponent(basename)}&type=output&subfolder=`
   }]) as (unknown | undefined)[];
   ```

   `events.invoke('import')` NEVER rejects on a failed load — it resolves `[undefined]` and
   file-handler shows its own error popup. After the await (and a `run === runCounter` check),
   re-show the dialog and set the final status:
   - `models?.[0]` truthy → `Done — <basename> added to scene` (not busy; user can generate another).
   - otherwise → red `Import failed — see the editor error dialog`.

Cancel semantics: `onClosed` while busy → `AbortController.abort()`, stop the poll loop, reset
`running`/busy. No `/interrupt` call (non-goal; generation continues server-side). Error
classification order in the pipeline's catch — this exact order:
1. `e.name === 'AbortError'` (aborted fetch throws DOMException 'AbortError', NOT TypeError;
   an abort during the 2 s inter-poll sleep makes the NEXT fetch reject the same way):
   - `timedOut` set → show `Timed out after 10 min — check the ComfyUI console` (red).
   - otherwise (user closed the dialog) → silent; no status write.
2. `e instanceof TypeError` (network) →
   `Cannot reach ComfyUI at <url> — is it running with --enable-cors-header?`
3. anything else → generic `Generation failed: <message>`.

Error mapping for `/prompt` responses (status row, red):
- `error.type === 'missing_node_type'` (node_errors is EMPTY in this case — that field never
  names missing LiTo nodes) → `LiTo nodes missing — check ComfyUI-LiTo install`
- any other error body → `ComfyUI rejected the workflow: <error.message>`
- execution error (from step 3) → `Generation failed in <node_type>: <exception_message>`

### Menu (`src/ui/menu.ts`)

Insert into `fileMenuPanel` directly after the `menu.file.import` item:

```ts
{
    text: 'Generate from Image...',
    icon: createSvg(sceneImport),
    onSelect: () => events.invoke('lito.generate')
}
```

Plain string (custom fork items like `'Load FlexAvatar...'` / `'Spark Player...'` are not
localized — follow that).

### main.ts

`import { registerLitoGenerate } from './lito-generate';` and call
`registerLitoGenerate(events);` adjacent to `registerSparkExport(events, scene);`.

## Testing / gates

- `npx eslint <changed files>` clean (fork-wide lint has 614 pre-existing errors — file-scoped only).
- `npm run build` green.
- **Live E2E smoke (controller runs it, not a unit test):** ComfyUI already up at 8190. Playwright:
  open `localhost:3000`, invoke via `window.scene.events.invoke('lito.generate')` in page
  context (`window.scene` is exposed at main.ts:258; there is NO `window.events` global), set
  the file input with `ComfyUI/input/lamp.png` (LiTo sample asset), click Generate, wait ≤5 min
  for `Done —` status, verify a new element whose filename contains `lamp` exists in
  `scene.elements`, screenshot.
- Manual-check note: the status row must be readable against the dark dialog.

## Constraints

- Do NOT touch `public/spark-template/`, `src/spark-export.ts`, or serializer code — this
  feature is pure UI + HTTP + existing import path.
- No new npm dependencies.
- LiTo weights are Apple non-commercial research license — no license text needed in code, but
  the dialog header tooltip (title attribute) should read
  `LiTo (Apple Research) — model weights are non-commercial research use`.
- Commit style: `feat(lito): …` on `flexavatar-atlas-4d`; NEVER push to origin; backup push only
  on explicit request.
