import { GSplatData, Mat4, Quat, Vec3 } from 'playcanvas';
import { serializeSpz } from 'spz-js';

import { ElementType } from './element';
import { Events } from './events';
import { Scene } from './scene';
import { SingleSplat } from './splat-serialize';
import { State } from './splat-state';

// "Export Spark Player" — package the WHOLE scene (every visible static splat + every FlexAvatar
// atlas avatar, editor transforms baked in) as a self-contained, offline, progressive-loading Spark
// (Luma) 3DGS player and download it as a .zip (manifest v2). See spark-player/DESIGN.md.
//
// The heavy atlas decode already happened at load (splat.atlasFrames: GSplatData[]); export just
// re-encodes each frame to .spz (spz-js) and bundles everything with the player template + vendored
// libs. sog4d DYNAMIC nodes are skipped in v1 (warning popup names them).

// JSZip is loaded globally via a script tag in index.html (same as the sog4d loader uses).
declare const JSZip: any;

const HEAD_FRAMES = 12; // first K frames shipped individually (instant start); the rest go in rest.zip
const VENDOR = ['three.module.js', 'three.core.js', 'OrbitControls.js', 'VRButton.js', 'ARButton.js', 'Pass.js', 'spark.module.js', 'jszip.esm.js'];
const TEMPLATE_BASE = './spark-template/';

const pad4 = (i: number) => String(i).padStart(4, '0');

const sanitize = (name: any) => String(name || 'object').replace(/\.[^.]+$/, '').replace(/[^\w.-]+/g, '_');

// entity world transform to bake into the gaussian data (constant per object)
type Bake = { mat: Mat4, rot: Quat, scale: Vec3 };

const isIdentityMat = (m: Mat4): boolean => {
    const a = m.data;
    const b = Mat4.IDENTITY.data;
    for (let i = 0; i < 16; i++) {
        if (Math.abs(a[i] - b[i]) > 1e-6) return false;
    }
    return true;
};

const bakeV = new Vec3();
const bakeQ = new Quat();

// GSplatData -> spz-js GaussianCloud. deserializeFromSSplat (loaders/splat.ts) already stores the
// PLY-native conventions spz-js expects: scale_*=LOG, f_dc_*=SH-DC, opacity=LOGIT, rot_*=(w,x,y,z).
// So this is a direct field copy; the only transforms are the optional world-transform bake and
// reordering the quaternion to [x,y,z,w] and normalizing it. bake=null is the identity fast path
// (byte-identical with the historical avatar-only export).
const gsplatToSpz = (gd: GSplatData, bake: Bake | null = null): Promise<Uint8Array> => {
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
        let px = x[i], py = y[i], pz = z[i];
        let sx = s0[i], sy = s1[i], sz = s2[i];
        let w = r0[i], qx = r1[i], qy = r2[i], qz = r3[i];
        if (bake) {
            bakeV.set(px, py, pz);
            bake.mat.transformPoint(bakeV, bakeV);
            px = bakeV.x; py = bakeV.y; pz = bakeV.z;
            bakeQ.set(qx, qy, qz, w).mul2(bake.rot, bakeQ);
            qx = bakeQ.x; qy = bakeQ.y; qz = bakeQ.z; w = bakeQ.w;
            sx = Math.log(Math.exp(sx) * bake.scale.x);
            sy = Math.log(Math.exp(sy) * bake.scale.y);
            sz = Math.log(Math.exp(sz) * bake.scale.z);
        }
        positions[i * 3] = px; positions[i * 3 + 1] = py; positions[i * 3 + 2] = pz;
        scales[i * 3] = sx; scales[i * 3 + 1] = sy; scales[i * 3 + 2] = sz;
        colors[i * 3] = f0[i]; colors[i * 3 + 1] = f1[i]; colors[i * 3 + 2] = f2[i];
        alphas[i] = op[i];
        const l = Math.hypot(w, qx, qy, qz) || 1;
        rotations[i * 4] = qx / l; rotations[i * 4 + 1] = qy / l; rotations[i * 4 + 2] = qz / l; rotations[i * 4 + 3] = w / l;
    }
    return serializeSpz({ numPoints: n, shDegree: 0, positions, scales, rotations, alphas, colors, sh: new Float32Array(0) } as any);
};

const MEMBERS = ['x', 'y', 'z', 'rot_0', 'rot_1', 'rot_2', 'rot_3', 'scale_0', 'scale_1', 'scale_2', 'f_dc_0', 'f_dc_1', 'f_dc_2', 'opacity'];

// static splat -> ONE spz via the serializer's SingleSplat iterator so palette edits, color tints
// and data conventions are inherited, not reimplemented. bakeFullWorldTransform bakes the pure
// editor-world frame (see splat-serialize.ts). deleted gaussians are filtered.
const staticToSpz = async (splat: any): Promise<{ spz: Uint8Array, n: number }> => {
    const state = splat.splatData.getProp('state') as Uint8Array | undefined;
    const total = splat.splatData.numSplats;
    const single = new SingleSplat(MEMBERS, { bakeFullWorldTransform: true });
    let n = 0;
    for (let i = 0; i < total; i++) {
        if (!state || (state[i] & State.deleted) === 0) n++;
    }
    const positions = new Float32Array(n * 3);
    const scales = new Float32Array(n * 3);
    const colors = new Float32Array(n * 3);
    const alphas = new Float32Array(n);
    const rotations = new Float32Array(n * 4);
    let k = 0;
    for (let i = 0; i < total; i++) {
        if (state && (state[i] & State.deleted) !== 0) continue;
        single.read(splat, i);
        const d = single.data;
        positions[k * 3] = d.x; positions[k * 3 + 1] = d.y; positions[k * 3 + 2] = d.z;
        scales[k * 3] = d.scale_0; scales[k * 3 + 1] = d.scale_1; scales[k * 3 + 2] = d.scale_2;
        colors[k * 3] = d.f_dc_0; colors[k * 3 + 1] = d.f_dc_1; colors[k * 3 + 2] = d.f_dc_2;
        alphas[k] = d.opacity;
        const w = d.rot_0, x = d.rot_1, y = d.rot_2, z = d.rot_3;
        const l = Math.hypot(w, x, y, z) || 1;
        rotations[k * 4] = x / l; rotations[k * 4 + 1] = y / l; rotations[k * 4 + 2] = z / l; rotations[k * 4 + 3] = w / l;
        k++;
    }
    const spz = await serializeSpz({ numPoints: n, shDegree: 0, positions, scales, rotations, alphas, colors, sh: new Float32Array(0) } as any);
    return { spz, n };
};

const registerSparkExport = (events: Events, scene: Scene) => {
    events.function('sparkExport', async () => {
        // collect visible splats in scene order and partition: atlas avatars (animated), sog4d
        // dynamics (skipped in v1), everything else exports as a static
        const splats = scene.getElementsByType(ElementType.splat) as any[];
        const exportables: any[] = [];
        const dynamicNames: string[] = [];
        for (const s of splats) {
            if (s.visible === false) continue;
            if (s.isAtlas && s.atlasFrames?.length) {
                exportables.push(s);
            } else if (s.isDynamic) {
                dynamicNames.push(String(s.name || 'dynamic'));
            } else {
                exportables.push(s);
            }
        }

        if (exportables.length === 0) {
            await events.invoke('showPopup', {
                type: 'info',
                header: 'SPARK PLAYER EXPORT',
                message: 'Nothing exportable — load a static splat or FlexAvatar first.'
            });
            return;
        }

        // scene name = the FIRST exported object's sanitized name
        const name = sanitize(exportables[0].name);

        // progress spans all objects: 1 unit per static, 1 unit per atlas frame
        const totalUnits = exportables.reduce((sum, s) => {
            return sum + ((s.isAtlas && s.atlasFrames?.length) ? s.atlasFrames.length : 1);
        }, 0);
        let done = 0;

        events.fire('progressStart', `Exporting Spark player: ${name}`);
        try {
            // 1. fetch the player template + vendored libs (served under ./spark-template/)
            const indexRaw = await fetch(`${TEMPLATE_BASE}index.html`).then(r => r.text());
            const player = await fetch(`${TEMPLATE_BASE}player.js`).then(r => r.text());
            const vendor = await Promise.all(VENDOR.map(v => fetch(`${TEMPLATE_BASE}vendor/${v}`).then(r => r.arrayBuffer())));

            // title rule shared with the demo repackager (em-dash)
            const index = indexRaw.replace(/<title>[\s\S]*?<\/title>/, `<title>Shooting Lab 4DGS Demo — ${name}</title>`);

            const zip = new JSZip();
            zip.file('index.html', index);
            zip.file('player.js', player);
            VENDOR.forEach((v, i) => zip.file(`vendor/${v}`, vendor[i]));

            // 2. encode every object under objects/ (scene order); statics -> objects/<id>.spz,
            // atlases -> objects/<id>/frames/ HEAD (instant start) + objects/<id>/rest.zip TAIL
            const manifestObjects: any[] = [];
            for (let objIndex = 0; objIndex < exportables.length; objIndex++) {
                const splat = exportables[objIndex];
                const id = `${objIndex}_${sanitize(splat.name)}`;

                if (splat.isAtlas && splat.atlasFrames?.length) {
                    const frames: GSplatData[] = splat.atlasFrames;
                    const fps = splat.atlasFps || 30;
                    const head = Math.min(HEAD_FRAMES, frames.length);

                    // bake the entity's full world transform (constant across frames; atlases carry
                    // no palette edits). identity fast path keeps avatar-only exports byte-identical.
                    // SNAPSHOT the matrix (never alias the entity's live Mat4): the per-frame loop
                    // awaits repeatedly and getWorldTransform() lazily recomputes into the same
                    // instance — a mid-export scene mutation would otherwise bake later frames with a
                    // newer position matrix than their rotation/scale snapshot.
                    const worldMat = new Mat4().copy(splat.entity.getWorldTransform());
                    const bake: Bake | null = isIdentityMat(worldMat) ? null : {
                        mat: worldMat,
                        rot: new Quat().setFromMat4(worldMat), // scale-safe (normalizes basis)
                        scale: worldMat.getScale(new Vec3())
                    };

                    const restZip = new JSZip();
                    for (let i = 0; i < frames.length; i++) {
                        const spz = await gsplatToSpz(frames[i], bake);
                        const fn = `frame_${pad4(i)}.spz`;
                        if (i < head) zip.file(`objects/${id}/frames/${fn}`, spz);
                        else restZip.file(fn, spz);
                        done++;
                        events.fire('progressUpdate', { text: `Encoding ${id}`, progress: Math.round(done / totalUnits * 92) });
                        if ((i & 3) === 0) {
                            // yield so the bar repaints
                            await new Promise<void>((r) => {
                                setTimeout(r);
                            });
                        }
                    }
                    if (frames.length > head) {
                        const restBytes = await restZip.generateAsync({ type: 'uint8array', compression: 'STORE' });
                        zip.file(`objects/${id}/rest.zip`, restBytes);
                    }

                    manifestObjects.push({ id, type: 'animated', dir: `objects/${id}`, frames: frames.length, fps, headCount: head });
                } else {
                    const { spz, n } = await staticToSpz(splat);
                    zip.file(`objects/${id}.spz`, spz);
                    manifestObjects.push({ id, type: 'static', src: `objects/${id}.spz`, numSplats: n });
                    done++;
                    events.fire('progressUpdate', { text: `Encoding ${id}`, progress: Math.round(done / totalUnits * 92) });
                }
            }

            // 3. audio (optional): from the FIRST atlas with an audioUrl (a silent bake has none)
            let audioName: string | null = null;
            const audioSource = exportables.find(s => s.isAtlas && s.atlasFrames?.length && s.audioUrl);
            if (audioSource) {
                try {
                    const a = await fetch(audioSource.audioUrl).then(r => r.arrayBuffer());
                    audioName = 'audio.m4a';
                    zip.file(audioName, a);
                    // mark the soundtrack-owning object in the manifest
                    manifestObjects[exportables.indexOf(audioSource)].audio = true;
                } catch (e) {
                    console.warn('spark export: audio fetch failed, packaging without audio', e);
                }
            }

            // 4. manifest (v2 — scene manifest)
            zip.file('manifest.json', JSON.stringify({
                version: 2, name, audio: audioName, objects: manifestObjects
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

            // 6. dynamics were skipped -> tell the user (after the download has started)
            if (dynamicNames.length > 0) {
                await events.invoke('showPopup', {
                    type: 'info',
                    header: 'SPARK PLAYER EXPORT',
                    message: `Skipped ${dynamicNames.length} dynamic node(s): ${dynamicNames.join(', ')} (not supported in Spark export v1).`
                });
            }
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
