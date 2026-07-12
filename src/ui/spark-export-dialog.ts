import { BooleanInput, Button, Container, Label, NumericInput, SelectInput } from '@playcanvas/pcui';

// Spark player export options dialog: camera-path playback mode, entrance (reveal) effect and
// duration. Shown by sparkExport (src/spark-export.ts) BEFORE encoding starts; the choices land in
// the package's manifest.player block, which the player template resolves with precedence
// URL param > manifest.player > built-in default (spread / 4.5 s / autoplay).
// Reuses the .settings-dialog overlay/dialog shell (see src/ui/scss/settings-dialog.scss).

type SparkCameraMode = 'auto' | 'manual' | 'off';
type SparkRevealEffect = 'spread' | 'magic' | 'unroll' | 'twister' | 'rain' | 'off';
type SparkKeepSh = 'off' | 'lito' | 'all';
type SparkZoomMode = 'adaptive' | 'manual' | 'default';

interface SparkExportOptions {
    cameraMode: SparkCameraMode;
    revealEffect: SparkRevealEffect;
    keepSh: SparkKeepSh;
    revealSec: number;
    watermark: boolean;
    zoomMode: SparkZoomMode;
    zoomMin: number;
    zoomMax: number;
    offline: boolean;
    arLight: boolean;
}

class SparkExportDialog extends Container {
    show: (hasCameraPath: boolean) => Promise<SparkExportOptions | null>;
    hide: () => void;
    destroy: () => void;

    constructor(args = {}) {
        super({
            ...args,
            id: 'spark-export-dialog',
            class: 'settings-dialog',
            hidden: true,
            tabIndex: -1
        });

        const dialog = new Container({ id: 'dialog' });

        // header
        const headerText = new Label({ id: 'text', text: 'SPARK PLAYER EXPORT' });
        const header = new Container({ id: 'header' });
        header.append(headerText);

        // camera path
        const cameraLabel = new Label({ class: 'label', text: 'Camera path' });
        const cameraSelect = new SelectInput({
            class: 'select',
            defaultValue: 'auto',
            options: [
                { v: 'auto', t: 'Autoplay' },
                { v: 'manual', t: 'Manual (🎥 button)' },
                { v: 'off', t: 'Don\'t include' }
            ]
        });
        const cameraRow = new Container({ class: 'row' });
        cameraRow.append(cameraLabel);
        cameraRow.append(cameraSelect);

        // hint shown when the timeline carries fewer than 2 camera poses
        const cameraHint = new Label({ class: 'label', text: '(no camera poses on the timeline)' });
        cameraHint.style.width = '100%';
        cameraHint.style.fontStyle = 'italic';
        cameraHint.style.opacity = '0.7';
        const cameraHintRow = new Container({ class: 'row' });
        cameraHintRow.append(cameraHint);

        // entrance effect
        const effectLabel = new Label({ class: 'label', text: 'Entrance effect' });
        const effectSelect = new SelectInput({
            class: 'select',
            defaultValue: 'spread',
            options: [
                { v: 'spread', t: 'Spread' },
                { v: 'magic', t: 'Magic' },
                { v: 'unroll', t: 'Unroll' },
                { v: 'twister', t: 'Twister' },
                { v: 'rain', t: 'Rain' },
                { v: 'off', t: 'None' }
            ]
        });
        const effectRow = new Container({ class: 'row' });
        effectRow.append(effectLabel);
        effectRow.append(effectSelect);

        // keep view-dependent SH color on statics that carry f_rest_* props (LiTo objects);
        // Off = every static ships compact SH0 (the pre-feature behavior)
        const keepShLabel = new Label({ class: 'label', text: 'Keep SH (view-dep. color)' });
        const keepShSelect = new SelectInput({
            class: 'select',
            defaultValue: 'lito',
            options: [
                { v: 'off', t: 'Off (smallest files)' },
                { v: 'lito', t: 'LiTo objects only' },
                { v: 'all', t: 'All statics that have SH' }
            ]
        });
        const keepShRow = new Container({ class: 'row' });
        keepShRow.append(keepShLabel);
        keepShRow.append(keepShSelect);

        // effect duration
        const durationLabel = new Label({ class: 'label', text: 'Duration (s)' });
        const durationInput = new NumericInput({
            class: 'text-input',
            value: 4.5,
            min: 0.5,
            max: 20,
            precision: 1,
            step: 0.5
        });
        const durationRow = new Container({ class: 'row' });
        durationRow.append(durationLabel);
        durationRow.append(durationInput);

        // 3D splat watermark ("Shooting Lab" text splats inside the scene — visible in VR)
        const watermarkLabel = new Label({ class: 'label', text: '3D watermark' });
        const watermarkInput = new BooleanInput({ class: 'boolean-input', value: true });
        const watermarkRow = new Container({ class: 'row' });
        watermarkRow.append(watermarkLabel);
        watermarkRow.append(watermarkInput);

        // orbit zoom limits: adaptive (scene-radius-derived), manual min/max, or the historical
        // fixed head clamp (0.4–2.0, pan off) — the right pick for a single close-up head
        const zoomLabel = new Label({ class: 'label', text: 'Camera zoom' });
        const zoomSelect = new SelectInput({
            class: 'select',
            defaultValue: 'adaptive',
            options: [
                { v: 'adaptive', t: 'Adaptive (scene size)' },
                { v: 'manual', t: 'Manual (min/max)' },
                { v: 'default', t: 'Head default (0.4–2)' }
            ]
        });
        const zoomRow = new Container({ class: 'row' });
        zoomRow.append(zoomLabel);
        zoomRow.append(zoomSelect);

        const zoomMinLabel = new Label({ class: 'label', text: 'Zoom min / max' });
        const zoomMinInput = new NumericInput({
            class: 'text-input', value: 0.1, min: 0.01, max: 100, precision: 2, step: 0.1
        });
        const zoomMaxInput = new NumericInput({
            class: 'text-input', value: 10, min: 0.02, max: 200, precision: 2, step: 0.5
        });
        const zoomRangeRow = new Container({ class: 'row', hidden: true });
        zoomRangeRow.append(zoomMinLabel);
        zoomRangeRow.append(zoomMinInput);
        zoomRangeRow.append(zoomMaxInput);

        // offline cache: package service worker — heavy frames/vendor cache per device after the
        // first visit (repeat views on customer phones don't re-download); shell stays network-first
        const offlineLabel = new Label({ class: 'label', text: 'Offline cache (SW)' });
        const offlineInput = new BooleanInput({ class: 'boolean-input', value: true });
        const offlineRow = new Container({ class: 'row' });
        offlineRow.append(offlineLabel);
        offlineRow.append(offlineInput);

        // AR environment lighting: in AR the player estimates the real room's light per frame
        // (Android ARCore light-estimation) and grades every splat to match — brightness, color
        // temperature, plus a directional accent. Unsupported devices (Quest/desktop) silently no-op.
        const arLightLabel = new Label({ class: 'label', text: 'AR environment lighting' });
        const arLightInput = new BooleanInput({ class: 'boolean-input', value: true });
        const arLightRow = new Container({ class: 'row' });
        arLightRow.append(arLightLabel);
        arLightRow.append(arLightInput);

        // content
        const content = new Container({ id: 'content' });
        content.append(cameraRow);
        content.append(cameraHintRow);
        content.append(effectRow);
        content.append(keepShRow);
        content.append(durationRow);
        content.append(watermarkRow);
        content.append(zoomRow);
        content.append(zoomRangeRow);
        content.append(offlineRow);
        content.append(arLightRow);

        // footer
        const cancelButton = new Button({ class: 'button', text: 'Cancel' });
        const exportButton = new Button({ class: 'button', text: 'Export' });
        const footer = new Container({ id: 'footer' });
        footer.append(cancelButton);
        footer.append(exportButton);

        dialog.append(header);
        dialog.append(content);
        dialog.append(footer);
        this.append(dialog);

        // handlers

        let resolvePromise: ((value: SparkExportOptions | null) => void) | null = null;

        // duration is meaningless without an effect
        effectSelect.on('change', (value: string) => {
            durationInput.enabled = value !== 'off';
        });

        // the min/max row only applies to manual zoom
        zoomSelect.on('change', (value: string) => {
            zoomRangeRow.hidden = value !== 'manual';
        });

        const finish = (value: SparkExportOptions | null) => {
            this.hidden = true;
            resolvePromise?.(value);
            resolvePromise = null;
        };

        const collect = (): SparkExportOptions => ({
            // when the select is disabled (<2 poses) it was reset to 'off' = Don't include
            cameraMode: cameraSelect.value as SparkCameraMode,
            revealEffect: effectSelect.value as SparkRevealEffect,
            keepSh: keepShSelect.value as SparkKeepSh,
            revealSec: durationInput.value,
            watermark: !!watermarkInput.value,
            zoomMode: zoomSelect.value as SparkZoomMode,
            zoomMin: Math.min(zoomMinInput.value, zoomMaxInput.value),
            zoomMax: Math.max(zoomMinInput.value, zoomMaxInput.value),
            offline: !!offlineInput.value,
            arLight: !!arLightInput.value
        });

        exportButton.on('click', () => finish(collect()));
        cancelButton.on('click', () => finish(null));

        // click outside the dialog cancels
        this.dom.addEventListener('click', (e: MouseEvent) => {
            if (e.target === this.dom) finish(null);
        });

        this.dom.addEventListener('keydown', (e: KeyboardEvent) => {
            switch (e.key) {
                case 'Escape':
                    finish(null);
                    break;
                case 'Enter':
                    finish(collect());
                    break;
                default:
                    // keep editor shortcuts from firing while the dialog is up
                    e.stopPropagation();
                    break;
            }
        });

        this.show = (hasCameraPath: boolean) => {
            return new Promise<SparkExportOptions | null>((resolve) => {
                resolvePromise = resolve;

                // reset to defaults each time
                cameraSelect.value = hasCameraPath ? 'auto' : 'off';
                cameraSelect.enabled = hasCameraPath;
                cameraHintRow.hidden = hasCameraPath;
                effectSelect.value = 'spread';
                keepShSelect.value = 'lito';
                durationInput.value = 4.5;
                durationInput.enabled = true;

                this.hidden = false;
                this.dom.focus();
            });
        };

        this.hide = () => {
            finish(null);
        };

        this.destroy = () => {
            this.hide();
            super.destroy();
        };
    }
}

export { SparkExportDialog };
export type { SparkExportOptions };
