import { Events } from './events';
import { LitoGenerateDialog, type LitoGenerateOptions } from './ui/lito-generate-dialog';

// "Generate from Image (LiTo)" — drive the local ComfyUI-LiTo pipeline over HTTP: upload the
// chosen image, queue the LiTo graph, poll history until the PLY is written, then import it into
// the scene via the editor's own import path. See
// docs/superpowers/specs/2026-07-12-lito-generate-from-image-design.md.

const CLIENT_ID = 'supersplat-lito';
const STORAGE_KEY = 'lito.comfyUrl';
const POLL_INTERVAL_MS = 2000;
const TIMEOUT_MS = 10 * 60 * 1000;   // hard cap, includes ComfyUI queue wait

const sleep = (ms: number) => new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
});

// image filename -> PLY filename stem: no extension, lowercased, [a-z0-9_-] only, max 40 chars
const fileStem = (name: string) => {
    const stem = name.replace(/\.[^.]*$/, '').toLowerCase().replace(/[^a-z0-9_-]/g, '_').slice(0, 40);
    return stem || 'image';
};

// history status.messages entries are [type, data] pairs
const findMessage = (entry: any, type: string): any => {
    const messages = entry?.status?.messages;
    if (!Array.isArray(messages)) return null;
    const found = messages.find((m: any) => Array.isArray(m) && m[0] === type);
    return found ? found[1] : null;
};

const registerLitoGenerate = (events: Events) => {
    // one-run-at-a-time, layer 1: onGenerate is a no-op while a run is active (independent of
    // the dialog's own button state)
    let running = false;

    // layer 2: each run captures ++runCounter and re-checks it after EVERY await before touching
    // the dialog or localStorage; onClosed-while-busy bumps the counter so stale continuations
    // (e.g. the non-abortable import outliving a user close) never write into the UI
    let runCounter = 0;

    let activeController: AbortController | null = null;

    const runPipeline = async (dialog: LitoGenerateDialog, opts: LitoGenerateOptions) => {
        if (running) return;
        running = true;
        const run = ++runCounter;
        const controller = new AbortController();
        activeController = controller;
        const { signal } = controller;
        let timedOut = false;
        const startTime = Date.now();

        dialog.setBusy(true);

        try {
            // 1. upload the image (ComfyUI may rename to avoid collisions — use the returned name)
            dialog.setStatus('Uploading image…');
            const formData = new FormData();
            formData.append('image', opts.file);
            formData.append('overwrite', 'false');
            const uploadRes = await fetch(`${opts.url}/upload/image`, { method: 'POST', body: formData, signal });
            if (run !== runCounter) return;
            if (!uploadRes.ok) {
                throw new Error(`image upload failed (HTTP ${uploadRes.status})`);
            }
            const uploadJson = await uploadRes.json();
            if (run !== runCounter) return;
            const uploadedName = uploadJson.name as string;

            // 2. queue the LiTo graph. client_id is REQUIRED: without it ComfyUI does not replay
            // fully-cached output-node results into history outputs (same image + fixed seed =
            // cached run = empty outputs). LiToPreviewPointCloud must terminate the graph —
            // LiToExportPLY is not an output node and a graph ending there is rejected.
            const seed = opts.seed === -1 ? Math.floor(Math.random() * 2147483647) : opts.seed;
            const prompt = {
                1: { class_type: 'LiToLoadModel', inputs: { checkpoint: 'lito_dit_rgba (recommended)', compile: false, precision: 'auto' } },
                2: { class_type: 'LoadImage', inputs: { image: uploadedName } },
                3: { class_type: 'LiToPreprocess', inputs: { image: ['2', 0], remove_bg: opts.removeBg, crop: true, fill_ratio: 0.8, keep_optical_axis: true } },
                4: { class_type: 'LiToImageTo3D', inputs: { model: ['1', 0], image: ['3', 0], mask: ['3', 1], sampling_steps: opts.steps, cfg_scale: opts.cfg, sampling_method: 'heun', seed } },
                5: { class_type: 'LiToExportPLY', inputs: { gaussians: ['4', 0], filename: `${fileStem(opts.file.name)}_lito` } },
                6: { class_type: 'LiToPreviewPointCloud', inputs: { file_path: ['5', 0] } }
            };
            const queueRes = await fetch(`${opts.url}/prompt`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ prompt, client_id: CLIENT_ID }),
                signal
            });
            if (run !== runCounter) return;
            let queueJson: any = null;
            try {
                queueJson = await queueRes.json();
            } catch { /* non-JSON error body — fall back to the HTTP status below */ }
            if (run !== runCounter) return;
            if (!queueRes.ok || queueJson?.error) {
                // missing_node_type comes back with EMPTY node_errors — it is the
                // missing-ComfyUI-LiTo-install signature
                if (queueJson?.error?.type === 'missing_node_type') {
                    dialog.setStatus('LiTo nodes missing — check ComfyUI-LiTo install', true);
                } else {
                    dialog.setStatus(`ComfyUI rejected the workflow: ${queueJson?.error?.message ?? `HTTP ${queueRes.status}`}`, true);
                }
                return;
            }
            const promptId = queueJson.prompt_id as string;

            // single persistence point: a reachable, LiTo-capable server is worth remembering
            // even if the generation later fails
            localStorage.setItem(STORAGE_KEY, opts.url);
            dialog.setStatus('Queued…');

            // 3. poll history. The response stays {} while the prompt is queued AND while it
            // executes; the entry appears only when the prompt finishes (success or error).
            let entry: any = null;
            for (;;) {
                await sleep(POLL_INTERVAL_MS);
                if (run !== runCounter) return;
                if (Date.now() - startTime > TIMEOUT_MS) {
                    // flag BEFORE abort so the AbortError classifier below can tell timeout
                    // from user-close
                    timedOut = true;
                    controller.abort();
                    throw new DOMException('LiTo generation timed out', 'AbortError');
                }
                const historyRes = await fetch(`${opts.url}/history/${promptId}`, { signal });
                if (run !== runCounter) return;
                const history = await historyRes.json();
                if (run !== runCounter) return;
                entry = history?.[promptId];
                if (!entry) {
                    // the label covers queue wait too — acceptable v1 simplification
                    dialog.setStatus(`Generating… (${Math.round((Date.now() - startTime) / 1000)}s)`);
                    continue;
                }
                if (entry.status?.completed === true) {
                    break;
                }
                if (entry.status?.status_str === 'error') {
                    const err = findMessage(entry, 'execution_error');
                    if (err) {
                        dialog.setStatus(`Generation failed in ${err.node_type}: ${String(err.exception_message ?? '').slice(0, 200)}`, true);
                    } else {
                        // e.g. only execution_interrupted — job cancelled from the ComfyUI side
                        dialog.setStatus('Generation was interrupted or failed on the ComfyUI side', true);
                    }
                    return;
                }
            }

            // 4. import: outputs values carry an ABSOLUTE disk path — take the basename and
            // fetch the bytes back through ComfyUI's /view endpoint
            let filePath = '';
            for (const value of Object.values(entry.outputs ?? {}) as any[]) {
                if (Array.isArray(value?.file_path) && value.file_path.length > 0) {
                    filePath = String(value.file_path[0]);
                    break;
                }
            }
            if (!filePath) {
                dialog.setStatus('Generation finished but ComfyUI returned no PLY path', true);
                return;
            }
            const basename = filePath.split(/[\\/]/).pop() || filePath;

            // the import path shows the editor's full-screen spinner and #top-container overlays
            // stack VERTICALLY — hide the dialog first (programmatic: must not fire onClosed)
            dialog.hideSilent();
            // events.invoke('import') NEVER rejects on a failed load — file-handler shows its own
            // error popup and resolves [undefined]; success = first element truthy
            const models = await events.invoke('import', [{
                filename: basename,
                url: `${opts.url}/view?filename=${encodeURIComponent(basename)}&type=output&subfolder=`
            }]) as unknown[];
            if (run !== runCounter) return;
            dialog.show();
            if (models?.[0]) {
                dialog.setStatus(`Done — ${basename} added to scene`);
            } else {
                dialog.setStatus('Import failed — see the editor error dialog', true);
            }
        } catch (e: any) {
            if (run !== runCounter) return;
            // classification order matters: aborted fetches throw DOMException 'AbortError'
            // (NOT TypeError; an abort during the inter-poll sleep rejects the NEXT fetch the
            // same way), then TypeError = network, then everything else
            if (e?.name === 'AbortError') {
                if (timedOut) {
                    dialog.setStatus('Timed out after 10 min — check the ComfyUI console', true);
                }
                // otherwise the user closed the dialog — stay silent
            } else if (e instanceof TypeError) {
                dialog.setStatus(`Cannot reach ComfyUI at ${opts.url} — is it running with --enable-cors-header?`, true);
            } else {
                dialog.setStatus(`Generation failed: ${e?.message ?? e}`, true);
            }
        } finally {
            if (run === runCounter) {
                running = false;
                dialog.setBusy(false);
                activeController = null;
            }
        }
    };

    // options dialog, created on first use (self-attached: editor.ts stays untouched)
    let dialog: LitoGenerateDialog | null = null;
    const showDialog = () => {
        if (!dialog) {
            const dlg = new LitoGenerateDialog();
            (document.getElementById('top-container') ?? document.body).appendChild(dlg.dom);
            dlg.onGenerate = (opts) => {
                runPipeline(dlg, opts).catch(() => { /* pipeline handles its own errors */ });
            };
            dlg.onClosed = () => {
                // cancel semantics: close-while-busy aborts the editor-side run (polling stops,
                // ComfyUI finishes server-side — no /interrupt in v1). Bump runCounter so any
                // in-flight continuation of the old run goes stale.
                if (!running) return;
                runCounter++;
                running = false;
                dlg.setBusy(false);
                activeController?.abort();
                activeController = null;
            };
            dialog = dlg;
        }
        dialog.show();
    };

    events.function('lito.generate', () => showDialog());
};

export { registerLitoGenerate };
