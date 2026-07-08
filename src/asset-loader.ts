import { AppBase, Asset, GSplatData, GSplatResource, Vec3 } from 'playcanvas';

import { Events } from './events';
import { loadAtlasFrame, loadAtlasAllFrames } from './loaders/atlas';
import { AssetSource } from './loaders/asset-source';
import { loadDyn } from './loaders/dyn';
import { checkPlyIsDynamic, loadDynamicPly, DynamicPlyParams } from './loaders/dynamic-ply';
import { loadGsplat } from './loaders/gsplat';
import { loadLcc } from './loaders/lcc';
import { loadSog4d } from './loaders/sog4d';
import { loadSplat } from './loaders/splat';
import { Splat } from './splat';

const defaultOrientation = new Vec3(0, 0, 180);
const lccOrientation = new Vec3(90, 0, 180);
// FlexAvatar atlas nodes need NO node rotation: our atlas decode (loaders/atlas.ts) already emits
// a buffer that is upright (Y-up) and face-toward-+Z in supersplat's world, so identity orientation
// opens on an upright, face-on 3/4 portrait under the default camera (azim ~334, elev ~3). A normal
// .splat needs defaultOrientation's roll-180 (its buffer is Y-down); ours does not — the atlas rebuild
// bakes that in. (The old Vec3(0,180,180) ≡ 180° about X flipped the already-correct buffer BOTH
// upside-down AND backward, which is why atlas nodes used to open on the upside-down back of the head.)
const atlasOrientation = new Vec3(0, 0, 0);

// handles loading gltf container assets
class AssetLoader {
    app: AppBase;
    events: Events;
    defaultAnisotropy: number;
    loadAllData = true;

    constructor(app: AppBase, events: Events, defaultAnisotropy?: number) {
        this.app = app;
        this.events = events;
        this.defaultAnisotropy = defaultAnisotropy || 1;
    }

    async load(assetSource: AssetSource) {
        const wrap = (gsplatData: GSplatData) => {
            const asset = new Asset(assetSource.filename || assetSource.url, 'gsplat', {
                url: assetSource.contents ? `local-asset-${Date.now()}` : assetSource.url ?? assetSource.filename,
                filename: assetSource.filename
            });
            this.app.assets.add(asset);
            asset.resource = new GSplatResource(this.app.graphicsDevice, gsplatData);
            return asset;
        };

        if (!assetSource.animationFrame) {
            this.events.fire('startSpinner');
        }

        try {
            const filename = (assetSource.filename || assetSource.url).toLowerCase();

            let asset;
            let orientation = defaultOrientation;

            if (filename.endsWith('.splat')) {
                asset = wrap(await loadSplat(assetSource));
            } else if (filename.endsWith('.lcc')) {
                asset = wrap(await loadLcc(assetSource));
                orientation = lccOrientation;
            } else if (filename.endsWith('.dyn.json')) {
                asset = await loadDyn(this.app.assets, assetSource, this.app.graphicsDevice);
            } else if (filename.endsWith('.sog4d')) {
                asset = await loadSog4d(this.app.assets, assetSource, this.app.graphicsDevice, this.events);
            } else if (filename.endsWith('.ply')) {
                // Check if PLY is dynamic (has trbf_center, trbf_scale, motion_*)
                const { isDynamic, cfgArgs, cullingThreshold } = await checkPlyIsDynamic(assetSource);
                const staticPlyOpts = { visibilityCullThreshold: cullingThreshold };

                if (isDynamic) {
                    let params: DynamicPlyParams | null = cfgArgs;
                    
                    // If no cfg_args in PLY header, ask user for parameters
                    if (!params) {
                        // Hide spinner while dialog is shown
                        this.events.fire('stopSpinner');
                        params = await this.events.invoke('showDynamicParamsDialog', assetSource.filename || 'unknown.ply');
                        this.events.fire('startSpinner');
                    }
                    
                    if (params) {
                        console.log('📊 Loading dynamic PLY with params:', params);
                        asset = await loadDynamicPly(this.app.assets, assetSource, params);
                    } else {
                        // User cancelled, load as static
                        console.log('⚠️ User cancelled dynamic params dialog, loading as static PLY');
                        asset = await loadGsplat(this.app.assets, assetSource, staticPlyOpts);
                    }
                } else {
                    // Not dynamic, load as regular PLY (optional cfg_args culling for static visibility SH)
                    asset = await loadGsplat(this.app.assets, assetSource, staticPlyOpts);
                }
            } else {
                asset = await loadGsplat(this.app.assets, assetSource);
            }

            return new Splat(asset, orientation);
        } finally {
            if (!assetSource.animationFrame) {
                this.events.fire('stopSpinner');
            }
        }
    }

    // Load a FlexAvatar atlas-video bake as a Splat node. `base` is the bake directory URL
    // (must end with '/'), served same-origin. The decoded per-frame buffer is antimatter15
    // .splat layout, so it takes the same upright orientation as a .splat file (atlasOrientation:
    // roll 180 for FLEX Y-down + yaw 180 to face the camera).
    //
    // animate=false → a single static frame (frameIndex), the ?atlasframe=N path (unchanged).
    // animate=true  → pre-decode ALL T frames (fixed index-stable set) and return a Splat that
    //                 plays them on the timeline (frame 0 shown until timeline drives it).
    // onProgress: when a caller (e.g. a multi-source scene import) wants to own a single unified
    // progress bar, it passes onProgress(fraction 0..1, label) and we forward decode progress to it
    // instead of driving our own overlay. When omitted, the animate path drives the shared Progress
    // overlay itself (progressStart/Update/End) so every entry point gets a bar for free.
    async loadAtlas(base: string, frameIndex = 0, animate = false, onProgress?: (fraction: number, label?: string) => void) {
        const wrap = (gsplatData: GSplatData) => {
            const filename = `${base.replace(/\/+$/, '').split('/').pop() || 'atlas'}.splat`;
            const asset = new Asset(filename, 'gsplat', {
                url: `atlas-${Date.now()}`,
                filename
            });
            this.app.assets.add(asset);
            asset.resource = new GSplatResource(this.app.graphicsDevice, gsplatData);
            return new Splat(asset, atlasOrientation);
        };

        // Static single-frame path: quick, keep the spinner.
        if (!animate) {
            this.events.fire('startSpinner');
            try {
                const gsplatData: GSplatData = await loadAtlasFrame(base, frameIndex);
                return wrap(gsplatData);
            } finally {
                this.events.fire('stopSpinner');
            }
        }

        // Animated path: multi-second pre-decode → drive the progress-bar overlay.
        const ownsOverlay = !onProgress;
        const label = base.replace(/\/+$/, '').split('/').pop() || 'FlexAvatar';
        if (ownsOverlay) this.events.fire('progressStart', `Loading ${label}…`);
        try {
            const { meta, frames, numSplats } = await loadAtlasAllFrames(base, (frac, lbl) => {
                if (onProgress) onProgress(frac, lbl);
                else this.events.fire('progressUpdate', { text: lbl ?? 'Loading…', progress: Math.round(frac * 100) });
            });
            const splat = wrap(frames[0]);
            splat.isAtlas = true;
            splat.atlasFrames = frames;
            splat.atlasFps = meta.fps;
            splat.atlasFrameCount = frames.length;
            // Slice C: the bake's audio track (same-origin), played in sync with this node's clip.
            splat.audioUrl = meta.audio ? `${base}${meta.audio}` : null;
            // Slice T3: remember the bake URL so the scene manifest can reload this 4D source.
            splat.atlasBase = base;
            console.log(`🎬 atlas node ready: ${numSplats} splats × ${frames.length} frames @ ${meta.fps}fps`);
            return splat;
        } finally {
            if (ownsOverlay) this.events.fire('progressEnd');
        }
    }
}

export { AssetLoader };
