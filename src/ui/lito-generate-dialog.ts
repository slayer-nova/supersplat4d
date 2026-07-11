import { BooleanInput, Button, Container, Label, NumericInput, TextInput } from '@playcanvas/pcui';

// Generate-from-Image (LiTo) options dialog: image picker, ComfyUI URL and sampling parameters.
// Shown by registerLitoGenerate (src/lito-generate.ts), which assigns onGenerate/onClosed and
// drives setBusy/setStatus/hideSilent while the pipeline runs. Unlike the spark export dialog
// this one stays open across a run, so it uses a callback contract instead of promise-per-show.
// Reuses the .settings-dialog overlay/dialog shell (see src/ui/scss/settings-dialog.scss).

interface LitoGenerateOptions {
    file: File;
    url: string;        // trimmed, no trailing slash
    removeBg: boolean;
    steps: number;
    cfg: number;
    seed: number;       // -1 = randomize at queue time
}

const DEFAULT_COMFY_URL = 'http://127.0.0.1:8190';

class LitoGenerateDialog extends Container {
    show: () => void;                                   // clears the status row when idle; other fields persist
    hide: () => void;                                   // USER-close path: fires onClosed
    hideSilent: () => void;                             // programmatic hide (import step): does NOT fire onClosed
    setBusy: (busy: boolean) => void;                   // disables Generate + input rows while a run is active
    setStatus: (text: string, isError?: boolean) => void;   // shows/updates the status row ('' hides it)
    onGenerate: (opts: LitoGenerateOptions) => void;    // assigned by lito-generate.ts
    onClosed: () => void;                               // fired on Close/Escape/outside-click ONLY

    constructor(args = {}) {
        super({
            ...args,
            id: 'lito-generate-dialog',
            class: 'settings-dialog',
            hidden: true,
            tabIndex: -1
        });

        const dialog = new Container({ id: 'dialog' });

        // header (title attribute carries the LiTo license note)
        const headerText = new Label({ id: 'text', text: 'GENERATE FROM IMAGE (LITO)' });
        const header = new Container({ id: 'header' });
        header.append(headerText);
        header.dom.title = 'LiTo (Apple Research) — model weights are non-commercial research use';

        // image picker: hidden file input, opened by the 'Choose image…' button
        const fileInput = document.createElement('input');
        fileInput.type = 'file';
        fileInput.accept = 'image/png,image/jpeg,image/webp';
        fileInput.style.display = 'none';

        const imageLabel = new Label({ class: 'label', text: 'Image' });
        const chooseButton = new Button({ class: 'button', text: 'Choose image…' });
        const filenameLabel = new Label({ class: 'label', text: 'no image selected' });
        filenameLabel.style.width = 'auto';
        filenameLabel.style.flexGrow = '1';
        filenameLabel.style.flexShrink = '1';
        filenameLabel.style.marginLeft = '8px';
        filenameLabel.style.overflow = 'hidden';
        filenameLabel.style.textOverflow = 'ellipsis';
        filenameLabel.style.whiteSpace = 'nowrap';
        filenameLabel.style.opacity = '0.7';
        const imageRow = new Container({ class: 'row' });
        imageRow.append(imageLabel);
        imageRow.append(chooseButton);
        imageRow.append(filenameLabel);
        imageRow.dom.appendChild(fileInput);

        // image preview (hidden until a file is chosen)
        const previewImg = document.createElement('img');
        previewImg.style.height = '96px';
        previewImg.style.maxWidth = '100%';
        previewImg.style.objectFit = 'contain';
        const previewRow = new Container({ class: 'row', hidden: true });
        previewRow.dom.appendChild(previewImg);

        // ComfyUI URL
        const urlLabel = new Label({ class: 'label', text: 'ComfyUI URL' });
        const urlInput = new TextInput({
            class: 'text-input',
            value: localStorage.getItem('lito.comfyUrl') || DEFAULT_COMFY_URL
        });
        const urlRow = new Container({ class: 'row' });
        urlRow.append(urlLabel);
        urlRow.append(urlInput);

        // remove background (drives LiToPreprocess remove_bg)
        const removeBgLabel = new Label({ class: 'label', text: 'Remove background' });
        const removeBgInput = new BooleanInput({ class: 'boolean-input', value: true });
        const removeBgRow = new Container({ class: 'row' });
        removeBgRow.append(removeBgLabel);
        removeBgRow.append(removeBgInput);

        // sampling steps
        const stepsLabel = new Label({ class: 'label', text: 'Sampling steps' });
        const stepsInput = new NumericInput({
            class: 'text-input', value: 20, min: 5, max: 100, precision: 0, step: 1
        });
        const stepsRow = new Container({ class: 'row' });
        stepsRow.append(stepsLabel);
        stepsRow.append(stepsInput);

        // CFG scale
        const cfgLabel = new Label({ class: 'label', text: 'CFG scale' });
        const cfgInput = new NumericInput({
            class: 'text-input', value: 3.0, min: 1, max: 10, precision: 1, step: 0.5
        });
        const cfgRow = new Container({ class: 'row' });
        cfgRow.append(cfgLabel);
        cfgRow.append(cfgInput);

        // seed
        const seedLabel = new Label({ class: 'label', text: 'Seed (-1 = random)' });
        const seedInput = new NumericInput({
            class: 'text-input', value: -1, min: -1, max: 2147483647, precision: 0, step: 1
        });
        const seedRow = new Container({ class: 'row' });
        seedRow.append(seedLabel);
        seedRow.append(seedInput);

        // status row (hidden when idle; the pipeline writes run states into it)
        const statusLabel = new Label({ class: 'label', text: '' });
        statusLabel.style.width = '100%';
        statusLabel.style.whiteSpace = 'normal';
        const statusRow = new Container({ class: 'row', hidden: true });
        statusRow.append(statusLabel);

        // content
        const content = new Container({ id: 'content' });
        content.append(imageRow);
        content.append(previewRow);
        content.append(urlRow);
        content.append(removeBgRow);
        content.append(stepsRow);
        content.append(cfgRow);
        content.append(seedRow);
        content.append(statusRow);

        // footer
        const generateButton = new Button({ class: 'button', text: 'Generate' });
        const closeButton = new Button({ class: 'button', text: 'Close' });
        const footer = new Container({ id: 'footer' });
        footer.append(generateButton);
        footer.append(closeButton);

        dialog.append(header);
        dialog.append(content);
        dialog.append(footer);
        this.append(dialog);

        // handlers

        let selectedFile: File | null = null;
        let objectUrl: string | null = null;
        let busy = false;

        const updateGenerate = () => {
            generateButton.enabled = !!selectedFile && !busy;
        };
        updateGenerate();

        chooseButton.on('click', () => {
            // clear so re-choosing the same file still fires 'change'
            fileInput.value = '';
            fileInput.click();
        });

        fileInput.addEventListener('change', () => {
            const file = fileInput.files?.[0];
            if (!file) return;
            selectedFile = file;
            filenameLabel.text = file.name;
            filenameLabel.style.opacity = '';
            // revoke the previous object URL ONLY when replaced by a new selection — the
            // selection persists across close/re-open, so at most one URL is ever live
            if (objectUrl) {
                URL.revokeObjectURL(objectUrl);
            }
            objectUrl = URL.createObjectURL(file);
            previewImg.src = objectUrl;
            previewRow.hidden = false;
            updateGenerate();
        });

        // same guard for the Generate button and the Enter key: dialog visible, image chosen
        // AND not busy — the hidden check stops any close-then-generate ordering (e.g. a keydown
        // that bubbles after a button handler already closed the dialog) from starting a run
        const tryGenerate = () => {
            if (this.hidden || !selectedFile || busy) return;
            this.onGenerate?.({
                file: selectedFile,
                url: urlInput.value.trim().replace(/\/+$/, ''),
                removeBg: !!removeBgInput.value,
                steps: stepsInput.value,
                cfg: cfgInput.value,
                seed: seedInput.value
            });
        };

        // user-close path (Close button / Escape / outside-click): hides and fires onClosed;
        // allowed while busy — the pipeline treats it as cancel
        const close = () => {
            this.hidden = true;
            this.onClosed?.();
        };

        generateButton.on('click', tryGenerate);
        closeButton.on('click', close);

        // click outside the dialog closes
        this.dom.addEventListener('click', (e: MouseEvent) => {
            if (e.target === this.dom) close();
        });

        this.dom.addEventListener('keydown', (e: KeyboardEvent) => {
            // keep editor shortcuts (e.g. Escape → tool.deactivate) from firing while the
            // dialog is up; for Escape this must happen BEFORE closing
            e.stopPropagation();
            switch (e.key) {
                case 'Escape':
                    close();
                    break;
                case 'Enter':
                    // Enter on a focused button: pcui Button's own keydown handler already
                    // emitted 'click' for it, so don't ALSO tryGenerate here (Close+Enter
                    // would otherwise close the dialog and then start a hidden run), and
                    // preventDefault so the browser's native button activation doesn't emit
                    // a SECOND 'click' (which would double-fire close/onClosed or generate)
                    if (e.target instanceof HTMLButtonElement) {
                        e.preventDefault();
                    } else {
                        tryGenerate();
                    }
                    break;
            }
        });

        // pcui Button._onClick blurs its element on EVERY click (mouse or Enter), dropping
        // focus to document.body — from there keydowns no longer pass through this overlay's
        // keydown listener and the editor's global shortcuts fire instead (src/shortcuts.ts
        // accepts body-targeted keys: Escape → tool.deactivate, Delete → select.delete, ...).
        // The spark dialog never hits this because all its buttons close it; here 'Choose
        // image…' and 'Generate' keep the dialog open, so reclaim focus whenever it escapes
        // the overlay while visible (this also covers the file-picker return path)
        this.dom.addEventListener('focusout', (e: FocusEvent) => {
            const next = e.relatedTarget as Node | null;
            if (this.hidden || (next && this.dom.contains(next))) return;
            if (next === null) {
                // programmatic blur (the pcui Button case): no competing focus target,
                // safe to reclaim synchronously
                this.dom.focus();
            } else {
                // focus is moving to an element OUTSIDE the overlay (e.g. Tab past the
                // last button): the browser focuses `next` after this event finishes,
                // so defer the reclaim and re-check
                setTimeout(() => {
                    if (!this.hidden && !this.dom.contains(document.activeElement)) {
                        this.dom.focus();
                    }
                }, 0);
            }
        });

        this.show = () => {
            // clear a stale final status from the previous run; while busy the status is live
            if (!busy) {
                this.setStatus('');
            }
            this.hidden = false;
            this.dom.focus();
        };

        this.hide = () => {
            close();
        };

        this.hideSilent = () => {
            this.hidden = true;
        };

        this.setBusy = (value: boolean) => {
            busy = value;
            chooseButton.enabled = !value;
            urlInput.enabled = !value;
            removeBgInput.enabled = !value;
            stepsInput.enabled = !value;
            cfgInput.enabled = !value;
            seedInput.enabled = !value;
            updateGenerate();
        };

        this.setStatus = (text: string, isError = false) => {
            statusLabel.text = text;
            statusLabel.style.color = isError ? '#ff6a6a' : '';
            statusRow.hidden = text === '';
        };
    }
}

export { LitoGenerateDialog };
export type { LitoGenerateOptions };
