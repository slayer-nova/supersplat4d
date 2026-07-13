import { GSplatData, Mat4, Quat, Vec3 } from 'playcanvas';
import { serializeSpz } from 'spz-js';

import { ElementType } from './element';
import { Events } from './events';
import { Scene } from './scene';
import { SingleSplat, shNames } from './splat-serialize';
import { State } from './splat-state';
import { SparkExportDialog } from './ui/spark-export-dialog';

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

// Scene xz-radius accumulator (squared), reset per export. Written to manifest.sceneRadius so the
// player can normalize the Spread reveal's absolute-unit wave to the scene's actual scale.
let exportMaxL2 = 0;

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
        const l2a = px * px + pz * pz;
        if (l2a > exportMaxL2) exportMaxL2 = l2a;
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
        const l2s = d.x * d.x + d.z * d.z;
        if (l2s > exportMaxL2) exportMaxL2 = l2s;
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

// number of SH bands a splat carries, from f_rest_* prop presence: 9 props -> 1, 24 -> 2, 45 -> 3
const detectShBands = (splat: any): number => {
    let count = 0;
    while (count < 45 && splat.splatData.getProp(`f_rest_${count}`)) count++;
    return ({ 9: 1, 24: 2, 45: 3 } as Record<number, number>)[count] ?? 0;
};

// SH keep rule (dialog keepSh): 'all' keeps every static that carries f_rest_* props, 'lito' only
// files whose name marks them LiTo-generated (<stem>_lito.ply, lito_output*.ply), 'off' keeps
// none. Returns the band count to serialize (0 -> the unchanged SH0 staticToSpz path).
const keptShBands = (splat: any, keepSh: 'off' | 'lito' | 'all'): number => {
    if (keepSh !== 'all' && keepSh !== 'lito') return 0;
    if (keepSh === 'lito' && !String(splat.filename || splat.name || '').toLowerCase().includes('lito')) return 0;
    return detectShBands(splat);
};

// SH-preserving variant of staticToSpz (LiTo objects). Same baked SingleSplat skeleton — palette
// edits, SH rotation (getSHRot) and color tint are all inherited from the serializer — with three
// differences: f_rest_* members are requested, the editor's channel-major planar SH layout
// (f_rest_[ch * coeffs + c]) is transposed to spz-js's interleaved per-coefficient order
// ([c0.r, c0.g, c0.b, c1.r, ...]), and serializeSpz gets the real shDegree. staticToSpz (SH0
// path) stays byte-for-byte untouched.
const staticToSpzSh = async (splat: any, bands: number): Promise<{ spz: Uint8Array, n: number, shDegree: number }> => {
    const coeffs = ({ 1: 3, 2: 8, 3: 15 } as Record<number, number>)[bands];
    const state = splat.splatData.getProp('state') as Uint8Array | undefined;
    const total = splat.splatData.numSplats;
    const single = new SingleSplat([...MEMBERS, ...shNames.slice(0, coeffs * 3)], { bakeFullWorldTransform: true });
    let n = 0;
    for (let i = 0; i < total; i++) {
        if (!state || (state[i] & State.deleted) === 0) n++;
    }
    const positions = new Float32Array(n * 3);
    const scales = new Float32Array(n * 3);
    const colors = new Float32Array(n * 3);
    const alphas = new Float32Array(n);
    const rotations = new Float32Array(n * 4);
    const sh = new Float32Array(n * coeffs * 3);
    let k = 0;
    for (let i = 0; i < total; i++) {
        if (state && (state[i] & State.deleted) !== 0) continue;
        single.read(splat, i);
        const d = single.data;
        const l2s = d.x * d.x + d.z * d.z;
        if (l2s > exportMaxL2) exportMaxL2 = l2s;
        positions[k * 3] = d.x; positions[k * 3 + 1] = d.y; positions[k * 3 + 2] = d.z;
        scales[k * 3] = d.scale_0; scales[k * 3 + 1] = d.scale_1; scales[k * 3 + 2] = d.scale_2;
        colors[k * 3] = d.f_dc_0; colors[k * 3 + 1] = d.f_dc_1; colors[k * 3 + 2] = d.f_dc_2;
        alphas[k] = d.opacity;
        const w = d.rot_0, x = d.rot_1, y = d.rot_2, z = d.rot_3;
        const l = Math.hypot(w, x, y, z) || 1;
        rotations[k * 4] = x / l; rotations[k * 4 + 1] = y / l; rotations[k * 4 + 2] = z / l; rotations[k * 4 + 3] = w / l;
        for (let c = 0; c < coeffs; c++) {
            for (let ch = 0; ch < 3; ch++) {
                sh[(k * coeffs + c) * 3 + ch] = d[`f_rest_${ch * coeffs + c}`];
            }
        }
        k++;
    }
    const spz = await serializeSpz({ numPoints: n, shDegree: bands, positions, scales, rotations, alphas, colors, sh } as any);
    return { spz, n, shDegree: bands };
};

// static SH0 splat -> baked binary 3DGS .ply carrying exactly the props ply_to_sog4d.py needs
// (x,y,z, f_dc_0-2, opacity, scale_0-2, rot_0-3 — no normals; read by name so order is free).
// Same baked SingleSplat extraction as staticToSpz (world transform baked, deleted filtered,
// quats normalized). Little-endian body matches the header (browsers run on LE hardware).
const staticToPly = (splat: any): { ply: Uint8Array, n: number } => {
    const state = splat.splatData.getProp('state') as Uint8Array | undefined;
    const total = splat.splatData.numSplats;
    const single = new SingleSplat(MEMBERS, { bakeFullWorldTransform: true });
    let n = 0;
    for (let i = 0; i < total; i++) {
        if (!state || (state[i] & State.deleted) === 0) n++;
    }
    const STRIDE = 14; // x y z  f_dc0 f_dc1 f_dc2  opacity  scale0 scale1 scale2  rot0 rot1 rot2 rot3
    const body = new Float32Array(n * STRIDE);
    let k = 0;
    for (let i = 0; i < total; i++) {
        if (state && (state[i] & State.deleted) !== 0) continue;
        single.read(splat, i);
        const d = single.data;
        const l2 = d.x * d.x + d.z * d.z;
        if (l2 > exportMaxL2) exportMaxL2 = l2;
        const w = d.rot_0, x = d.rot_1, y = d.rot_2, z = d.rot_3;   // native (w,x,y,z)
        const l = Math.hypot(w, x, y, z) || 1;
        const o = k * STRIDE;
        body[o] = d.x; body[o + 1] = d.y; body[o + 2] = d.z;
        body[o + 3] = d.f_dc_0; body[o + 4] = d.f_dc_1; body[o + 5] = d.f_dc_2;
        body[o + 6] = d.opacity;
        body[o + 7] = d.scale_0; body[o + 8] = d.scale_1; body[o + 9] = d.scale_2;
        body[o + 10] = w / l; body[o + 11] = x / l; body[o + 12] = y / l; body[o + 13] = z / l;
        k++;
    }
    const header =
        'ply\nformat binary_little_endian 1.0\n' +
        `element vertex ${n}\n` +
        'property float x\nproperty float y\nproperty float z\n' +
        'property float f_dc_0\nproperty float f_dc_1\nproperty float f_dc_2\n' +
        'property float opacity\n' +
        'property float scale_0\nproperty float scale_1\nproperty float scale_2\n' +
        'property float rot_0\nproperty float rot_1\nproperty float rot_2\nproperty float rot_3\n' +
        'end_header\n';
    const head = new TextEncoder().encode(header);
    const bodyBytes = new Uint8Array(body.buffer, body.byteOffset, n * STRIDE * 4);
    const ply = new Uint8Array(head.length + bodyBytes.length);
    ply.set(head, 0);
    ply.set(bodyBytes, head.length);
    return { ply, n };
};

// static SH0 splat -> PlayCanvas SOG (.sog) via the FlexAvatar server's /api/ply_to_sog.
// SOG's per-object 16-bit log-quantized positions have NONE of SPZ's 24-bit fixed-point ±2048
// world-range cliff, so far-from-origin / later-placed statics stay sharp. Encoding is
// Python-only (ply_to_sog4d.py), so we round-trip the baked .ply through the server.
const staticToSog = async (splat: any, sogUrl: string): Promise<{ sog: Uint8Array, n: number }> => {
    const { ply, n } = staticToPly(splat);
    const form = new FormData();
    // cast: TS's newer lib types Uint8Array as Uint8Array<ArrayBufferLike>, not the
    // Uint8Array<ArrayBuffer> that BlobPart wants — a valid Blob part at runtime regardless.
    form.append('file', new Blob([ply as BlobPart], { type: 'application/octet-stream' }), 'static.ply');
    const res = await fetch(`${sogUrl}/api/ply_to_sog`, { method: 'POST', body: form });
    if (!res.ok) {
        throw new Error(`SOG server ${res.status} at ${sogUrl}: ${(await res.text().catch(() => '')).slice(0, 300)}`);
    }
    return { sog: new Uint8Array(await res.arrayBuffer()), n };
};

const registerSparkExport = (events: Events, scene: Scene) => {
    // options dialog, created on first export (self-attached: editor.ts stays untouched)
    let dialog: SparkExportDialog | null = null;
    const showDialog = (hasCameraPath: boolean) => {
        if (!dialog) {
            dialog = new SparkExportDialog();
            (document.getElementById('top-container') ?? document.body).appendChild(dialog.dom);
        }
        return dialog.show(hasCameraPath);
    };

    events.function('sparkExport', async () => {
        // collect visible splats in scene order and partition: atlas avatars (animated), sog4d
        // dynamics (skipped in v1), everything else exports as a static
        exportMaxL2 = 0;   // fresh scene-radius accumulation per export
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

        // camera keyframe path (SuperSplat poseSets, set 0) — same rules the editor's flythrough
        // uses. Collected BEFORE the options dialog so the dialog can disable its camera-path
        // select when the timeline has fewer than 2 valid poses.
        const poseSets = (events.invoke('docSerialize.poseSets') ?? []) as any[];
        const duration = (events.invoke('timeline.frames') as number) || 0;
        const camPoses = ((poseSets[0]?.poses ?? []) as any[])
        .filter(p => p.frame < duration)
        .sort((a, b) => a.frame - b.frame)
        .map(p => ({ frame: p.frame, position: p.position, target: p.target }));

        // export options dialog (camera mode / entrance effect / duration); Cancel → no export
        const options = await showDialog(camPoses.length >= 2);
        if (!options) return;

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
            const swSource = await fetch(`${TEMPLATE_BASE}sw.js`).then(r => r.text());
            const readme = await fetch(`${TEMPLATE_BASE}README.md`).then(r => r.text());
            const vendor = await Promise.all(VENDOR.map(v => fetch(`${TEMPLATE_BASE}vendor/${v}`).then(r => r.arrayBuffer())));

            // title rule shared with the demo repackager (em-dash)
            const index = indexRaw.replace(/<title>[\s\S]*?<\/title>/, `<title>Shooting Lab 4DGS Demo — ${name}</title>`);

            const zip = new JSZip();
            zip.file('index.html', index);
            zip.file('player.js', player);
            zip.file('sw.js', swSource);   // always shipped; registered only when player.offline is on
            zip.file('README.md', readme); // viewer URL-parameter reference at the package root
            VENDOR.forEach((v, i) => zip.file(`vendor/${v}`, vendor[i]));

            // 2. encode every object under objects/ (scene order); statics -> objects/<id>.spz,
            // atlases -> objects/<id>/frames/ HEAD (instant start) + objects/<id>/rest.zip TAIL
            const manifestObjects: any[] = [];

            // SOG static mode: each object's conversion is an INDEPENDENT server round-trip, so
            // run them CONCURRENTLY up front (capped) instead of one-at-a-time in the loop — the
            // server spawns the conversions in parallel across CPU cores. Results are cached and
            // the loop below just packages them in scene order (manifest indexing unchanged).
            const sogCache = new Map<any, { sog: Uint8Array, n: number }>();
            if (options.sogStatics) {
                const sogTargets = exportables.filter(s =>
                    !(s.isAtlas && s.atlasFrames?.length) && keptShBands(s, options.keepSh) === 0);
                const CAP = 8; // concurrent server conversions (each spawns a Python subprocess)
                for (let i = 0; i < sogTargets.length; i += CAP) {
                    const batch = sogTargets.slice(i, i + CAP);
                    const results = await Promise.all(batch.map(s => staticToSog(s, options.sogUrl)));
                    batch.forEach((s, j) => sogCache.set(s, results[j]));
                    const conv = Math.min(i + CAP, sogTargets.length);
                    events.fire('progressUpdate', { text: `Converting SOG (${conv}/${sogTargets.length})`, progress: Math.round(conv / Math.max(1, sogTargets.length) * 30) });
                }
            }

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
                    // SH-kept statics (see keptShBands) go through staticToSpzSh; everything else
                    // takes the unchanged compact SH0 path. shDegree is informational for SH
                    // statics only (the .spz header is authoritative for the player).
                    const shBands = keptShBands(splat, options.keepSh);
                    // SOG static mode: SH0 statics -> server-side SOG (no SPZ ±2048 range cliff,
                    // so far/late statics stay sharp). SH-kept statics stay on SPZ (SOG-with-SH is
                    // a later refinement). Any other static export path is byte-for-byte unchanged.
                    if (options.sogStatics && shBands === 0) {
                        // pre-converted concurrently above; just package it here
                        const { sog, n } = sogCache.get(splat)!;
                        zip.file(`objects/${id}.sog`, sog);
                        manifestObjects.push({ id, type: 'static', src: `objects/${id}.sog`, numSplats: n });
                    } else {
                        const { spz, n } = shBands > 0 ? await staticToSpzSh(splat, shBands) : await staticToSpz(splat);
                        zip.file(`objects/${id}.spz`, spz);
                        manifestObjects.push({ id, type: 'static', src: `objects/${id}.spz`, numSplats: n, ...(shBands > 0 ? { shDegree: shBands } : {}) });
                    }
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

            // camera block: needs >= 2 poses AND the dialog's consent ("Don't include" drops it,
            // along with the manifest.player.camera block below)
            const camera = (camPoses.length >= 2 && options.cameraMode !== 'off') ? {
                frames: duration,
                fps: (events.invoke('timeline.frameRate') as number) || 30,
                smoothness: (events.invoke('timeline.smoothness') as number) ?? 1,
                poses: camPoses
            } : null;

            // 4. manifest (v2 — scene manifest). sceneRadius = max splat distance from the Y axis
            // across every exported object (post-bake), for the player's scale-normalized reveal.
            const sceneRadius = exportMaxL2 > 0 ? Math.round(Math.sqrt(exportMaxL2) * 10000) / 10000 : 0;
            // player defaults from the options dialog (player-side precedence:
            // URL param > manifest.player > built-in default). player.camera is present ONLY
            // when a camera path is exported; "None" writes effect 'off' (sec kept, harmless).
            const playerDefaults = {
                reveal: { effect: options.revealEffect, sec: options.revealSec },
                watermark: options.watermark,
                zoom: options.zoomMode === 'manual' ?
                    { mode: 'manual', min: options.zoomMin, max: options.zoomMax } :
                    { mode: options.zoomMode },
                offline: options.offline,
                // written always (true or false) — explicit is easier to debug than absence;
                // the built-in player default (off) applies only to packages without this field
                arLight: options.arLight,
                ...(camera ? { camera: { autoplay: options.cameraMode === 'auto' } } : {})
            };
            zip.file('manifest.json', JSON.stringify({
                version: 2,
                name,
                audio: audioName,
                objects: manifestObjects,
                player: playerDefaults,
                ...(sceneRadius > 0 ? { sceneRadius } : {}),
                ...(camera ? { camera } : {})
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
