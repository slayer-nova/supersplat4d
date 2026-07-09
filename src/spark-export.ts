import { GSplatData } from 'playcanvas';
import { serializeSpz } from 'spz-js';

import { ElementType } from './element';
import { Events } from './events';
import { Scene } from './scene';

// "Export Spark Player" — package the scene's primary atlas avatar as a self-contained, offline,
// progressive-loading Spark (Luma) 3DGS player and download it as a .zip. See spark-player/DESIGN.md.
//
// The heavy atlas decode already happened at load (splat.atlasFrames: GSplatData[]); export just
// re-encodes each frame to .spz (spz-js) and bundles it with the player template + vendored libs.

// JSZip is loaded globally via a script tag in index.html (same as the sog4d loader uses).
declare const JSZip: any;

const HEAD_FRAMES = 12; // first K frames shipped individually (instant start); the rest go in rest.zip
const VENDOR = ['three.module.js', 'three.core.js', 'OrbitControls.js', 'VRButton.js', 'ARButton.js', 'Pass.js', 'spark.module.js', 'jszip.esm.js'];
const TEMPLATE_BASE = './spark-template/';

const pad4 = (i: number) => String(i).padStart(4, '0');

// GSplatData -> spz-js GaussianCloud. deserializeFromSSplat (loaders/splat.ts) already stores the
// PLY-native conventions spz-js expects: scale_*=LOG, f_dc_*=SH-DC, opacity=LOGIT, rot_*=(w,x,y,z).
// So this is a direct field copy; the only transform is reordering the quaternion to [x,y,z,w] and
// normalizing it.
const gsplatToSpz = (gd: GSplatData): Promise<Uint8Array> => {
    const n = gd.numSplats;
    const P = (name: string) => gd.getProp(name) as unknown as Float32Array;
    const x = P('x'), y = P('y'), z = P('z');
    const s0 = P('scale_0'), s1 = P('scale_1'), s2 = P('scale_2');
    const f0 = P('f_dc_0'), f1 = P('f_dc_1'), f2 = P('f_dc_2');
    const op = P('opacity');
    const r0 = P('rot_0'), r1 = P('rot_1'), r2 = P('rot_2'), r3 = P('rot_3'); // w, x, y, z

    const positions = new Float32Array(n * 3);
    const scales = new Float32Array(n * 3);
    const colors = new Float32Array(n * 3);
    const alphas = new Float32Array(n);
    const rotations = new Float32Array(n * 4);
    for (let i = 0; i < n; i++) {
        positions[i * 3] = x[i]; positions[i * 3 + 1] = y[i]; positions[i * 3 + 2] = z[i];
        scales[i * 3] = s0[i]; scales[i * 3 + 1] = s1[i]; scales[i * 3 + 2] = s2[i];
        colors[i * 3] = f0[i]; colors[i * 3 + 1] = f1[i]; colors[i * 3 + 2] = f2[i];
        alphas[i] = op[i];
        const w = r0[i], qx = r1[i], qy = r2[i], qz = r3[i];
        const l = Math.hypot(w, qx, qy, qz) || 1;
        rotations[i * 4] = qx / l; rotations[i * 4 + 1] = qy / l; rotations[i * 4 + 2] = qz / l; rotations[i * 4 + 3] = w / l;
    }
    return serializeSpz({ numPoints: n, shDegree: 0, positions, scales, rotations, alphas, colors, sh: new Float32Array(0) } as any);
};

const registerSparkExport = (events: Events, scene: Scene) => {
    events.function('sparkExport', async () => {
        // target = the selected atlas, else the first atlas in the scene
        const splats = scene.getElementsByType(ElementType.splat) as any[];
        const selected = events.invoke('selection') as any;
        const atlas = (selected && selected.isAtlas) ? selected : splats.find(s => s.isAtlas);
        if (!atlas || !atlas.atlasFrames || atlas.atlasFrames.length === 0) {
            await events.invoke('showPopup', {
                type: 'info',
                header: 'SPARK PLAYER EXPORT',
                message: 'Load a FlexAvatar (atlas) avatar first — the Spark player exports its animated frames.'
            });
            return;
        }

        const frames: GSplatData[] = atlas.atlasFrames;
        const fps = atlas.atlasFps || 30;
        const name = String(atlas.name || 'avatar').replace(/\.[^.]+$/, '').replace(/[^\w.-]+/g, '_');
        const head = Math.min(HEAD_FRAMES, frames.length);

        events.fire('progressStart', `Exporting Spark player: ${name}`);
        try {
            // 1. fetch the player template + vendored libs (served under ./spark-template/)
            const index = await fetch(`${TEMPLATE_BASE}index.html`).then(r => r.text());
            const player = await fetch(`${TEMPLATE_BASE}player.js`).then(r => r.text());
            const vendor = await Promise.all(VENDOR.map(v => fetch(`${TEMPLATE_BASE}vendor/${v}`).then(r => r.arrayBuffer())));

            const zip = new JSZip();
            zip.file('index.html', index);
            zip.file('player.js', player);
            VENDOR.forEach((v, i) => zip.file(`vendor/${v}`, vendor[i]));

            // 2. encode every frame -> .spz; HEAD individual (instant start), TAIL into rest.zip
            const restZip = new JSZip();
            for (let i = 0; i < frames.length; i++) {
                const spz = await gsplatToSpz(frames[i]);
                const fn = `frame_${pad4(i)}.spz`;
                if (i < head) zip.file(`frames/${fn}`, spz);
                else restZip.file(fn, spz);
                events.fire('progressUpdate', { text: 'Encoding frames', progress: Math.round((i + 1) / frames.length * 92) });
                if ((i & 3) === 0) await new Promise(r => setTimeout(r)); // yield so the bar repaints
            }
            if (frames.length > head) {
                const restBytes = await restZip.generateAsync({ type: 'uint8array', compression: 'STORE' });
                zip.file('rest.zip', restBytes);
            }

            // 3. audio (optional; a silent bake has no audioUrl)
            let audioName: string | null = null;
            if (atlas.audioUrl) {
                try {
                    const a = await fetch(atlas.audioUrl).then(r => r.arrayBuffer());
                    audioName = 'audio.m4a';
                    zip.file(audioName, a);
                } catch (e) {
                    console.warn('spark export: audio fetch failed, packaging without audio', e);
                }
            }

            // 4. manifest
            zip.file('manifest.json', JSON.stringify({
                name, frames: frames.length, fps, audio: audioName, format: 'spz', headCount: head
            }));

            // 5. generate + download
            events.fire('progressUpdate', { text: 'Packaging', progress: 96 });
            const blob = await zip.generateAsync({ type: 'blob', compression: 'DEFLATE' });
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = `${name}-spark.zip`;
            document.body.appendChild(a);
            a.click();
            a.remove();
            setTimeout(() => URL.revokeObjectURL(url), 2000);
        } catch (e: any) {
            await events.invoke('showPopup', {
                type: 'error',
                header: 'SPARK PLAYER EXPORT FAILED',
                message: `${e?.message ?? e}`
            });
        } finally {
            events.fire('progressEnd');
        }
    });
};

export { registerSparkExport };
