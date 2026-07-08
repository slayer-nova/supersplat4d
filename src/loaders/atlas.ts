import { ALL_FORMATS, BlobSource, CanvasSink, Input } from 'mediabunny';
import { GSplatData } from 'playcanvas';

import { deserializeFromSSplat } from './splat';

// FlexAvatar atlas-video bake loader.
//
// A FlexAvatar bake is a directory {meta.json, atlas.mp4, [audio.m4a]}. Each mp4
// frame is a grayscale "atlas" image that packs a fixed-count set of Gaussians'
// 14 per-splat attributes (pos3 | log-scale3 | quat4 wxyz | opacity | rgb3) into
// tiles. Positions and quats are 16-bit (an MSB tile + an LSB tile each); the
// log-scales, opacity and rgb are 8-bit (one tile each). All channels are
// quantized against clip-global per-channel [min,max] ranges stored in meta.json.
//
// This module ports the decode from the FlexAvatar web player's rebuild()
// (web_demo/static/player/player.js): given one decoded atlas frame as ImageData
// plus meta.ranges, it unpacks EXACTLY the antimatter15 32-byte .splat layout
//   pos f32x3 | scale(LINEAR) f32x3 | rgba u8x4 | quat u8x4
// which is byte-identical to supersplat's .splat input, so the resulting
// ArrayBuffer feeds straight into deserializeFromSSplat() -> GSplatData -> Splat.

const CH16 = ['x', 'y', 'z', 'qw', 'qx', 'qy', 'qz'];
const CH8 = ['lsx', 'lsy', 'lsz', 'op', 'r', 'g', 'b'];

type Tile = { name: string; col: number; row: number };

type AtlasMeta = {
    n: number;
    T: number;
    tile_w: number;
    tile_h: number;
    fps: number;
    video: string;
    audio: string | null;
    tiles: Tile[];
    ranges: Record<string, [number, number]>;
};

type Ch16 = { msb: Tile; lsb: Tile; lo: number; span: number };
type Ch8 = { tile: Tile; lo: number; span: number };

const atlasDims = (meta: AtlasMeta) => {
    const TW = meta.tile_w;
    const TH = meta.tile_h;
    return { TW, TH, ATLAS_W: 4 * TW, ATLAS_H: 6 * TH };
};

// FLEX bakes carry ~88% near-transparent "background"/template splats. The FlexAvatar
// player's antimatter15 shader discards them in-fragment (exp(A)*a, A<-4 discard), so they
// are invisible there; PlayCanvas's GSplat renders them as a faint large-scale haze/plume.
// Drop them at decode time (opacity below OP_MIN) so our node renders like the player.
const OP_MIN = 0.03;

// Decode-frame emission policy:
//   'drop'  — skip splats with opacity < OP_MIN (variable count). Used by the STATIC
//             single-frame path (?atlasframe=N) — unchanged, byte-identical to before.
//   'full'  — emit ALL N splats at index i (no drop). Used by the animation pre-pass to
//             read back per-splat opacity and build a keep-set.
//   keepMask— emit only splats where keepMask[i] !== 0, in ascending-index order. Gives a
//             FIXED, index-stable count K across every frame so gaussian slot j is always the
//             same surface point — the invariant the in-place GPU texture update relies on.
type DecodeMode = 'drop' | 'full';

// Unpack one decoded atlas frame (RGBA ImageData, ATLAS_W x ATLAS_H) into the
// 32-byte-per-splat antimatter15 .splat buffer. Byte-for-byte mirror of the
// FlexAvatar player's rebuild().
const decodeAtlasFrameCore = (
    meta: AtlasMeta,
    imgData: ImageData,
    mode: DecodeMode,
    keepMask: Uint8Array | null
): ArrayBuffer => {
    const N = meta.n;
    const TW = meta.tile_w;
    const TH = meta.tile_h;
    const W = 4 * TW; // ATLAS_W

    const TILE: Record<string, Tile> = {};
    for (const t of meta.tiles) TILE[t.name] = t;

    const R = meta.ranges;
    const c: Record<string, Ch16 | Ch8> = {};
    for (const name of CH16) {
        c[name] = {
            msb: TILE[`${name}_msb`],
            lsb: TILE[`${name}_lsb`],
            lo: R[name][0],
            span: R[name][1] - R[name][0]
        };
    }
    for (const name of CH8) {
        c[name] = { tile: TILE[name], lo: R[name][0], span: R[name][1] - R[name][0] };
    }

    const d = imgData.data; // RGBA bytes
    const buf = new ArrayBuffer(N * 32);
    const f = new Float32Array(buf); // pos + scale
    const uc = new Uint8ClampedArray(buf); // rgba + rot (clamped writes)

    const cx = c.x as Ch16, cy = c.y as Ch16, cz = c.z as Ch16;
    const cqw = c.qw as Ch16, cqx = c.qx as Ch16, cqy = c.qy as Ch16, cqz = c.qz as Ch16;
    const clsx = c.lsx as Ch8, clsy = c.lsy as Ch8, clsz = c.lsz as Ch8;
    const cop = c.op as Ch8, cr = c.r as Ch8, cg = c.g as Ch8, cb = c.b as Ch8;

    // luma (R byte) of tile `t` for gaussian sub-pixel (ix, iy)
    const L = (t: Tile, ix: number, iy: number) => d[(((t.row * TH + iy) * W) + t.col * TW + ix) << 2];
    const inv16 = 1 / 65535, inv8 = 1 / 255;

    let k = 0;
    for (let i = 0; i < N; i++) {
        // Emission gate: fixed keep-set (animation frames) OR opacity drop (static) OR all.
        if (keepMask) {
            if (keepMask[i] === 0) continue;
        }

        const ix = i & 255;
        const iy = i >> 8;

        // 16-bit positions
        const X = ((L(cx.msb, ix, iy) * 256 + L(cx.lsb, ix, iy)) * inv16) * cx.span + cx.lo;
        const Y = ((L(cy.msb, ix, iy) * 256 + L(cy.lsb, ix, iy)) * inv16) * cy.span + cy.lo;
        const Z = ((L(cz.msb, ix, iy) * 256 + L(cz.lsb, ix, iy)) * inv16) * cz.span + cz.lo;

        // 16-bit quaternion (wxyz), then normalize to the u8 [-1,1]*128+128 encoding
        const qw = ((L(cqw.msb, ix, iy) * 256 + L(cqw.lsb, ix, iy)) * inv16) * cqw.span + cqw.lo;
        const qx = ((L(cqx.msb, ix, iy) * 256 + L(cqx.lsb, ix, iy)) * inv16) * cqx.span + cqx.lo;
        const qy = ((L(cqy.msb, ix, iy) * 256 + L(cqy.lsb, ix, iy)) * inv16) * cqy.span + cqy.lo;
        const qz = ((L(cqz.msb, ix, iy) * 256 + L(cqz.lsb, ix, iy)) * inv16) * cqz.span + cqz.lo;
        const ql = Math.hypot(qw, qx, qy, qz) || 1;
        const rn = 128 / ql;

        // 8-bit log-scales -> linear (faithful port; no scale cap — the "plume" first seen was
        // the bust's shoulders/torso geometry from a low angle, NOT a render artifact).
        const sx = Math.exp((L(clsx.tile, ix, iy) * inv8) * clsx.span + clsx.lo);
        const sy = Math.exp((L(clsy.tile, ix, iy) * inv8) * clsy.span + clsy.lo);
        const sz = Math.exp((L(clsz.tile, ix, iy) * inv8) * clsz.span + clsz.lo);

        // 8-bit opacity + rgb (all 0..1)
        const op = (L(cop.tile, ix, iy) * inv8) * cop.span + cop.lo;
        if (!keepMask && mode === 'drop' && op < OP_MIN) continue; // static path: drop near-transparent
        const rr = (L(cr.tile, ix, iy) * inv8) * cr.span + cr.lo;
        const gg = (L(cg.tile, ix, iy) * inv8) * cg.span + cg.lo;
        const bb = (L(cb.tile, ix, iy) * inv8) * cb.span + cb.lo;

        const fo = 8 * k;
        f[fo + 0] = X; f[fo + 1] = Y; f[fo + 2] = Z;
        f[fo + 3] = sx; f[fo + 4] = sy; f[fo + 5] = sz;

        const bo = 32 * k;
        uc[bo + 24] = rr * 255;
        uc[bo + 25] = gg * 255;
        uc[bo + 26] = bb * 255;
        uc[bo + 27] = op * 255;
        uc[bo + 28] = qw * rn + 128;
        uc[bo + 29] = qx * rn + 128;
        uc[bo + 30] = qy * rn + 128;
        uc[bo + 31] = qz * rn + 128;
        k++;
    }

    // Trim to the emitted splats — deserializeFromSSplat reads the count from byteLength/32.
    return buf.slice(0, k * 32);
};

// Static single-frame decode (unchanged public behavior): drop near-transparent splats.
const decodeAtlasFrame = (meta: AtlasMeta, imgData: ImageData): ArrayBuffer =>
    decodeAtlasFrameCore(meta, imgData, 'drop', null);

// Fetch a bake's meta.json. `base` is a directory URL ending in '/'.
const loadAtlasMeta = async (base: string): Promise<AtlasMeta> => {
    const res = await fetch(`${base}meta.json`);
    if (!res.ok) throw new Error(`atlas: failed to fetch ${base}meta.json (${res.status})`);
    return await res.json() as AtlasMeta;
};

// Load the bake's atlas.mp4 into a <video>, seek it to a specific frame, and
// draw+read that frame back as ImageData. Same-origin required (getImageData on a
// cross-origin video taints the canvas). This is the proven decode path from the
// FlexAvatar player.
const decodeVideoFrame = (meta: AtlasMeta, videoUrl: string, frameIndex: number): Promise<ImageData> => {
    const { ATLAS_W, ATLAS_H } = atlasDims(meta);

    return new Promise((resolve, reject) => {
        const vid = document.createElement('video');
        vid.muted = true;
        vid.preload = 'auto';
        vid.crossOrigin = 'anonymous';
        vid.src = videoUrl;

        const canvas = document.createElement('canvas');
        canvas.width = ATLAS_W;
        canvas.height = ATLAS_H;
        const ctx = canvas.getContext('2d', { willReadFrequently: true });

        const cleanup = () => {
            vid.removeAttribute('src');
            vid.load();
        };

        const grab = () => {
            try {
                ctx.drawImage(vid, 0, 0, ATLAS_W, ATLAS_H);
                const img = ctx.getImageData(0, 0, ATLAS_W, ATLAS_H);
                cleanup();
                resolve(img);
            } catch (err) {
                cleanup();
                reject(err);
            }
        };

        vid.addEventListener('error', () => {
            cleanup();
            reject(new Error(`atlas: video failed to load ${videoUrl}`));
        });

        // Seek to the requested frame once metadata is available, then grab on
        // the seeked event (frame is guaranteed decoded at that point).
        vid.addEventListener('loadeddata', () => {
            const t = Math.min((frameIndex + 0.5) / meta.fps, Math.max(0, (meta.T - 0.5) / meta.fps));
            if (Math.abs(vid.currentTime - t) < 1e-4) {
                grab();
            } else {
                vid.addEventListener('seeked', grab, { once: true });
                vid.currentTime = t;
            }
        }, { once: true });
    });
};

// Decode a bake frame all the way to a GSplatData (frame 0 by default).
const loadAtlasFrame = async (base: string, frameIndex = 0): Promise<GSplatData> => {
    const meta = await loadAtlasMeta(base);
    const img = await decodeVideoFrame(meta, `${base}${meta.video}`, frameIndex);
    const buf = decodeAtlasFrame(meta, img);
    return deserializeFromSSplat(buf);
};

// FAST path: decode every frame via WebCodecs (mediabunny), streaming onFrame in presentation
// order. The atlas is all-intra (keyint=1), so the decoder runs at hardware speed with no per-frame
// <video> seek latency — cutting a 160-frame tiktok bake from ~30-40s (≈200-400ms/seek) to a few
// seconds. Falls back to the <video>-seek path if WebCodecs/demux isn't available or yields the
// wrong frame count. Same-origin required (getImageData taints a cross-origin canvas).
const decodeVideoAllFrames = async (
    meta: AtlasMeta,
    videoUrl: string,
    onFrame: (frameIndex: number, imgData: ImageData) => void
): Promise<void> => {
    const { ATLAS_W, ATLAS_H } = atlasDims(meta);
    try {
        // Download the whole mp4 once and decode from memory (BlobSource). UrlSource issues HTTP
        // range requests which the dev `serve` aborts (AbortError → hang); a Blob avoids that.
        const resp = await fetch(videoUrl);
        if (!resp.ok) throw new Error(`atlas: fetch ${resp.status} ${videoUrl}`);
        const blob = await resp.blob();
        const input = new Input({ source: new BlobSource(blob), formats: ALL_FORMATS });
        const videoTrack = await input.getPrimaryVideoTrack();
        if (!videoTrack) throw new Error('no video track');

        // No width/height → the sink outputs at the video's native resolution (== the atlas size);
        // we drawImage into an ATLAS_W×ATLAS_H read canvas below (1:1, no scaling). Specifying both
        // width and height would require a `fit` option.
        const sink = new CanvasSink(videoTrack);
        const readCanvas = document.createElement('canvas');
        readCanvas.width = ATLAS_W;
        readCanvas.height = ATLAS_H;
        const readCtx = readCanvas.getContext('2d', { willReadFrequently: true })!;

        let frame = 0;
        for await (const wrapped of sink.canvases()) {
            if (frame >= meta.T) break;
            readCtx.drawImage(wrapped.canvas as CanvasImageSource, 0, 0, ATLAS_W, ATLAS_H);
            onFrame(frame, readCtx.getImageData(0, 0, ATLAS_W, ATLAS_H));
            frame++;
        }
        (input as unknown as { dispose?: () => void }).dispose?.();

        if (frame >= meta.T) return; // fast path decoded all frames
        console.warn(`atlas: WebCodecs yielded ${frame}/${meta.T} frames — falling back to seek`);
    } catch (err) {
        console.warn('atlas: WebCodecs decode unavailable, falling back to <video> seek:', err);
    }
    // Fallback re-decodes from scratch; onFrame overwrites by index and the keep-mask OR is
    // idempotent, so any partial fast-path output is harmless.
    return decodeVideoAllFramesSeek(meta, videoUrl, onFrame);
};

// Fallback: load the atlas.mp4 ONCE and walk it frame-by-frame by sequential <video> seeking,
// invoking `onFrame(f, imgData)` for each of meta.T frames in order.
const decodeVideoAllFramesSeek = (
    meta: AtlasMeta,
    videoUrl: string,
    onFrame: (frameIndex: number, imgData: ImageData) => void
): Promise<void> => {
    const { ATLAS_W, ATLAS_H } = atlasDims(meta);

    return new Promise((resolve, reject) => {
        const vid = document.createElement('video');
        vid.muted = true;
        vid.preload = 'auto';
        vid.crossOrigin = 'anonymous';
        vid.src = videoUrl;

        const canvas = document.createElement('canvas');
        canvas.width = ATLAS_W;
        canvas.height = ATLAS_H;
        const ctx = canvas.getContext('2d', { willReadFrequently: true });

        let frame = 0;

        const cleanup = () => {
            vid.removeAttribute('src');
            vid.load();
        };

        // seek time for a frame — same centering as decodeVideoFrame (mid-frame sample).
        const seekTime = (f: number) =>
            Math.min((f + 0.5) / meta.fps, Math.max(0, (meta.T - 0.5) / meta.fps));

        const grabAndAdvance = () => {
            try {
                ctx.drawImage(vid, 0, 0, ATLAS_W, ATLAS_H);
                const img = ctx.getImageData(0, 0, ATLAS_W, ATLAS_H);
                onFrame(frame, img);
            } catch (err) {
                cleanup();
                reject(err);
                return;
            }
            frame++;
            if (frame >= meta.T) {
                cleanup();
                resolve();
                return;
            }
            vid.currentTime = seekTime(frame);
        };

        vid.addEventListener('error', () => {
            cleanup();
            reject(new Error(`atlas: video failed to load ${videoUrl}`));
        });

        vid.addEventListener('seeked', grabAndAdvance);

        vid.addEventListener('loadeddata', () => {
            vid.currentTime = seekTime(0);
        }, { once: true });
    });
};

type AtlasFrames = {
    meta: AtlasMeta;
    // One GSplatData per frame, ALL with the same fixed count K and the same index→surface
    // mapping (gaussian slot j is the same point in every frame). Ready to feed straight into
    // GSplatResource.updateTransformData / updateColorData for an in-place per-frame GPU swap.
    frames: GSplatData[];
    numSplats: number;
};

// Pre-decode EVERY frame of a bake for timeline playback. Two passes:
//   1. Decode all T frames at full N (no drop) into transient 32-byte buffers, and union a
//      keep-mask over frames: keep gaussian i if its opacity clears OP_MIN in ANY frame.
//      (Union — not frame-0 alone — so a splat that only becomes visible mid-clip, e.g. inner
//      mouth when it opens, is never permanently dropped.)
//   2. Compact every frame to that fixed keep-set (constant count K, index-stable) and
//      deserialize to a GSplatData.
// Memory note: pass-1 holds T*N*32 bytes transiently (71*58361*32 ≈ 132MB for FOOD_3); it is
// released once pass 2 builds the compacted GSplatData set (T * K * ~60 bytes).
const loadAtlasAllFrames = async (base: string): Promise<AtlasFrames> => {
    const meta = await loadAtlasMeta(base);
    const N = meta.n;
    const T = meta.T;

    // Pass 1: full-N decode of every frame + union opacity keep-mask (read back from byte 27,
    // which the decoder wrote as clamp(op*255)).
    const fullBufs: ArrayBuffer[] = new Array(T);
    const keepMask = new Uint8Array(N);
    const OP_MIN_BYTE = Math.round(OP_MIN * 255);
    await decodeVideoAllFrames(meta, `${base}${meta.video}`, (f, img) => {
        const bufFull = decodeAtlasFrameCore(meta, img, 'full', null); // N*32, index i == splat i
        fullBufs[f] = bufFull;
        const uc = new Uint8Array(bufFull);
        for (let i = 0; i < N; i++) {
            if (uc[i * 32 + 27] >= OP_MIN_BYTE) keepMask[i] = 1;
        }
    });

    // Build the compacted keep-index list (ascending — matches the decoder's emission order).
    const keep: number[] = [];
    for (let i = 0; i < N; i++) {
        if (keepMask[i]) keep.push(i);
    }
    const K = keep.length;

    // Pass 2: compact each frame to the fixed keep-set (pure byte copy, no re-decode).
    const frames: GSplatData[] = new Array(T);
    for (let f = 0; f < T; f++) {
        const src = new Uint8Array(fullBufs[f]);
        const comp = new ArrayBuffer(K * 32);
        const dst = new Uint8Array(comp);
        for (let j = 0; j < K; j++) {
            const s = keep[j] * 32;
            dst.set(src.subarray(s, s + 32), j * 32);
        }
        frames[f] = deserializeFromSSplat(comp);
        fullBufs[f] = null as unknown as ArrayBuffer; // release the 132MB pass-1 buffer set as we go
    }

    console.log(`🎞️ atlas: pre-decoded ${T} frames, ${K}/${N} splats kept (fixed index-stable set)`);
    return { meta, frames, numSplats: K };
};

export type { AtlasMeta, AtlasFrames };
export { decodeAtlasFrame, loadAtlasMeta, decodeVideoFrame, loadAtlasFrame, loadAtlasAllFrames };
