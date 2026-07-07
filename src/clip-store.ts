import { Events } from './events';

// FlexAvatar editor timeline data model (Slice A of the multi-track NLE work).
//
// A SOURCE is an imported time-driven node (currently a 4D atlas Splat) that owns `frameCount`
// source frames at `fps`. A CLIP places a trimmed, speed-scaled span of one source onto the
// timeline at `startFrame`, on track row `trackIndex`. Clips on the same row must not overlap in
// time. A source is a single GPU node, so at any playhead it can only show one frame — a source
// referenced by two overlapping active clips would need instancing (deferred; v1 = lowest-track
// wins). The store is the single source of truth; nodes resolve their current source frame through
// `clip.resolve`. UI (Slice B) and audio (Slice C) build on this same store.
type Clip = {
    id: string;
    sourceId: string;      // runtime source handle (from clip.registerSource)
    sourceName: string;    // stable node name — used to reattach clips on doc load
    trackIndex: number;    // row
    startFrame: number;    // timeline frame the clip begins on
    sourceIn: number;      // first source frame (inclusive)
    sourceOut: number;     // one-past-last source frame (exclusive)
    timeScale: number;     // source frames advanced per timeline frame (1 = realtime)
    loop: boolean;         // wrap within [sourceIn, sourceOut) instead of ending (and hiding)
};

type Source = { id: string; name: string; frameCount: number; fps: number };

type Resolved = { active: boolean; localFrame: number };

const registerClipStore = (events: Events) => {
    const sources = new Map<string, Source>();
    const clips: Clip[] = [];
    // Clips from a loaded doc waiting for their source node to (re)register by name.
    const pending: Clip[] = [];
    let seq = 1;
    const genId = (p: string) => `${p}${seq++}`;

    // Timeline-frame length of a clip's placed span.
    const clipLen = (c: Clip) => Math.max(1, Math.ceil((c.sourceOut - c.sourceIn) / Math.max(1e-6, c.timeScale)));

    const timelineFps = () => (events.invoke('timeline.frameRate') ?? 30) as number;

    // The lowest track row on which [start, start+len) does not overlap an existing clip.
    const freeTrackFor = (start: number, len: number, ignoreId?: string) => {
        for (let t = 0; ; t++) {
            const overlap = clips.some(c => c.trackIndex === t && c.id !== ignoreId &&
                start < c.startFrame + clipLen(c) && c.startFrame < start + len);
            if (!overlap) return t;
        }
    };

    // Recompute the timeline length as the max clip end and (re)assert dynamic mode, so the play
    // button loops over the whole composition. Replaces the per-node timeline.setDynamic calls
    // (which clobbered each other when several nodes loaded). No clips → leave the timeline alone.
    const syncTimeline = () => {
        if (clips.length > 0) {
            let maxEnd = 1;
            for (const c of clips) maxEnd = Math.max(maxEnd, c.startFrame + clipLen(c));
            const fps = timelineFps();
            events.fire('timeline.setDynamic', maxEnd / fps, fps);
        }
        events.fire('clip.changed');
    };

    // --- source registration ------------------------------------------------

    // A node registers itself as a source. Any doc-loaded clips waiting on this name are attached;
    // if none were, a default full-range clip is created on the next free track (so a freshly
    // imported node behaves exactly like before — one clip at frame 0 spanning its whole length).
    events.function('clip.registerSource', (name: string, frameCount: number, fps: number) => {
        const id = genId('src');
        sources.set(id, { id, name, frameCount, fps });

        let attached = 0;
        for (let i = pending.length - 1; i >= 0; i--) {
            if (pending[i].sourceName === name) {
                const p = pending.splice(i, 1)[0];
                clips.push({ ...p, id: genId('clip'), sourceId: id });
                attached++;
            }
        }
        if (attached === 0) {
            const len = Math.max(1, frameCount);
            clips.push({
                id: genId('clip'), sourceId: id, sourceName: name,
                startFrame: 0, sourceIn: 0, sourceOut: len, timeScale: 1, loop: false,
                trackIndex: freeTrackFor(0, len)
            });
        }
        syncTimeline();
        return id;
    });

    events.on('clip.unregisterSource', (sourceId: string) => {
        sources.delete(sourceId);
        for (let i = clips.length - 1; i >= 0; i--) {
            if (clips[i].sourceId === sourceId) clips.splice(i, 1);
        }
        syncTimeline();
    });

    // --- clip editing (drives tests now; the timeline UI later) --------------

    events.on('clip.update', (id: string, patch: Partial<Clip>) => {
        const c = clips.find(x => x.id === id);
        if (!c) return;
        Object.assign(c, patch);
        // Clamp against the source's real frame range so trims/moves can never go out of bounds,
        // whatever the UI sends: 0 <= sourceIn < sourceOut <= frameCount, startFrame >= 0.
        const src = sources.get(c.sourceId);
        const maxF = src ? Math.max(1, src.frameCount) : Math.max(1, c.sourceOut);
        c.sourceIn = Math.min(Math.max(0, Math.round(c.sourceIn)), maxF - 1);
        c.sourceOut = Math.min(Math.max(c.sourceIn + 1, Math.round(c.sourceOut)), maxF);
        c.startFrame = Math.max(0, Math.round(c.startFrame));
        c.timeScale = Math.max(0.01, c.timeScale);
        syncTimeline();
    });

    events.on('clip.remove', (id: string) => {
        const i = clips.findIndex(x => x.id === id);
        if (i >= 0) {
            clips.splice(i, 1);
            syncTimeline();
        }
    });

    // Add another clip of an existing source (e.g. the same performance placed again at the
    // playhead). Defaults span the source's full range on the next free track.
    events.on('clip.add', (sourceId: string, opts: Partial<Clip> = {}) => {
        const src = sources.get(sourceId);
        if (!src) return;
        const len = Math.max(1, src.frameCount);
        const start = Math.max(0, Math.round(opts.startFrame ?? 0));
        const sIn = opts.sourceIn ?? 0;
        const sOut = opts.sourceOut ?? len;
        const clip: Clip = {
            id: genId('clip'), sourceId, sourceName: src.name,
            startFrame: start, sourceIn: sIn, sourceOut: sOut,
            timeScale: opts.timeScale ?? 1, loop: opts.loop ?? false,
            trackIndex: opts.trackIndex ?? freeTrackFor(start, Math.max(1, Math.ceil((sOut - sIn) / Math.max(1e-6, opts.timeScale ?? 1))))
        };
        clips.push(clip);
        syncTimeline();
    });

    events.function('clip.list', () => clips.map(c => ({ ...c })));

    // --- the resolver: global timeline frame -> this source's frame (if any) -

    // Which source frame is active for `sourceId` at `globalFrame`, or {active:false} when no clip
    // of that source covers the playhead (the node is then hidden — NLE convention). If the same
    // source is active on multiple tracks, the lowest track wins (overlapping same-source =
    // instancing, deferred).
    events.function('clip.resolve', (sourceId: string, globalFrame: number): Resolved => {
        let best: Clip | null = null;
        for (const c of clips) {
            if (c.sourceId !== sourceId) continue;
            const end = c.startFrame + clipLen(c);
            const within = c.loop
                ? globalFrame >= c.startFrame
                : (globalFrame >= c.startFrame && globalFrame < end);
            if (within && (!best || c.trackIndex < best.trackIndex)) best = c;
        }
        if (!best) return { active: false, localFrame: -1 };
        const prog = globalFrame - best.startFrame;                 // timeline frames into the clip
        const span = Math.max(1, best.sourceOut - best.sourceIn);
        let off = Math.floor(prog * best.timeScale);                // source frames advanced
        off = best.loop ? ((off % span) + span) % span : Math.min(Math.max(0, off), span - 1);
        return { active: true, localFrame: best.sourceIn + off };
    });

    // --- doc persistence -----------------------------------------------------
    // Serialize by sourceName (stable) rather than the runtime sourceId. On load, clips wait in
    // `pending` until their source node re-registers by name (see clip.registerSource).
    events.function('docSerialize.clips', () => clips.map(c => ({
        id: c.id, sourceName: c.sourceName, trackIndex: c.trackIndex, startFrame: c.startFrame,
        sourceIn: c.sourceIn, sourceOut: c.sourceOut, timeScale: c.timeScale, loop: c.loop
    })));

    events.function('docDeserialize.clips', (data: Clip[] = []) => {
        clips.length = 0;
        pending.length = 0;
        for (const c of data) pending.push({ ...c });
        syncTimeline();
    });
};

export { registerClipStore };
export type { Clip };
