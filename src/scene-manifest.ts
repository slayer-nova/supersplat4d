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
//   { version, type:'flexavatar-scene', fps, frames,
//     sources: [ { kind:'atlas'|'splat', name, url, transform:{position,rotation,scale} } ],
//     clips:   [ { sourceName, trackIndex, startFrame, sourceIn, sourceOut, timeScale, loop } ] }

const registerSceneManifest = (events: Events, scene: Scene) => {
    const buildManifest = () => {
        const splats = scene.getElementsByType(ElementType.splat) as any[];
        const sources = splats.map((s) => {
            const p = s.entity.getLocalPosition();
            const r = s.entity.getLocalRotation();
            const sc = s.entity.getLocalScale();
            return {
                kind: s.isAtlas ? 'atlas' : 'splat',
                name: s.name,
                url: s.isAtlas ? s.atlasBase : (s.asset?.file?.url ?? s.filename ?? s.name),
                transform: {
                    position: [p.x, p.y, p.z],
                    rotation: [r.x, r.y, r.z, r.w],
                    scale: [sc.x, sc.y, sc.z]
                }
            };
        });
        return {
            version: 1,
            type: 'flexavatar-scene',
            fps: (events.invoke('timeline.frameRate') ?? 30) as number,
            frames: (events.invoke('timeline.frames') ?? 0) as number,
            sources,
            clips: (events.invoke('docSerialize.clips') ?? []) as any[]
        };
    };

    // Programmatic access (used by tests and the import round-trip).
    events.function('flexScene.manifest', () => buildManifest());

    // Export: download the manifest as a .flexscene.json file.
    events.on('flexScene.export', () => {
        const json = JSON.stringify(buildManifest(), null, 2);
        const blob = new Blob([json], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = 'scene.flexscene.json';
        document.body.appendChild(a);
        a.click();
        a.remove();
        setTimeout(() => URL.revokeObjectURL(url), 1000);
    });

    // Import: rebuild the scene from a manifest object. Seeds the clips first (they reattach as each
    // source re-registers by name), then loads each source and restores its transform.
    events.function('flexScene.import', async (manifest: any) => {
        if (!manifest || manifest.type !== 'flexavatar-scene') {
            throw new Error('not a flexavatar-scene manifest');
        }
        events.fire('timeline.setFrameRate', manifest.fps ?? 30);
        // docDeserialize.clips is a registered function (returns), so it must be INVOKEd, not fired —
        // this seeds the clips as `pending` so they reattach as each source re-registers by name.
        events.invoke('docDeserialize.clips', manifest.clips ?? []);

        for (const src of (manifest.sources ?? [])) {
            let splat: any;
            try {
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
        scene.forceRender = true;
        scene.app.renderNextFrame = true;
    });
};

export { registerSceneManifest };
