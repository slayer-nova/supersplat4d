import { Events } from './events';
import { ElementType } from './element';
import { Scene } from './scene';

// Slice T3: scene-manifest export/import. Saves the composed editor scene — every gaussian object
// (static .ply/.splat, or a 4D FlexAvatar atlas bake) with its transform, plus the multi-track
// clips and timeline settings — to a small JSON, and reloads it. This is the editor's save format
// (the heavy media stays external: atlas nodes reference their bake URL, static nodes their source
// URL). Round-trip relies on the clip store's name-based reattach: clips are seeded as `pending`
// and hook up as each source re-registers by name.
//
// Manifest shape:
//   { version, type:'flexavatar-scene', fps, frames, smoothness,
//     sources:  [ { kind:'atlas'|'splat', name, url, transform:{position,rotation,scale} } ],
//     clips:    [ { sourceName, trackIndex, startFrame, sourceIn, sourceOut, timeScale, loop } ],
//     poseSets: [ { name, poses:[ { name, frame, position:[x,y,z], target:[x,y,z] } ] } ] }
// poseSets is SuperSplat's camera keyframe animation (src/camera-poses.ts): keyed camera poses →
// a looping cubic-spline flythrough that plays as the timeline advances, incl. the standalone
// player. Same shape as the native .ssproj docSerialize.poseSets, so a scene round-trips its camera
// animation through .flexscene.json too.

const registerSceneManifest = (events: Events, scene: Scene) => {
    const buildManifest = () => {
        const splats = scene.getElementsByType(ElementType.splat) as any[];
        const missingModels: string[] = [];
        const sources = splats.map((s) => {
            const p = s.entity.getLocalPosition();
            const r = s.entity.getLocalRotation();
            const sc = s.entity.getLocalScale();
            // Three source kinds, each referencing a STABLE served location so the scene reloads:
            //   atlas         -> the bake dir (atlasBase, e.g. ./bakes/<name>/)
            //   sog4d/dynamic -> the served .sog4d URL
            //   splat/static  -> the served .ply/.splat URL
            // For sog4d + static we derive that URL from the loaded asset (servedUrl): a same-origin
            // http(s) URL is kept (made relative); a locally-dropped file has no reloadable URL, so we
            // fall back to the ./models/<name> convention and flag it (the user must place the file
            // under public/models/ for the saved scene to restore it).
            const kind = s.isAtlas ? 'atlas' : (s.isDynamic ? 'sog4d' : 'splat');
            const url = s.isAtlas ? s.atlasBase : servedUrl(s, missingModels);
            return {
                kind,
                name: s.name,
                url,
                transform: {
                    position: [p.x, p.y, p.z],
                    rotation: [r.x, r.y, r.z, r.w],
                    scale: [sc.x, sc.y, sc.z]
                }
            };
        });
        const manifest = {
            version: 1,
            type: 'flexavatar-scene',
            fps: (events.invoke('timeline.frameRate') ?? 30) as number,
            frames: (events.invoke('timeline.frames') ?? 0) as number,
            smoothness: (events.invoke('timeline.smoothness') ?? 1) as number,
            sources,
            clips: (events.invoke('docSerialize.clips') ?? []) as any[],
            // Camera keyframe animation → a looping spline flythrough (see the header note).
            poseSets: (events.invoke('docSerialize.poseSets') ?? []) as any[]
        };
        return { manifest, missingModels };
    };

    // A reloadable, served URL for a non-atlas source, or the ./models/<name> convention if the file
    // was dropped locally (no persistent URL) — those names are pushed to `missing` to warn on export.
    const servedUrl = (s: any, missing: string[]): string => {
        const raw: string = s.asset?.file?.url ?? '';
        // Not reloadable: blob:/data: (dropped file) and `local-asset-*` (a synthetic id the loader
        // assigns to in-memory content, e.g. a .sog4d's derived sub-splats — there's no served file).
        if (raw && !/^(blob:|data:|local-asset)/i.test(raw)) {
            try {
                const u = new URL(raw, location.href);
                return u.origin === location.origin ? `.${u.pathname}` : raw;
            } catch (e) {
                return raw;
            }
        }
        missing.push(s.name);
        return `./models/${s.name}`;
    };

    // Programmatic access (used by tests and the import round-trip).
    events.function('flexScene.manifest', () => buildManifest().manifest);

    // --- in-app loader support (File > Load FlexAvatar…) ---

    // Discover bake folders under /bakes. The dev server (`serve`) returns a JSON directory listing
    // for Accept: application/json; fall back to an optional bakes/index.json (a plain name array).
    events.function('flexAvatar.listBakes', async () => {
        try {
            const r = await fetch('./bakes/', { headers: { Accept: 'application/json' } });
            if (r.ok) {
                const j = await r.json();
                const names = (j.files ?? [])
                    .filter((f: any) => f.type === 'folder')
                    .map((f: any) => (f.name || '').replace(/\/+$/, ''))
                    .filter(Boolean);
                if (names.length) return names;
            }
        } catch (e) { /* not a listing-capable server */ }
        try {
            const r = await fetch('./bakes/index.json');
            if (r.ok) {
                const j = await r.json();
                if (Array.isArray(j)) return j;
            }
        } catch (e) { /* no index */ }
        return [];
    });

    // Load a bake into the CURRENT scene (no reload) — same path as ?loadatlas, at runtime.
    events.function('flexAvatar.load', async (base: string) => {
        try {
            const splat = await scene.assetLoader.loadAtlas(base, 0, true);
            scene.add(splat);
            events.fire('selection', splat);
            events.fire('camera.focus');
            return splat;
        } catch (e) {
            console.error('flexAvatar.load failed:', base, e);
            return null;
        }
    });

    // Export: download the manifest as a .flexscene.json file.
    events.on('flexScene.export', () => {
        const { manifest, missingModels } = buildManifest();
        const json = JSON.stringify(manifest, null, 2);
        const blob = new Blob([json], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = 'scene.flexscene.json';
        document.body.appendChild(a);
        a.click();
        a.remove();
        setTimeout(() => URL.revokeObjectURL(url), 1000);

        // Locally-dropped objects have no stable URL — tell the user to serve them from public/models/.
        if (missingModels.length) {
            const list = missingModels.join(', ');
            console.warn(`flexScene: place under public/models/ to reload the saved scene: ${list}`);
            if (events.functions.has('showPopup')) {
                events.invoke('showPopup', {
                    type: 'info',
                    header: 'SCENE SAVED — ACTION NEEDED',
                    message: `Saved. But ${missingModels.length} locally-loaded object(s) have no stable path. Put these files under public/models/ so the saved scene can reload them:\n\n${list}`
                });
            }
        }
    });

    // Import: rebuild the scene from a manifest object. Seeds the clips first (they reattach as each
    // source re-registers by name), then loads each source and restores its transform.
    events.function('flexScene.import', async (manifest: any) => {
        if (!manifest || manifest.type !== 'flexavatar-scene') {
            throw new Error('not a flexavatar-scene manifest');
        }
        events.fire('timeline.setFrameRate', manifest.fps ?? 30);
        // Restore the timeline LENGTH + spline smoothness up front: the camera-pose flythrough spline's
        // duration IS timeline.frames and it drops keys with frame >= duration, so a wrong/zero length
        // (e.g. a clip-less camera-only scene) would silently discard the animation.
        events.fire('timeline.setFrames', manifest.frames ?? 180);
        events.fire('timeline.setSmoothness', manifest.smoothness ?? 1);
        // docDeserialize.clips is a registered function (returns), so it must be INVOKEd, not fired —
        // this seeds the clips as `pending` so they reattach as each source re-registers by name.
        events.invoke('docDeserialize.clips', manifest.clips ?? []);

        // A .sog4d loads once and recreates ALL its sub-splats, so dedupe sog4d sources by URL to
        // avoid double-loading (static/atlas are NOT deduped — repeats are distinct instances).
        const loadedSog4d = new Set<string>();
        for (const src of (manifest.sources ?? [])) {
            if (src.kind === 'sog4d') {
                if (loadedSog4d.has(src.url)) continue;
                loadedSog4d.add(src.url);
            }
            let splat: any;
            try {
                // atlas -> a bake dir; sog4d/static -> a served file (assetLoader.load dispatches by
                // the filename extension: .sog4d/.ply/.splat/.lcc).
                splat = src.kind === 'atlas'
                    ? await scene.assetLoader.loadAtlas(src.url, 0, true)
                    : await scene.assetLoader.load({ url: src.url, filename: src.name });
            } catch (e) {
                console.error('flexScene.import: failed to load source', src, e);
                continue;
            }
            scene.add(splat);
            const t = src.transform;
            if (t) {
                splat.entity.setLocalPosition(t.position[0], t.position[1], t.position[2]);
                splat.entity.setLocalRotation(t.rotation[0], t.rotation[1], t.rotation[2], t.rotation[3]);
                splat.entity.setLocalScale(t.scale[0], t.scale[1], t.scale[2]);
                splat.makeWorldBoundDirty?.();
            }
        }
        // Restore the camera keyframe animation LAST, after the timeline length has settled, so the
        // flythrough spline is built against the final duration. It then plays as the timeline advances
        // (the standalone player autoplays it; no keyframe UI needed).
        events.invoke('docDeserialize.poseSets', manifest.poseSets ?? []);
        scene.forceRender = true;
        scene.app.renderNextFrame = true;
    });
};

export { registerSceneManifest };
