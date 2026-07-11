import { BooleanInput, Button, Container, Label, NumericInput, SelectInput } from '@playcanvas/pcui';

// Spark player export options dialog: camera-path playback mode, entrance (reveal) effect and
// duration. Shown by sparkExport (src/spark-export.ts) BEFORE encoding starts; the choices land in
// the package's manifest.player block, which the player template resolves with precedence
// URL param > manifest.player > built-in default (spread / 4.5 s / autoplay).
// Reuses the .settings-dialog overlay/dialog shell (see src/ui/scss/settings-dialog.scss).

type SparkCameraMode = 'auto' | 'manual' | 'off';
type SparkRevealEffect = 'spread' | 'magic' | 'unroll' | 'twister' | 'rain' | 'off';

interface SparkExportOptions {
    cameraMode: SparkCameraMode;
    revealEffect: SparkRevealEffect;
    revealSec: number;
    watermark: boolean;
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

        // content
        const content = new Container({ id: 'content' });
        content.append(cameraRow);
        content.append(cameraHintRow);
        content.append(effectRow);
        content.append(durationRow);
        content.append(watermarkRow);

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

        const finish = (value: SparkExportOptions | null) => {
            this.hidden = true;
            resolvePromise?.(value);
            resolvePromise = null;
        };

        const collect = (): SparkExportOptions => ({
            // when the select is disabled (<2 poses) it was reset to 'off' = Don't include
            cameraMode: cameraSelect.value as SparkCameraMode,
            revealEffect: effectSelect.value as SparkRevealEffect,
            revealSec: durationInput.value,
            watermark: !!watermarkInput.value
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
