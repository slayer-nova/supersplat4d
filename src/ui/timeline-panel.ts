import { Button, Container, NumericInput, SelectInput } from '@playcanvas/pcui';

import { Events } from '../events';
import { localize } from './localization';
import { Tooltips } from './tooltips';

class Ticks extends Container {
    constructor(events: Events, tooltips: Tooltips, args = {}) {
        args = {
            ...args,
            id: 'ticks'
        };

        super(args);

        const workArea = new Container({
            id: 'ticks-area'
        });

        this.append(workArea);

        let addKey: (value: number) => void;
        let removeKey: (index: number) => void;
        let frameFromOffset: (offset: number) => number;
        let moveCursor: (frame: number) => void;

        // rebuild the timeline
        const rebuild = () => {
            // clear existing labels
            workArea.dom.innerHTML = '';

            // Check if timeline functions are registered before invoking
            const numFrames = events.invoke('timeline.frames') ?? 180;
            const currentFrame = events.invoke('timeline.frame') ?? 0;

            const padding = 20;
            const width = this.dom.getBoundingClientRect().width - padding * 2;
            const labelStep = Math.max(1, Math.floor(numFrames / Math.max(1, Math.floor(width / 50))));
            const numLabels = Math.max(1, Math.ceil(numFrames / labelStep));

            const offsetFromFrame = (frame: number) => {
                return padding + Math.floor(frame / (numFrames - 1) * width);
            };

            frameFromOffset = (offset: number) => {
                return Math.max(0, Math.min(numFrames - 1, Math.floor((offset - padding) / width * (numFrames - 1))));
            };

            // timeline labels

            for (let i = 0; i < numLabels; i++) {
                const thisFrame = Math.floor(i * labelStep);
                const label = document.createElement('div');
                label.classList.add('time-label');
                label.style.left = `${offsetFromFrame(thisFrame)}px`;
                label.textContent = thisFrame.toString();
                workArea.dom.appendChild(label);
            }

            // keys

            const keys: HTMLElement[] = [];
            const createKey = (value: number) => {
                const label = document.createElement('div');
                label.classList.add('time-label', 'key');
                label.style.left = `${offsetFromFrame(value)}px`;
                let dragging = false;
                let toFrame = -1;

                label.addEventListener('pointerdown', (event) => {
                    if (!dragging && event.isPrimary) {
                        dragging = true;
                        label.classList.add('dragging');
                        label.setPointerCapture(event.pointerId);
                        event.stopPropagation();
                    }
                });

                label.addEventListener('pointermove', (event: PointerEvent) => {
                    if (dragging) {
                        toFrame = frameFromOffset(parseInt(label.style.left, 10) + event.offsetX);
                        label.style.left = `${offsetFromFrame(toFrame)}px`;
                    }
                });

                label.addEventListener('pointerup', (event: PointerEvent) => {
                    if (dragging && event.isPrimary) {
                        const fromIndex = keys.indexOf(label);
                        const fromFrame = events.invoke('timeline.keys')[fromIndex];
                        if (fromFrame !== toFrame) {
                            events.fire('timeline.move', fromFrame, toFrame);
                            events.fire('timeline.frame', events.invoke('timeline.frame'));
                        }

                        label.releasePointerCapture(event.pointerId);
                        label.classList.remove('dragging');
                        dragging = false;
                    }
                });

                workArea.dom.appendChild(label);
                keys.push(label);
            };

            const timelineKeys = events.invoke('timeline.keys') as number[];
            if (timelineKeys && Array.isArray(timelineKeys)) {
                timelineKeys.forEach(createKey);
            }

            addKey = (value: number) => {
                createKey(value);
            };

            removeKey = (index: number) => {
                workArea.dom.removeChild(keys[index]);
                keys.splice(index, 1);
            };

            // cursor

            const cursor = document.createElement('div');
            cursor.classList.add('time-label', 'cursor');
            cursor.style.left = `${offsetFromFrame(currentFrame)}px`;
            cursor.textContent = currentFrame.toString();
            workArea.dom.appendChild(cursor);

            moveCursor = (frame: number) => {
                cursor.style.left = `${offsetFromFrame(frame)}px`;
                cursor.textContent = frame.toString();
            };
        };

        // handle scrubbing

        let scrubbing = false;

        workArea.dom.addEventListener('pointerdown', (event: PointerEvent) => {
            if (!scrubbing && event.isPrimary) {
                scrubbing = true;
                workArea.dom.setPointerCapture(event.pointerId);
                events.fire('timeline.setFrame', frameFromOffset(event.offsetX));
            }
        });

        workArea.dom.addEventListener('pointermove', (event: PointerEvent) => {
            if (scrubbing) {
                events.fire('timeline.setFrame', frameFromOffset(event.offsetX));
            }
        });

        workArea.dom.addEventListener('pointerup', (event: PointerEvent) => {
            if (scrubbing && event.isPrimary) {
                workArea.dom.releasePointerCapture(event.pointerId);
                scrubbing = false;
            }
        });

        // rebuild the timeline on dom resize
        // Delay initial observation to ensure timeline events are registered
        const resizeObserver = new ResizeObserver(() => {
            // Only rebuild if timeline functions are available
            if (events.functions.has('timeline.frames')) {
                rebuild();
            }
        });
        // Use requestAnimationFrame to delay observation until after timeline registration
        requestAnimationFrame(() => {
            resizeObserver.observe(workArea.dom);
            // Initial rebuild after timeline is registered
            if (events.functions.has('timeline.frames')) {
                rebuild();
            }
        });

        // rebuild when timeline frames change
        events.on('timeline.frames', () => {
            rebuild();
        });

        events.on('timeline.frame', (frame: number) => {
            moveCursor(frame);
        });

        events.on('timeline.keyAdded', (value: number) => {
            addKey(value);
        });

        events.on('timeline.keyRemoved', (index: number) => {
            removeKey(index);
        });
    }
}

class TimelinePanel extends Container {
    constructor(events: Events, tooltips: Tooltips, args: { isMobile?: boolean } = {}) {
        const isMobile = args.isMobile || false;
        const containerArgs = {
            ...args,
            id: 'timeline-panel'
        };
        // Remove isMobile from containerArgs
        delete (containerArgs as any).isMobile;

        super(containerArgs);
        
        // Add mobile class for CSS targeting
        if (isMobile) {
            this.dom.classList.add('mobile-timeline');
        }

        // play controls
        const play = new Button({
            class: 'button',
            text: '\uE131'
        });

        // Desktop-only buttons
        let prev: Button | null = null;
        let next: Button | null = null;
        let addKey: Button | null = null;
        let removeKey: Button | null = null;
        let miniStatsToggle: Button | null = null;

        if (!isMobile) {
            prev = new Button({
                class: 'button',
                text: '\uE162'
            });

            next = new Button({
                class: 'button',
                text: '\uE164'
            });

            addKey = new Button({
                class: 'button',
                text: '\uE120'
            });

            removeKey = new Button({
                class: 'button',
                text: '\uE121',
                enabled: false
            });
        } else {
            miniStatsToggle = new Button({
                class: ['button', 'mini-stats-button'],
                text: 'FPS'
            });
        }

        const buttonControls = new Container({
            id: 'button-controls'
        });
        
        // On mobile, only show play button; on desktop, show all buttons
        if (isMobile) {
            buttonControls.append(play);
        } else {
            buttonControls.append(prev!);
            buttonControls.append(play);
            buttonControls.append(next!);
            buttonControls.append(addKey!);
            buttonControls.append(removeKey!);
        }

        // settings

        const speed = new SelectInput({
            id: 'speed',
            defaultValue: 30,
            options: [
                { v: 1, t: '1 fps' },
                { v: 6, t: '6 fps' },
                { v: 12, t: '12 fps' },
                { v: 24, t: '24 fps' },
                { v: 30, t: '30 fps' },
                { v: 60, t: '60 fps' }
            ]
        });

        speed.on('change', (value: string) => {
            events.fire('timeline.setFrameRate', parseInt(value, 10));
        });

        events.on('timeline.frameRate', (frameRate: number) => {
            speed.value = frameRate.toString();
        });

        // Desktop-only settings
        let frames: NumericInput | null = null;
        let smoothness: NumericInput | null = null;

        if (!isMobile) {
            frames = new NumericInput({
                id: 'totalFrames',
                value: 180,
                min: 1,
                max: 10000,
                precision: 0
            });

            frames.on('change', (value: number) => {
                events.fire('timeline.setFrames', value);
            });

            events.on('timeline.frames', (framesIn: number) => {
                frames!.value = framesIn;
            });

            smoothness = new NumericInput({
                id: 'smoothness',
                min: 0,
                max: 1,
                step: 0.05,
                value: 1
            });

            smoothness.on('change', (value: number) => {
                events.fire('timeline.setSmoothness', value);
            });

            events.on('timeline.smoothness', (smoothnessIn: number) => {
                smoothness!.value = smoothnessIn;
            });
        }

        const settingsControls = new Container({
            id: 'settings-controls'
        });
        
        // On mobile, only show frame rate (speed); on desktop, show all settings
        settingsControls.append(speed);
        if (!isMobile) {
            settingsControls.append(frames!);
            settingsControls.append(smoothness!);
        }

        // append control groups

        const controlsWrap = new Container({
            id: 'controls-wrap'
        });

        // Layout: play button in center, settings on right (same for mobile and desktop)
        const spacerL = new Container({
            class: 'spacer'
        });
        const spacerR = new Container({
            class: 'spacer'
        });
        if (isMobile && miniStatsToggle) {
            spacerL.append(miniStatsToggle);
        }
        spacerR.append(settingsControls);
        
        controlsWrap.append(spacerL);
        controlsWrap.append(buttonControls);
        controlsWrap.append(spacerR);

        const ticks = new Ticks(events, tooltips);

        // ---- multi-track timeline body (NLE): left name gutter + ruler + stacked track lanes ----
        // The ruler (Ticks) and every track lane are equal-width flex cells sitting to the right of
        // a fixed-width gutter, so clip bars line up with the frame ruler by construction. Bars are
        // rendered from the clip store (clip.list) and rebuilt on clip.changed; the playhead is a
        // vertical line through the lanes. B1 = render + scrub only (drag/trim/select come next).
        const GUTTER_W = 92;
        const PAD = 20; // must match Ticks' offsetFromFrame padding so bars align with the ruler

        // Stable per-source colour (hash the name to a hue) so each object's clips read as one group.
        const colorForSource = (name: string) => {
            let h = 0;
            for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) >>> 0;
            return `hsl(${h % 360}, 42%, 42%)`;
        };
        const shortName = (name: string) => name.replace(/\.(splat|sog4d|ply|lcc)$/i, '');
        const tlFps = () => (events.invoke('timeline.frameRate') ?? 30) as number;
        // Per-bake fps: a clip's timeline width = (sourceFrames × timelineFps) / (sourceFps × timeScale)
        // — matches the clip store's math so bars align with playback (a 15fps clip is 2× wide at 30fps).
        const spanLen = (sourceIn: number, sourceOut: number, timeScale: number, sourceFps: number) =>
            Math.max(1, Math.ceil((sourceOut - sourceIn) * tlFps() / (Math.max(1, sourceFps) * Math.max(1e-6, timeScale))));
        const clipLen = (c: any) => spanLen(c.sourceIn, c.sourceOut, c.timeScale, c.sourceFps ?? 30);

        // ruler row: gutter spacer + the existing Ticks ruler (moved into a lane-wrap)
        const rulerRow = document.createElement('div');
        rulerRow.className = 'tl-ruler-row';
        const rulerGutter = document.createElement('div');
        rulerGutter.className = 'tl-gutter tl-gutter-head';
        const rulerLaneWrap = document.createElement('div');
        rulerLaneWrap.className = 'tl-lane-wrap';
        rulerLaneWrap.appendChild(ticks.dom);
        rulerRow.appendChild(rulerGutter);
        rulerRow.appendChild(rulerLaneWrap);

        // track rows (rebuilt from the clip store) and the playhead line
        const trackList = document.createElement('div');
        trackList.className = 'tl-track-list';
        const playhead = document.createElement('div');
        playhead.className = 'tl-playhead';

        const body = document.createElement('div');
        body.className = 'tl-body';
        body.appendChild(rulerRow);
        body.appendChild(trackList);
        body.appendChild(playhead);

        const laneWidth = () => Math.max(1, rulerLaneWrap.clientWidth - PAD * 2);
        const numFrames = () => Math.max(2, (events.invoke('timeline.frames') ?? 180) as number);
        const xOfFrame = (frame: number) => PAD + (frame / (numFrames() - 1)) * laneWidth();

        const updatePlayhead = (frame: number) => {
            playhead.style.left = `${GUTTER_W + xOfFrame(frame)}px`;
        };

        const framesPerPx = () => (numFrames() - 1) / laneWidth();

        // Snap a candidate start frame to nearby magnets — 0, the playhead, and every OTHER clip's
        // start/end edge (for our start butting to them, or our end butting to them) — within an
        // ~8px threshold. Returns an integer frame >= 0.
        const snapStart = (rawStart: number, len: number, selfId: string) => {
            const others = (events.invoke('clip.list') ?? []) as any[];
            const playFrame = (events.invoke('timeline.frame') ?? 0) as number;
            const targets = [0, playFrame];
            for (const o of others) {
                if (o.id === selfId) continue;
                const oEnd = o.startFrame + clipLen(o);
                targets.push(o.startFrame, oEnd, o.startFrame - len, oEnd - len);
            }
            const snap = Math.max(1, Math.round(8 * framesPerPx()));
            let best = rawStart;
            let bestD = snap + 1;
            for (const t of targets) {
                const d = Math.abs(rawStart - t);
                if (d <= snap && d < bestD) {
                    best = t;
                    bestD = d;
                }
            }
            return Math.max(0, Math.round(best));
        };

        // Would placing [start, start+len) on `track` collide with another clip already there?
        const overlaps = (track: number, start: number, len: number, selfId: string) => {
            const clips = (events.invoke('clip.list') ?? []) as any[];
            return clips.some(o => o.id !== selfId && o.trackIndex === track &&
                start < o.startFrame + clipLen(o) && o.startFrame < start + len);
        };

        // ---- B4: selection + per-clip inspector (loop / speed / add / delete) ----
        let selectedClipId: string | null = null;
        const findClip = (id: string | null) => (events.invoke('clip.list') ?? []).find((c: any) => c.id === id);

        const inspector = document.createElement('div');
        inspector.className = 'tl-inspector';
        inspector.style.display = 'none';
        const inspName = document.createElement('span');
        inspName.className = 'tl-insp-name';
        const loopLabel = document.createElement('label');
        loopLabel.className = 'tl-insp-field';
        const loopCb = document.createElement('input');
        loopCb.type = 'checkbox';
        loopLabel.append(loopCb, document.createTextNode(' loop'));
        const speedLabel = document.createElement('label');
        speedLabel.className = 'tl-insp-field';
        const speedIn = document.createElement('input');
        speedIn.type = 'number';
        speedIn.min = '0.1';
        speedIn.max = '8';
        speedIn.step = '0.1';
        speedIn.className = 'tl-insp-speed';
        speedLabel.append(document.createTextNode('speed '), speedIn);
        const inspRange = document.createElement('span');
        inspRange.className = 'tl-insp-range';
        const addBtn = document.createElement('button');
        addBtn.className = 'tl-insp-btn';
        addBtn.textContent = '＋ clip';
        const delBtn = document.createElement('button');
        delBtn.className = 'tl-insp-btn tl-insp-del';
        delBtn.textContent = '✕ delete';
        inspector.append(inspName, loopLabel, speedLabel, inspRange, addBtn, delBtn);

        const refreshInspector = () => {
            const c = findClip(selectedClipId);
            if (!c) {
                inspector.style.display = 'none';
                return;
            }
            inspector.style.display = 'flex';
            inspName.textContent = shortName(c.sourceName);
            loopCb.checked = !!c.loop;
            speedIn.value = String(c.timeScale);
            inspRange.textContent = `src ${c.sourceIn}–${c.sourceOut} · @${c.startFrame} · trk ${c.trackIndex + 1}`;
        };

        const selectClip = (id: string | null) => {
            selectedClipId = id;
            trackList.querySelectorAll('.tl-clip').forEach((el) => {
                el.classList.toggle('selected', (el as HTMLElement).dataset.clipId === id);
            });
            refreshInspector();
        };

        loopCb.addEventListener('change', () => {
            if (selectedClipId) events.fire('clip.update', selectedClipId, { loop: loopCb.checked });
        });
        speedIn.addEventListener('change', () => {
            const v = parseFloat(speedIn.value);
            if (selectedClipId && v > 0) events.fire('clip.update', selectedClipId, { timeScale: v });
        });
        delBtn.addEventListener('click', () => {
            if (selectedClipId) {
                events.fire('clip.remove', selectedClipId);
                selectClip(null);
            }
        });
        addBtn.addEventListener('click', () => {
            const c = findClip(selectedClipId);
            if (c) events.fire('clip.add', c.sourceId, { startFrame: events.invoke('timeline.frame') ?? 0 });
        });

        // B2/B5: drag a clip body to change its startFrame (snapped) and, vertically, its track row
        // (cross-track, with overlap prevention). A plain click (no drag) selects the clip. Trim
        // handles are excluded. The bar moves live; the store update fires once, on release.
        const attachClipDrag = (bar: HTMLElement, c: any) => {
            bar.addEventListener('pointerdown', (e: PointerEvent) => {
                if (!e.isPrimary) return;
                if ((e.target as HTMLElement).classList.contains('tl-trim')) return;
                e.stopPropagation();
                const startX = e.clientX;
                const startY = e.clientY;
                const origStart = c.startFrame;
                const origTrack = c.trackIndex;
                const len = clipLen(c);
                const fpp = framesPerPx();
                const listTop = trackList.getBoundingClientRect().top;
                const rowH = 28;
                const numTracks = trackList.children.length;
                let newStart = origStart;
                let targetTrack = origTrack;
                let didMove = false;
                bar.setPointerCapture(e.pointerId);

                const onMove = (ev: PointerEvent) => {
                    if (!didMove && (Math.abs(ev.clientX - startX) > 3 || Math.abs(ev.clientY - startY) > 3)) {
                        didMove = true;
                        bar.classList.add('dragging');
                    }
                    newStart = snapStart(origStart + (ev.clientX - startX) * fpp, len, c.id);
                    bar.style.left = `${xOfFrame(newStart)}px`;
                    targetTrack = Math.max(0, Math.min(numTracks, Math.floor((ev.clientY - listTop) / rowH)));
                    Array.from(trackList.children).forEach((row, i) =>
                        (row as HTMLElement).classList.toggle('drop-target', didMove && i === targetTrack && targetTrack !== origTrack));
                };
                const onUp = (ev: PointerEvent) => {
                    bar.releasePointerCapture(ev.pointerId);
                    bar.classList.remove('dragging');
                    bar.removeEventListener('pointermove', onMove);
                    bar.removeEventListener('pointerup', onUp);
                    Array.from(trackList.children).forEach(row => (row as HTMLElement).classList.remove('drop-target'));
                    if (!didMove) {
                        selectClip(c.id);
                        return;
                    }
                    const patch: any = { startFrame: newStart };
                    if (targetTrack !== origTrack && !overlaps(targetTrack, newStart, len, c.id)) {
                        patch.trackIndex = targetTrack;
                    }
                    events.fire('clip.update', c.id, patch);
                    selectClip(c.id);
                };
                bar.addEventListener('pointermove', onMove);
                bar.addEventListener('pointerup', onUp);
            });
        };

        // B3: drag a clip's left/right edge handle to trim. The left handle moves the in-point
        // (sourceIn) AND the timeline start together so the content stays anchored (NLE ripple-free
        // trim-in); the right handle moves the out-point (sourceOut). The store clamps both to the
        // source's real [0, frameCount] range on commit. Bar resizes live; commit fires on release.
        const attachTrimDrag = (handle: HTMLElement, bar: HTMLElement, c: any, side: 'l' | 'r') => {
            handle.addEventListener('pointerdown', (e: PointerEvent) => {
                if (!e.isPrimary) return;
                e.stopPropagation();
                const startX = e.clientX;
                const fpp = framesPerPx();
                const ts = Math.max(1e-6, c.timeScale);
                const sourceFps = Math.max(1, c.sourceFps ?? 30);
                const k = ts * sourceFps / tlFps(); // source frames advanced per timeline frame
                const origStart = c.startFrame;
                const origIn = c.sourceIn;
                const origOut = c.sourceOut;
                let patch: any = null;
                handle.setPointerCapture(e.pointerId);
                bar.classList.add('dragging');

                const applyVisual = (start: number, inn: number, out: number) => {
                    const len = spanLen(inn, out, ts, sourceFps);
                    bar.style.left = `${xOfFrame(start)}px`;
                    bar.style.width = `${Math.max(6, xOfFrame(start + len) - xOfFrame(start))}px`;
                };

                const onMove = (ev: PointerEvent) => {
                    const dTl = Math.round((ev.clientX - startX) * fpp);
                    if (side === 'l') {
                        const inn = Math.min(Math.max(0, Math.round(origIn + dTl * k)), origOut - 1);
                        const start = Math.max(0, origStart + Math.round((inn - origIn) / k));
                        patch = { startFrame: start, sourceIn: inn };
                        applyVisual(start, inn, origOut);
                    } else {
                        const out = Math.max(origIn + 1, Math.round(origOut + dTl * k));
                        patch = { sourceOut: out };
                        applyVisual(origStart, origIn, out);
                    }
                };
                const onUp = (ev: PointerEvent) => {
                    handle.releasePointerCapture(ev.pointerId);
                    bar.classList.remove('dragging');
                    handle.removeEventListener('pointermove', onMove);
                    handle.removeEventListener('pointerup', onUp);
                    if (patch) events.fire('clip.update', c.id, patch);
                };
                handle.addEventListener('pointermove', onMove);
                handle.addEventListener('pointerup', onUp);
            });
        };

        const rebuildTracks = () => {
            trackList.innerHTML = '';
            const clips = (events.invoke('clip.list') ?? []) as any[];
            const numTracks = clips.reduce((m, c) => Math.max(m, c.trackIndex + 1), 1);

            for (let t = 0; t < numTracks; t++) {
                const rowClips = clips.filter(c => c.trackIndex === t);

                const row = document.createElement('div');
                row.className = 'tl-track-row';

                const gutter = document.createElement('div');
                gutter.className = 'tl-gutter tl-track-label';
                gutter.textContent = rowClips.length ? shortName(rowClips[0].sourceName) : `Track ${t + 1}`;

                const lane = document.createElement('div');
                lane.className = 'tl-lane';
                lane.addEventListener('pointerdown', (ev) => {
                    if (ev.target === lane) selectClip(null); // click empty lane = deselect
                });

                for (const c of rowClips) {
                    const x0 = xOfFrame(c.startFrame);
                    const x1 = xOfFrame(c.startFrame + clipLen(c));
                    const bar = document.createElement('div');
                    bar.className = 'tl-clip';
                    bar.dataset.clipId = c.id;
                    if (c.id === selectedClipId) bar.classList.add('selected');
                    bar.style.left = `${x0}px`;
                    bar.style.width = `${Math.max(6, x1 - x0)}px`;
                    bar.style.backgroundColor = colorForSource(c.sourceName);

                    const trimL = document.createElement('div');
                    trimL.className = 'tl-trim tl-trim-l';
                    const label = document.createElement('span');
                    label.className = 'tl-clip-label';
                    label.textContent = shortName(c.sourceName);
                    const trimR = document.createElement('div');
                    trimR.className = 'tl-trim tl-trim-r';

                    bar.append(trimL, label, trimR);
                    attachClipDrag(bar, c);
                    attachTrimDrag(trimL, bar, c, 'l');
                    attachTrimDrag(trimR, bar, c, 'r');
                    lane.appendChild(bar);
                }

                row.append(gutter, lane);
                trackList.appendChild(row);
            }
            updatePlayhead((events.invoke('timeline.frame') ?? 0) as number);
        };

        // Resizable timeline: a drag handle on the panel's top edge adjusts the (scrollable)
        // track-list height, growing/shrinking the whole panel — the viewport above flexes to fit.
        // The track-list scrolls vertically once there are more tracks than the set height shows.
        const resizeHandle = document.createElement('div');
        resizeHandle.className = 'tl-resize';
        let trackListH = 96; // default ~3 rows visible, then scroll
        trackList.style.height = `${trackListH}px`;
        resizeHandle.addEventListener('pointerdown', (e: PointerEvent) => {
            if (!e.isPrimary) return;
            e.preventDefault();
            const startY = e.clientY;
            const startH = trackListH;
            resizeHandle.setPointerCapture(e.pointerId);
            resizeHandle.classList.add('dragging');
            const onMove = (ev: PointerEvent) => {
                const maxH = Math.round(window.innerHeight * 0.6);
                trackListH = Math.max(28, Math.min(maxH, startH - (ev.clientY - startY))); // drag up = taller
                trackList.style.height = `${trackListH}px`;
            };
            const onUp = (ev: PointerEvent) => {
                resizeHandle.releasePointerCapture(ev.pointerId);
                resizeHandle.classList.remove('dragging');
                resizeHandle.removeEventListener('pointermove', onMove);
                resizeHandle.removeEventListener('pointerup', onUp);
            };
            resizeHandle.addEventListener('pointermove', onMove);
            resizeHandle.addEventListener('pointerup', onUp);
        });

        this.append(controlsWrap);
        this.dom.appendChild(inspector);
        this.dom.appendChild(body);
        this.dom.insertBefore(resizeHandle, this.dom.firstChild); // handle sits at the very top edge

        // rebuild bars when clips change or the timeline length changes; move the playhead per frame
        events.on('clip.changed', () => {
            rebuildTracks();
            refreshInspector();
        });
        events.on('timeline.frames', () => rebuildTracks());
        events.on('timeline.frame', (frame: number) => updatePlayhead(frame));
        const trackResize = new ResizeObserver(() => rebuildTracks());
        requestAnimationFrame(() => {
            trackResize.observe(rulerLaneWrap);
            rebuildTracks();
        });

        // ui handlers

        const skip = (dir: 'forward' | 'back') => {
            const orderedKeys = (events.invoke('timeline.keys') as number[]).map((frame, index) => {
                return { frame, index };
            }).sort((a, b) => a.frame - b.frame);

            if (orderedKeys.length > 0) {
                const frame = events.invoke('timeline.frame');
                const nextKey = orderedKeys.findIndex(k => (dir === 'back' ? k.frame >= frame : k.frame > frame));
                const l = orderedKeys.length;

                if (nextKey === -1) {
                    events.fire('timeline.setFrame', orderedKeys[dir === 'back' ? l - 1 : 0].frame);
                } else {
                    events.fire('timeline.setFrame', orderedKeys[dir === 'back' ? (nextKey + l - 1) % l : nextKey].frame);
                }
            } else {
                // if there are no keys, just to start of timeline or end
                if (dir === 'back') {
                    events.fire('timeline.setFrame', 0);
                } else {
                    const maxFrames = events.invoke('timeline.frames');
                    if (maxFrames !== undefined) {
                        events.fire('timeline.setFrame', maxFrames - 1);
                    }
                }
            }
        };

        // Only attach event handlers for buttons that exist (desktop only)
        if (!isMobile && prev && next && addKey && removeKey) {
            prev.on('click', () => {
                skip('back');
            });

            next.on('click', () => {
                skip('forward');
            });

            addKey.on('click', () => {
                events.fire('timeline.add', events.invoke('timeline.frame'));
            });

            removeKey.on('click', () => {
                const index = events.invoke('timeline.keys').indexOf(events.invoke('timeline.frame'));
                if (index !== -1) {
                    events.fire('timeline.remove', index);
                    events.fire('timeline.frame', events.invoke('timeline.frame'));
                }
            });

            const canDelete = (frame: number) => events.invoke('timeline.keys').includes(frame);

            events.on('timeline.frame', (frame: number) => {
                removeKey.enabled = canDelete(frame);
            });

            events.on('timeline.keyRemoved', (index: number) => {
                removeKey.enabled = canDelete(events.invoke('timeline.frame'));
            });

            events.on('timeline.keyAdded', (frame: number) => {
                removeKey.enabled = canDelete(frame);
            });
        }

        play.on('click', () => {
            if (events.invoke('timeline.playing')) {
                events.fire('timeline.setPlaying', false);
                play.text = '\uE131';
            } else {
                events.fire('timeline.setPlaying', true);
                play.text = '\uE135';
            }
        });

        // cancel animation playback if user interacts with camera
        events.on('camera.controller', (type: string) => {
            if (events.invoke('timeline.playing')) {
                // stop
            }
        });

        // tooltips
        tooltips.register(play, localize('tooltip.timeline.play'), 'top');
        tooltips.register(speed, localize('tooltip.timeline.frame-rate'), 'top');

        if (isMobile && miniStatsToggle) {
            miniStatsToggle.on('click', () => {
                events.fire('miniStats.toggleVisible');
            });

            const updateMiniStatsButton = (visible: boolean) => {
                miniStatsToggle!.class[visible ? 'add' : 'remove']('active');
            };

            events.on('miniStats.visibility', updateMiniStatsButton);
            tooltips.register(miniStatsToggle, 'Toggle performance panel', 'top');
        }
        
        if (!isMobile && prev && next && addKey && removeKey && frames && smoothness) {
            tooltips.register(prev, localize('tooltip.timeline.prev-key'), 'top');
            tooltips.register(next, localize('tooltip.timeline.next-key'), 'top');
            tooltips.register(addKey, localize('tooltip.timeline.add-key'), 'top');
            tooltips.register(removeKey, localize('tooltip.timeline.remove-key'), 'top');
            tooltips.register(frames, localize('tooltip.timeline.total-frames'), 'top');
            tooltips.register(smoothness, localize('tooltip.timeline.smoothness'), 'top');
        }
    }
}

export { TimelinePanel };
