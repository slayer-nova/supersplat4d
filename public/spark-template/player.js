// FlexAvatar · Spark player — self-contained, offline, progressive 3DGS playback.
//
// Loads a package produced by the SuperSplat editor's "Export Spark Player" (see DESIGN.md).
// Two package layouts, dispatched on manifest.json "version":
//   v1 (no version) — single avatar: frames/frame_%04d.spz (HEAD, individual) + rest.zip (TAIL)
//     + audio.m4a. Frame 0 shows in ~50 ms and playback starts at once; the TAIL arrives in the
//     background and the loop expands to the full clip.
//   v2 (version: 2) — whole scene: objects/<id>.spz statics + objects/<id>/{frames/,rest.zip}
//     animated objects, transforms baked at export so everything loads at identity into one root
//     group. Playback starts after statics + all HEAD frames; TAILs then stream per object.
// One SplatMesh per frame per animated object, cycled by visibility at that object's fps; the
// audio-owning object drives its frame index from the soundtrack so A/V stay in sync.

import * as THREE from 'three';
import { SparkRenderer, SplatMesh, SparkControls, textSplats, dyno } from '@sparkjsdev/spark';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import JSZip from 'jszip';

// ---- CubicSpline — verbatim port of the editor's src/anim/spline.ts (TS types stripped) ----
class CubicSpline {
    // control times
    times;

    // control data: in-tangent, point, out-tangent
    knots;

    // dimension of the knot points
    dim;

    constructor(times, knots) {
        this.times = times;
        this.knots = knots;
        this.dim = knots.length / times.length / 3;
    }

    evaluate(time, result) {
        const { times } = this;
        const last = times.length - 1;

        if (time <= times[0]) {
            this.getKnot(0, result);
        } else if (time >= times[last]) {
            this.getKnot(last, result);
        } else {
            let seg = 0;
            while (time >= times[seg + 1]) {
                seg++;
            }
            this.evaluateSegment(seg, (time - times[seg]) / (times[seg + 1] - times[seg]), result);
        }
    }

    getKnot(index, result) {
        const { knots, dim } = this;
        const idx = index * 3 * dim;
        for (let i = 0; i < dim; ++i) {
            result[i] = knots[idx + i * 3 + 1];
        }
    }

    // evaluate the spline segment at the given normalized time t
    evaluateSegment(segment, t, result) {
        const { knots, dim } = this;

        const t2 = t * t;
        const twot = t + t;
        const omt = 1 - t;
        const omt2 = omt * omt;

        let idx = segment * dim * 3;                    // each knot has 3 values: tangent in, value, tangent out
        for (let i = 0; i < dim; ++i) {
            const p0 = knots[idx + 1];                  // p0
            const m0 = knots[idx + 2];                  // outgoing tangent
            const m1 = knots[idx + dim * 3];            // incoming tangent
            const p1 = knots[idx + dim * 3 + 1];        // p1
            idx += 3;

            result[i] =
                p0 * ((1 + twot) * omt2) +
                m0 * (t * omt2) +
                p1 * (t2 * (3 - twot)) +
                m1 * (t2 * (t - 1));
        }
    }

    // calculate cubic spline knots from points
    // times: time values for each control point
    // points: control point values to be interpolated (n dimensional)
    // smoothness: 0 = linear, 1 = smooth
    static calcKnots(times, points, smoothness) {
        const n = times.length;
        const dim = points.length / n;
        const knots = new Array(n * dim * 3);

        for (let i = 0; i < n; i++) {
            const t = times[i];

            for (let j = 0; j < dim; j++) {
                const idx = i * dim + j;
                const p = points[idx];

                let tangent;
                if (i === 0) {
                    tangent = (points[idx + dim] - p) / (times[i + 1] - t);
                } else if (i === n - 1) {
                    tangent = (p - points[idx - dim]) / (t - times[i - 1]);
                } else {
                    tangent = (points[idx + dim] - points[idx - dim]) / (times[i + 1] - times[i - 1]);
                }

                // convert to derivatives w.r.t normalized segment parameter
                const inScale = i > 0 ? (times[i] - times[i - 1]) : (times[1] - times[0]);
                const outScale = i < n - 1 ? (times[i + 1] - times[i]) : (times[i] - times[i - 1]);

                knots[idx * 3] = tangent * inScale * smoothness;
                knots[idx * 3 + 1] = p;
                knots[idx * 3 + 2] = tangent * outScale * smoothness;
            }
        }

        return knots;
    }

    static fromPoints(times, points, smoothness = 1) {
        return new CubicSpline(times, CubicSpline.calcKnots(times, points, smoothness));
    }

    // create a looping spline by duplicating animation points at the end and beginning
    static fromPointsLooping(length, times, points, smoothness = 1) {
        if (times.length < 2) {
            return CubicSpline.fromPoints(times, points);
        }

        const dim = points.length / times.length;
        const newTimes = times.slice();
        const newPoints = points.slice();

        // append first two points
        newTimes.push(length + times[0], length + times[1]);
        newPoints.push(...points.slice(0, dim * 2));

        // prepend last two points
        newTimes.splice(0, 0, times[times.length - 2] - length, times[times.length - 1] - length);
        newPoints.splice(0, 0, ...points.slice(points.length - dim * 2));

        return CubicSpline.fromPoints(newTimes, newPoints, smoothness);
    }
}

const viewer = document.getElementById('viewer');
const loadEl = document.getElementById('load');
const loadLabel = document.getElementById('load-label');
const loadBar = document.getElementById('load-bar');
const soundEl = document.getElementById('sound');
function updateSound() { if (soundEl && audioEl) soundEl.textContent = audioEl.muted ? '🔇' : '🔊'; }
const errEl = document.getElementById('err');
const fail = (m) => { errEl.style.display = 'grid'; errEl.textContent = 'Could not load avatar: ' + m; console.error(m); };

// ---- three + spark scene -------------------------------------------------
const camera = new THREE.PerspectiveCamera(20, viewer.offsetWidth / viewer.offsetHeight, 0.01, 100);
camera.position.set(0, 0, 0.95); // FLEX heads: ~0.5u tall at origin, sub-mm splats → sit close
const renderer = new THREE.WebGLRenderer({ antialias: false, alpha: true }); // alpha → AR passthrough
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.setSize(viewer.offsetWidth, viewer.offsetHeight);
renderer.xr.enabled = true; // WebXR: Spark renders splats per-eye in an immersive session
viewer.appendChild(renderer.domElement);

// Our own Enter VR / Enter AR buttons — request the session directly (three's VRButton/ARButton
// overlapped and disabled awkwardly). Each is enabled only if the headset supports that mode; on a
// non-XR desktop they read "VR n/a" / "AR n/a", disabled. VR = black void; AR = passthrough.
const enterXR = async (mode) => {
  if (!navigator.xr) return;
  try {
    const session = await navigator.xr.requestSession(mode, {
      optionalFeatures: ['local-floor', 'bounded-floor', 'hand-tracking', 'dom-overlay'],
      domOverlay: { root: document.body }   // lets our DOM Recenter button show + be tappable in mobile AR
    });
    renderer.xr.setReferenceSpaceType('local-floor');
    await renderer.xr.setSession(session);
  } catch (e) { console.warn('XR session failed', mode, e); }
};
const vrBtn = document.getElementById('enter-vr');
const arBtn = document.getElementById('enter-ar');
vrBtn.addEventListener('click', () => enterXR('immersive-vr'));
arBtn.addEventListener('click', () => enterXR('immersive-ar'));
if (navigator.xr) {
  navigator.xr.isSessionSupported('immersive-vr').then((ok) => { vrBtn.disabled = !ok; vrBtn.textContent = ok ? 'Enter VR' : 'VR n/a'; }).catch(() => {});
  navigator.xr.isSessionSupported('immersive-ar').then((ok) => { arBtn.disabled = !ok; arBtn.textContent = ok ? 'Enter AR' : 'AR n/a'; }).catch(() => {});
} else { vrBtn.textContent = 'VR n/a'; arBtn.textContent = 'AR n/a'; }

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x111111);
scene.add(new SparkRenderer({ renderer })); // required for splats to draw

const group = new THREE.Group(); // our atlas .spz is already Y-up in three → identity
scene.add(group);

const controls = new OrbitControls(camera, renderer.domElement);
controls.target.set(0, -0.05, 0);
controls.enablePan = false;
controls.enableDamping = true;
controls.minDistance = 0.4;
controls.maxDistance = 2.0;
controls.update();

// ---- WebXR: passthrough + controller grab/scale/rotate --------------------
const DARK = new THREE.Color(0x111111);
const xrUI = document.getElementById('xr');
const recenterBtn = document.getElementById('recenter');
const _cp = new THREE.Vector3(), _cd = new THREE.Vector3();
const isPassthrough = () => {
  const s = renderer.xr.getSession();
  try { return !!s && s.environmentBlendMode && s.environmentBlendMode !== 'opaque'; } catch (e) { return false; }
};

// Controllers — grip(squeeze) to grab (move+rotate); both grips to scale+rotate+move; A/X/B/Y to reset.
const controllers = [renderer.xr.getController(0), renderer.xr.getController(1)];
const _ray = new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(0, 0, 0), new THREE.Vector3(0, 0, -0.25)]);
controllers.forEach((c) => { c.add(new THREE.Line(_ray, new THREE.LineBasicMaterial({ color: 0x9b8cff }))); scene.add(c); });
const gripping = [false, false];
let grabMode = 'none';   // 'none' | 'one' | 'two'
let two = null;          // two-hand start refs
const _p0 = new THREE.Vector3(), _p1 = new THREE.Vector3(), _v = new THREE.Vector3(), _q = new THREE.Quaternion();

// Recenter — snap the avatar ~0.9 m in front of wherever the viewer is looking, facing them, scale 1.
// (Fixes mobile AR "drifts far": the phone origin ≠ where you're pointing.) Reachable on mobile via
// the dom-overlay button, and in VR via the controller A/X button.
const recenter = () => {
  scene.attach(group);
  const cam = renderer.xr.isPresenting ? renderer.xr.getCamera() : camera;
  cam.getWorldPosition(_cp);
  cam.getWorldDirection(_cd); _cd.y = 0;
  if (_cd.lengthSq() < 1e-6) _cd.set(0, 0, -1); else _cd.normalize();
  const DIST = 0.9;
  group.position.set(_cp.x + _cd.x * DIST, _cp.y - 0.15, _cp.z + _cd.z * DIST);
  group.scale.setScalar(1);
  group.rotation.set(0, Math.atan2(_cp.x - group.position.x, _cp.z - group.position.z), 0); // +Z faces viewer
  grabMode = 'none'; two = null; gripping[0] = gripping[1] = false;
};
recenterBtn.addEventListener('click', recenter);
const onGrip = () => {
  const n = (gripping[0] ? 1 : 0) + (gripping[1] ? 1 : 0);
  if (n === 1) {
    controllers[gripping[0] ? 0 : 1].attach(group);  // group follows this controller (translate + rotate)
    grabMode = 'one'; two = null;
  } else if (n === 2) {
    scene.attach(group);                             // leave single-hand; drive scale/rotate/move per-frame
    controllers[0].getWorldPosition(_p0); controllers[1].getWorldPosition(_p1);
    two = { dist: _p0.distanceTo(_p1) || 1e-4, scale: group.scale.x,
            mid: _p0.clone().add(_p1).multiplyScalar(0.5), pos: group.position.clone(),
            vec: _p1.clone().sub(_p0).normalize(), quat: group.quaternion.clone() };
    grabMode = 'two';
  } else {
    scene.attach(group);                             // release — the avatar stays where you left it
    grabMode = 'none'; two = null;
  }
};
controllers.forEach((c, i) => {
  c.addEventListener('squeezestart', () => { gripping[i] = true; onGrip(); });
  c.addEventListener('squeezeend', () => { gripping[i] = false; onGrip(); });
});
let resetLatch = false;
const pollReset = () => {
  const s = renderer.xr.getSession(); if (!s) return;
  let pressed = false;
  for (const src of s.inputSources) {
    const gp = src.gamepad;
    if (gp && (gp.buttons[4]?.pressed || gp.buttons[5]?.pressed)) pressed = true; // A/X or B/Y
  }
  if (pressed && !resetLatch) { resetLatch = true; recenter(); } else if (!pressed) resetLatch = false;
};
const updateTwoHand = () => {
  if (grabMode !== 'two' || !two) return;
  controllers[0].getWorldPosition(_p0); controllers[1].getWorldPosition(_p1);
  const dist = _p0.distanceTo(_p1) || 1e-4;
  group.scale.setScalar(two.scale * (dist / two.dist));
  _v.copy(_p1).sub(_p0).normalize();
  _q.setFromUnitVectors(two.vec, _v);
  group.quaternion.copy(_q).multiply(two.quat);
  group.position.set(
    two.pos.x + ((_p0.x + _p1.x) * 0.5 - two.mid.x),
    two.pos.y + ((_p0.y + _p1.y) * 0.5 - two.mid.y),
    two.pos.z + ((_p0.z + _p1.z) * 0.5 - two.mid.z));
};

renderer.xr.addEventListener('sessionstart', () => {
  if (camPathActive) setCamPath(false); // headset owns the camera; not auto-re-enabled on sessionend
  if (flyActive) setFly(false);         // ditto for fly mode — back to Orbit for after the session
  if (navBtn) navBtn.style.display = 'none'; // headset owns the camera → no fly toggle in XR
  const ar = isPassthrough();
  scene.background = ar ? null : DARK;   // transparent → passthrough shows through
  renderer.setClearAlpha(ar ? 0 : 1);
  // Entering XR is a user gesture → force sound on (no "tap for sound" reachable in a headset).
  if (audioEl) { audioEl.muted = false; audioEl.play().catch(() => {}); updateSound(); }
  xrUI.style.display = 'none';           // hide Enter VR/AR
  recenterBtn.style.display = 'block';   // show Recenter (tappable in mobile AR via dom-overlay)
  setTimeout(recenter, 350);             // recenter once the viewer pose is valid (first frames)
});
renderer.xr.addEventListener('sessionend', () => {
  scene.background = DARK; renderer.setClearAlpha(1);
  group.position.set(0, 0, 0); group.quaternion.identity(); group.scale.setScalar(1);
  xrUI.style.display = 'flex';           // restore Enter VR/AR
  recenterBtn.style.display = 'none';
  if (navBtn) navBtn.style.display = 'block';
});

addEventListener('resize', () => {
  camera.aspect = viewer.offsetWidth / viewer.offsetHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(viewer.offsetWidth, viewer.offsetHeight);
});

// ---- playback state ------------------------------------------------------
// One struct per animated object; a v1 package constructs exactly ONE so its behavior is unchanged.
const animObjects = [];     // { meshes: [], idx: 0, last: 0, fps, total, hasAudio }
let started = false;
let audioEl = null;

// camera flythrough (manifest.camera) — spline path replayed on the shared scene clock
let camSpline = null, camData = null, camPathActive = false, camOut = new Array(6);
let camPathMode = 'auto';   // 'auto' | 'manual' | 'off' — resolved in resolvePlayerConfig
let watermarkEnabled = true; // 3D splat watermark — resolved in resolvePlayerConfig
let camPathOffsetSec = 0;   // manual mode: clock at 🎥 activation → path replays from ITS OWN frame 0 (stays 0 in auto)
let playStartMs = 0;   // set in startPlayback()

// the shared scene clock (same source the render loop uses to pose the camera path): the
// audio-owning object's soundtrack when it is running, wall time since playback start otherwise
const clockSec = () => {
  const audioOwner = animObjects.find((o) => o.hasAudio);
  if (audioOwner && audioEl && !audioEl.paused && audioEl.duration) return audioEl.currentTime;
  return (performance.now() - playStartMs) / 1000;
};

const addFrameTo = (o, u8) => {
  const m = new SplatMesh({ fileBytes: u8, fileType: 'spz' });
  m.visible = (o.meshes.length === 0);
  group.add(m);
  o.meshes.push(m);
  revealAdd(m);
};

// ✨ splat-REVEAL entrance — all five effects from the official sparkjs.dev "Splat Reveal
// Effects" example (Magic / Spread / Unroll / Twister / Rain): one per-gsplat objectModifier
// (dyno shader graph) with the example's effectType int uniform selecting the GLSL branch,
// driven by one shared time uniform. It plays RIGHT AFTER the loading bar completes (covers
// the visual pop-in), then the modifier is REMOVED (objectModifier = undefined +
// updateGenerator) so steady-state rendering returns to the exact zero-cost pipeline. Meshes
// are collected while loading; anything that streams in during the reveal window joins it,
// anything later never gets the modifier. Orthogonal to the frame-swap .visible cycling.
// Selection precedence: ?reveal=off|spread|magic|unroll|twister|rain > manifest.player.reveal
// .effect > 'spread'; duration: ?revealsec=N > manifest.player.reveal.sec > 4.5 s. Old
// packages (no manifest.player, no URL params) get spread/4.5 s — the previous behavior.
// A dyno failure must never break playback.
const urlParams = new URLSearchParams(location.search);
const REVEAL_EFFECT_IDS = { magic: 1, spread: 2, unroll: 3, twister: 4, rain: 5 }; // example's effectType ints
let revealEffectName = 'spread';  // resolved in resolvePlayerConfig (URL > manifest.player > default)
let REVEAL_MS = 4500;             // ditto (clamped 0.5–20 s, same clamp the old ?revealsec had)
// Example-time at reveal end (kept at 7 for all five effects in v1). The Spread math saturates
// as tt = t*t*.4+.5 grows: centers are exact from tt >= 14, scales/colors from tt >= 8+2.5*l
// (l = splat distance from the local Y axis, normalized to the demo-valley scale, see revealK).
// t = 7 → tt ≈ 20 → everything within l ≈ 4.8 is at identity when the modifier is removed, so
// the removal is invisible. The OTHER four branches still have residual motion at t = 7 (Magic
// scales-in ends ~t≈10, Twister ~t≈12.5, Rain's rot(t*.3) never settles at all) → for those the
// last ≤300 ms of the reveal window blends the effect output back to the unmodified splat
// (revealE uniform), so modifier removal never snaps. Spread keeps revealE = 0 → its rendering
// is unchanged from the previous single-effect player.
const REVEAL_T_END = 7.0;
// Per-effect end time (panel finding): each branch settles at a different t — with a shared t=7,
// Magic/Twister/Rain only sweep ~1/3 of the normalized radius and the end blend does the rest as a
// pop. Mapping REVEAL_MS onto each effect's OWN settle time keeps the whole duration on the sweep.
// (Rain's rotation never fully settles — the end blend still covers its tail.)
const REVEAL_T_ENDS = { magic: 10.0, spread: 7.0, unroll: 7.0, twister: 12.5, rain: 12.0 };
// The official Spread is tuned for VALLEY-scale content: its wave terms (tt - l*2.5 etc.) use the
// splat's ABSOLUTE distance l from the local Y axis, and saturate around l ≈ 4.8 world units. On a
// ~0.3 u FLEX head every splat shares nearly the same phase → the "spread" collapses into a uniform
// fade (user report: looks nothing like the example). Fix: normalize l to the scene's xz-radius —
// k = 4.8 / sceneRadius — so the wave sweeps the whole scene over the animation regardless of
// scale. sceneRadius comes from manifest.sceneRadius (written by the exporter); fallback 0.35
// (head-scale) for older packages. A valley-sized scene (R≈4.8) gets k≈1 = the official look.
const REVEAL_L_REF = 4.8;
let revealSceneRadius = 0.35;  // set from manifest in load()
let revealT = null;         // shared dyno float uniform (example's animateT)
let revealK = null;         // shared dyno float uniform — scene-scale normalization factor
let revealE = null;         // shared dyno float uniform — end blend to identity (0 = effect, 1 = raw splat)
let revealEffect = null;    // shared dyno int uniform — the example's effectType branch selector
let revealEndBlendMs = 0;   // per-effect end-blend window, set in startReveal (0 for spread)
let revealModifier = null;  // one dynoBlock shared by every mesh → compiled-generator cache hit
let revealMeshes = [];      // meshes carrying the modifier during the reveal window
let revealActive = false;
let revealDone = false;     // done → stop collecting, never attach again (set by resolvePlayerConfig for 'off')
let revealStartMs = 0;

// Precedence everywhere: URL param > manifest.player > built-in default. Old packages have no
// manifest.player → spread / 4.5 s / campath auto: decisions identical to the previous player.
// Called in load() right after the manifest fetch — before any mesh exists and before
// setupCameraPath, so both the reveal collector and the camera path see the resolved config.
const resolvePlayerConfig = (manifest) => {
  const mp = (manifest && typeof manifest.player === 'object' && manifest.player) ? manifest.player : {};
  const mReveal = (mp.reveal && typeof mp.reveal === 'object') ? mp.reveal : {};
  // effect: ?reveal=off|spread|magic|unroll|twister|rain (the existing ?reveal=off keeps working)
  const rawEffect = urlParams.get('reveal') ?? (typeof mReveal.effect === 'string' ? mReveal.effect : null);
  let name = rawEffect === null ? 'spread' : String(rawEffect).toLowerCase();
  if (name !== 'off' && !(name in REVEAL_EFFECT_IDS)) {
    console.warn(`unknown reveal effect "${rawEffect}" — falling back to spread`);
    name = 'spread';
  }
  revealEffectName = name;
  revealDone = name === 'off';
  // duration: ?revealsec=N > manifest.player.reveal.sec > 4.5 (clamped 0.5–20 s either way)
  const urlSec = parseFloat(urlParams.get('revealsec'));
  const sec = Number.isFinite(urlSec) ? urlSec : (Number.isFinite(mReveal.sec) ? mReveal.sec : 4.5);
  REVEAL_MS = Math.min(20, Math.max(0.5, sec)) * 1000;
  // camera path: ?campath=auto|manual|off > manifest.player.camera.autoplay (true→auto,
  // false→manual) > auto. 'off' = ignore manifest.camera entirely (no spline, no 🎥 button).
  const urlCam = urlParams.get('campath')?.toLowerCase() ?? null;
  if (urlCam === 'auto' || urlCam === 'manual' || urlCam === 'off') {
    camPathMode = urlCam;
  } else {
    if (urlCam !== null) console.warn(`unknown campath mode "${urlCam}" — ignored`);
    const mCam = (mp.camera && typeof mp.camera === 'object') ? mp.camera : null;
    camPathMode = (mCam && mCam.autoplay === false) ? 'manual' : 'auto';
  }
  // 3D splat watermark: ?watermark=on|off > manifest.player.watermark (boolean) > on
  const urlWm = urlParams.get('watermark')?.toLowerCase() ?? null;
  if (urlWm === 'on' || urlWm === 'off') {
    watermarkEnabled = urlWm === 'on';
  } else {
    if (urlWm !== null) console.warn(`unknown watermark value "${urlWm}" — ignored`);
    watermarkEnabled = mp.watermark !== false;
  }
};

const makeRevealModifier = () => {
  if (revealModifier) return true;
  try {
    revealT = dyno.dynoFloat(0);
    revealK = dyno.dynoFloat(1);
    revealE = dyno.dynoFloat(0);
    revealEffect = dyno.dynoInt(REVEAL_EFFECT_IDS[revealEffectName] || REVEAL_EFFECT_IDS.spread);
    // The official example's effect Dyno, whole (all five GLSL branches + utility globals),
    // with two additions: (1) EVERY branch runs its position/scale math in NORMALIZED space —
    // p = center * k in, result / k out — so the example's absolute-unit constants (spread wave
    // phase, magic noise offsets, rain drop height, twister angle-by-height, unroll distance)
    // behave as if the scene were valley-scale regardless of actual size (this subsumes the old
    // Spread-specific l*k — identical result, since Spread's math is xz-radial); (2) an end
    // blend `e` that lerps the effect output back to the raw splat over the final window (see
    // REVEAL_T_END notes) so removing the modifier never snaps. quatQuat comes from Spark's
    // built-in GLSL splat utils (splatDefines), same as in the example.
    const effect = new dyno.Dyno({
      inTypes: { gsplat: dyno.Gsplat, t: 'float', k: 'float', e: 'float', effectType: 'int' },
      outTypes: { gsplat: dyno.Gsplat },
      // GLSL utility functions for effects — official example, verbatim
      globals: () => [
        dyno.unindent(`
          // Pseudo-random hash function
          vec3 hash(vec3 p) {
            p = fract(p * 0.3183099 + 0.1);
            p *= 17.0;
            return fract(vec3(p.x * p.y * p.z, p.x + p.y * p.z, p.x * p.y + p.z));
          }

          // 3D Perlin-style noise function
          vec3 noise(vec3 p) {
            vec3 i = floor(p);
            vec3 f = fract(p);
            f = f * f * (3.0 - 2.0 * f);

            vec3 n000 = hash(i + vec3(0,0,0));
            vec3 n100 = hash(i + vec3(1,0,0));
            vec3 n010 = hash(i + vec3(0,1,0));
            vec3 n110 = hash(i + vec3(1,1,0));
            vec3 n001 = hash(i + vec3(0,0,1));
            vec3 n101 = hash(i + vec3(1,0,1));
            vec3 n011 = hash(i + vec3(0,1,1));
            vec3 n111 = hash(i + vec3(1,1,1));

            vec3 x0 = mix(n000, n100, f.x);
            vec3 x1 = mix(n010, n110, f.x);
            vec3 x2 = mix(n001, n101, f.x);
            vec3 x3 = mix(n011, n111, f.x);

            vec3 y0 = mix(x0, x1, f.y);
            vec3 y1 = mix(x2, x3, f.y);

            return mix(y0, y1, f.z);
          }

          // 2D rotation matrix
          mat2 rot(float a) {
            float s=sin(a),c=cos(a);
            return mat2(c,-s,s,c);
          }
          // Twister weather effect
          vec4 twister(vec3 pos, vec3 scale, float t) {
            vec3 h = hash(pos);
            float s = smoothstep(0., 8., t*t*.1 - length(pos.xz)*2.+2.);
            if (length(scale) < .05) pos.y = mix(-10., pos.y, pow(s, 2.*h.x));
            pos.xz = mix(pos.xz*.5, pos.xz, pow(s, 2.*h.x));
            float rotationTime = t * (1.0 - s) * 0.2;
            pos.xz *= rot(rotationTime + pos.y*60.*(1.-s)*exp(-1.*length(pos.xz)));   // twist freq x3 (user tuning)
            return vec4(pos, s*s*s*s);
          }

          // Rain weather effect
          vec4 rain(vec3 pos, vec3 scale, float t) {
            vec3 h = hash(pos);
            float s = pow(smoothstep(0., 5., t*t*.1 - length(pos.xz)*2. + 1.), .5 + h.x);
            float y = pos.y;
            pos.y = min(-10. + s*15., pos.y);
            pos.xz = mix(pos.xz*.3, pos.xz, s);
            pos.xz *= rot(t*.3);
            return vec4(pos, smoothstep(-10., y, pos.y));
          }
        `)
      ],
      // Main effect shader logic — official example branches, in normalized space (see above)
      statements: ({ inputs, outputs }) => dyno.unindentLines(`
        ${outputs.gsplat} = ${inputs.gsplat};
        float t = ${inputs.t};
        float k = ${inputs.k};
        float s = smoothstep(0.,10.,t-4.5)*10.;
        vec3 scales = ${inputs.gsplat}.scales * k;
        vec3 localPos = ${inputs.gsplat}.center * k;
        float l = length(localPos.xz);

        if (${inputs.effectType} == 1) {
          // Magic Effect: Complex twister with noise and radial reveal
          float border = abs(s-l-.5);
          localPos *= 1.-.2*exp(-20.*border);
          vec3 finalScales = mix(scales,vec3(0.002),smoothstep(s-.5,s,l+.5));
          ${outputs.gsplat}.center = (localPos + .1*noise(localPos.xyz*6.+t*.5)*smoothstep(s-.5,s,l+.5)) / k;   // noise freq x3 (user tuning: example's *2. waves read too coarse on close-up heads)
          ${outputs.gsplat}.scales = finalScales / k;
          float at = atan(localPos.x,localPos.z)/3.1416;
          ${outputs.gsplat}.rgba *= step(at,t-3.1416);
          ${outputs.gsplat}.rgba += exp(-20.*border) + exp(-50.*abs(t-at-3.1416))*.5;

        } else if (${inputs.effectType} == 2) {
          // Spread Effect: Gentle radial emergence with scaling
          float tt = t*t*.4+.5;
          localPos.xz *= min(1.,.3+max(0.,tt*.05));
          ${outputs.gsplat}.center = localPos / k;
          ${outputs.gsplat}.scales = max(mix(vec3(0.0),scales,min(tt-7.-l*2.5,1.)),mix(vec3(0.0),scales*.2,min(tt-1.-l*2.,1.))) / k;
          ${outputs.gsplat}.rgba = mix(vec4(.3),${inputs.gsplat}.rgba,clamp(tt-l*2.5-3.,0.,1.));

        } else if (${inputs.effectType} == 3) {
          // Unroll Effect: Rotating helix with vertical reveal
          localPos.xz *= rot((localPos.y*150.-20.)*exp(-t));   // helix freq x3 (user tuning)
          ${outputs.gsplat}.center = localPos * (1.-exp(-t)*2.) / k;
          ${outputs.gsplat}.scales = mix(vec3(0.002),scales,smoothstep(.3,.7,t+localPos.y-2.)) / k;
          ${outputs.gsplat}.rgba = ${inputs.gsplat}.rgba*step(0.,t*.5+localPos.y-.5);
        } else if (${inputs.effectType} == 4) {
          // Twister Effect: swirling weather reveal
          vec4 effectResult = twister(localPos, scales, t);
          ${outputs.gsplat}.center = effectResult.xyz / k;
          ${outputs.gsplat}.scales = mix(vec3(.002), scales, pow(effectResult.w, 12.)) / k;
          float sT = effectResult.w;
          // Also apply a spin (self-rotation) so each splat rotates about its own center.
          float spin = -t * 0.3 * (1.0 - sT);
          vec4 spinQ = vec4(0.0, sin(spin*0.5), 0.0, cos(spin*0.5));
          ${outputs.gsplat}.quaternion = quatQuat(spinQ, ${inputs.gsplat}.quaternion);
        } else if (${inputs.effectType} == 5) {
          // Rain Effect: falling streaks
          vec4 effectResult = rain(localPos, scales, t);
          ${outputs.gsplat}.center = effectResult.xyz / k;
          ${outputs.gsplat}.scales = mix(vec3(.005), scales, pow(effectResult.w, 30.)) / k;
          // Also apply a spin (self-rotation) so each splat rotates about its own center.
          float spin = -t*.3;
          vec4 spinQ = vec4(0.0, sin(spin*0.5), 0.0, cos(spin*0.5));
          ${outputs.gsplat}.quaternion = quatQuat(spinQ, ${inputs.gsplat}.quaternion);
        }

        // end blend — lerp back to the unmodified splat so modifier removal never snaps
        // (e stays 0 for Spread and outside the final window → the branches above are exact)
        float e = ${inputs.e};
        if (e > 0.) {
          ${outputs.gsplat}.center = mix(${outputs.gsplat}.center, ${inputs.gsplat}.center, e);
          ${outputs.gsplat}.scales = mix(${outputs.gsplat}.scales, ${inputs.gsplat}.scales, e);
          ${outputs.gsplat}.rgba = mix(${outputs.gsplat}.rgba, ${inputs.gsplat}.rgba, e);
          vec4 qa = ${outputs.gsplat}.quaternion;
          vec4 qb = ${inputs.gsplat}.quaternion;
          if (dot(qa, qb) < 0.) qb = -qb;
          ${outputs.gsplat}.quaternion = normalize(mix(qa, qb, e));
        }
      `)
    });
    revealModifier = dyno.dynoBlock(
      { gsplat: dyno.Gsplat },
      { gsplat: dyno.Gsplat },
      ({ gsplat }) => ({ gsplat: effect.apply({ gsplat, t: revealT, k: revealK, e: revealE, effectType: revealEffect }).gsplat })
    );
    return true;
  } catch (e) {
    console.warn('splat reveal skipped', e);
    revealModifier = null; revealDone = true; revealMeshes = [];
    return false;
  }
};

// collect every content mesh (statics + frame meshes) as it is created; late arrivals during
// an active reveal get the modifier immediately so they don't pop in fully-formed mid-reveal
const revealAdd = (m) => {
  if (revealDone) return;
  revealMeshes.push(m);
  if (revealActive) { m.objectModifier = revealModifier; m.updateGenerator(); }
};

const startReveal = () => {
  if (revealDone || !makeRevealModifier()) return;
  revealK.value = REVEAL_L_REF / Math.max(revealSceneRadius, 0.05);   // scene-scale normalization
  // Spread settles exactly by REVEAL_T_END → no end blend (old-package rendering unchanged);
  // the other four still have residual motion at t = 7 → blend the last ≤300 ms to identity.
  revealEndBlendMs = revealEffectName === 'spread' ? 0 : Math.min(300, REVEAL_MS * 0.2);
  for (const m of revealMeshes) { m.objectModifier = revealModifier; m.updateGenerator(); }
  revealActive = true;
  revealStartMs = performance.now();
};

const endReveal = () => {
  revealActive = false;
  revealDone = true;
  for (const m of revealMeshes) { m.objectModifier = undefined; m.updateGenerator(); } // back to the unmodified pipeline
  revealMeshes = [];
};

// 🏷 VR-visible watermark — the DOM overlay (watermark/buttons) does not exist inside a headset,
// so brand the scene itself: a small splat-text line via the bundle's textSplats(), parented under
// the root group so XR grab/recenter/scale carry it with the scene. textSplats renders the string
// to a canvas and emits one splat per opaque pixel, centered at the local origin in the z=0 plane
// (already facing +Z); objectScale converts canvas px → world units. Added exactly once, when
// playback first starts (i.e. after the first object loads). A failure must never break playback.
const addWatermark = () => {
  try {
    const wm = textSplats({
      text: 'Shooting Lab',
      font: 'Arial',
      fontSize: 32,                               // canvas px; world size comes from objectScale
      color: new THREE.Color(0.4, 0.4, 0.4),      // dim grey (~40% white) — legible, not shouting
      objectScale: 0.0012                         // ~23 px cap height → ~0.028 world height
    });
    wm.position.set(0, -0.42, 0);                 // below the avatar, inside the root group
    group.add(wm);
  } catch (e) {
    console.warn('splat watermark skipped', e);
  }
};

const startPlayback = () => {
  if (started) return;
  started = true;
  if (watermarkEnabled) addWatermark();
  startReveal();   // ✨ entrance reveal starts the moment the loading gate opens (covers pop-in)
  playStartMs = performance.now();
  loadEl.style.opacity = '0';
  setTimeout(() => { loadEl.style.display = 'none'; }, 600);
  if (audioEl) audioEl.play().catch(() => { audioEl.muted = true; updateSound(); }); // autoplay blocked → start muted, toggle unmutes
  renderer.setAnimationLoop((t) => {
    for (const o of animObjects) {
      if (o.meshes.length > 1 && (t - o.last) > (1000 / o.fps)) {
        o.meshes[o.idx].visible = false;
        if (o.hasAudio && audioEl && !audioEl.paused && audioEl.duration) {
          o.idx = Math.floor(audioEl.currentTime * o.fps) % o.meshes.length; // LOADED count — the tail may still be streaming
        } else {
          o.idx = (o.idx + 1) % o.meshes.length;
        }
        o.meshes[o.idx].visible = true;
        o.last = t;
      }
    }
    // ✨ entrance reveal — advance the shared time uniform, version-bump each modified mesh so
    // Spark re-runs its generator (official example ticks animateT + updateVersion() per frame)
    if (revealActive) {
      const p = Math.min(Math.max((t - revealStartMs) / REVEAL_MS, 0), 1);
      revealT.value = p * (REVEAL_T_ENDS[revealEffectName] || REVEAL_T_END);
      if (revealEndBlendMs > 0) {  // final identity blend (non-spread effects, see startReveal)
        const eb = Math.min(Math.max((t - revealStartMs - (REVEAL_MS - revealEndBlendMs)) / revealEndBlendMs, 0), 1);
        revealE.value = eb * eb * (3 - 2 * eb);   // smoothstep
      }
      for (const m of revealMeshes) m.updateVersion();
      if (p >= 1) endReveal();
    }
    // camera flythrough — pose from the spline on the shared scene clock (never in XR: headset owns the camera)
    if (camPathActive && camSpline && !renderer.xr.isPresenting) {
      let sec;
      const audioOwner = animObjects.find((o) => o.hasAudio);
      if (audioOwner && audioEl && !audioEl.paused && audioEl.duration) sec = audioEl.currentTime;
      else sec = (t - playStartMs) / 1000;
      const fr = (((sec - camPathOffsetSec) * camData.fps) % camData.frames + camData.frames) % camData.frames;
      camSpline.evaluate(fr, camOut);
      camera.position.set(camOut[0], camOut[1], camOut[2]);
      controls.target.set(camOut[3], camOut[4], camOut[5]);
      camera.lookAt(controls.target);
    }
    if (renderer.xr.isPresenting) { pollReset(); updateTwoHand(); } // grab/scale + reset in XR
    else if (flyActive && !camPathActive) flyControls.update(camera, camera); // 🕹 fly — SparkControls tracks its own clock (moves the camera object itself)
    else if (!camPathActive) controls.update();                     // headset owns the camera in XR; OrbitControls.update() ignores 'enabled' + clamps radius → skip while the path owns the camera
    renderer.render(scene, camera);
  });
};

// persistent mute/unmute toggle — never hides after being pressed
soundEl.addEventListener('click', () => {
  if (!audioEl) return;
  audioEl.muted = !audioEl.muted;
  if (!audioEl.muted) audioEl.play().catch(() => {});   // unmute counts as the gesture → ensure playing
  updateSound();
});

// 🎥 camera flythrough toggle + handoff — any pointer/wheel on the canvas hands the camera back to
// the user (known v1 UX: the FIRST press only stops the flythrough; the NEXT drag orbits).
// NOTE: lives after the OrbitControls/renderer construction on purpose — it touches both at module eval.
const camBtn = document.getElementById('campath');
const updateCamBtn = () => { if (camBtn) camBtn.style.opacity = camPathActive ? '1' : '0.4'; };
const setCamPath = (on) => {
  camPathActive = on && !!camSpline;
  // manual mode: each 🎥 activation replays the path from ITS OWN frame 0 — anchor it to the
  // shared clock at this instant (re-toggling recomputes). Auto mode keeps offset 0 so the
  // autoplay path stays aligned with the avatar timeline, exactly as before.
  if (camPathActive && camPathMode === 'manual') camPathOffsetSec = started ? clockSec() : 0;
  if (camPathActive && flyActive) setFly(false);  // 🎥 takes the camera back from Fly
  controls.enabled = !camPathActive && !flyActive;
  updateCamBtn();
};
if (camBtn) camBtn.addEventListener('click', () => setCamPath(!camPathActive));
renderer.domElement.addEventListener('pointerdown', () => { if (camPathActive) setCamPath(false); });
renderer.domElement.addEventListener('wheel', () => { if (camPathActive) setCamPath(false); }, { passive: true });

// 🕹 fly navigation toggle — Orbit (default) ↔ Spark fly controls (WASD/arrows + mouse drag; touch
// comes free via PointerControls). SparkControls is constructed LAZILY on first activation because
// its PointerControls attaches canvas pointer listeners in the constructor — building it up-front
// would touch plain Orbit sessions. Fly and the 🎥 camera path are mutually exclusive; in XR the
// headset owns the camera (button hidden, no fly updates).
const navBtn = document.getElementById('nav');
let flyControls = null;
let flyActive = false;
const updateNavBtn = () => { if (navBtn) navBtn.style.opacity = flyActive ? '1' : '0.4'; };
const setFly = (on) => {
  if (on && !flyControls) flyControls = new SparkControls({ canvas: renderer.domElement });
  flyActive = !!on && !!flyControls;
  if (flyActive && camPathActive) setCamPath(false);  // 🕹 takes the camera from the flythrough
  controls.enabled = !flyActive && !camPathActive;
  if (flyControls) {
    flyControls.fpsMovement.enable = flyActive;
    flyControls.pointerControls.enable = flyActive;
    flyControls.lastTime = 0;  // first update() after a toggle sees deltaTime 0 → no idle-time jump
    // PointerControls' wheel listener accumulates .scroll even while disabled, and its update()
    // early-returns on !enable BEFORE the drain — so Orbit-mode wheel zooms pile up and would be
    // applied to the camera in one un-scaled burst on the first fly frame (scroll is NOT
    // deltaTime-scaled, so the lastTime reset above does not guard it). Drop the backlog, and
    // zero the inertia vectors so a toggle never replays stale drag momentum.
    flyControls.pointerControls.scroll.set(0, 0, 0);
    flyControls.pointerControls.moveVelocity.set(0, 0, 0);
    flyControls.pointerControls.rotateVelocity.set(0, 0, 0);
  }
  updateNavBtn();
};
if (navBtn) navBtn.addEventListener('click', () => setFly(!flyActive));

// build the spline from manifest.camera (version-independent; absent/malformed → zero behavior change)
const setupCameraPath = (manifest) => {
  try {
    if (camPathMode === 'off') return;  // ?campath=off — ignore manifest.camera entirely (no spline, no 🎥)
    const cam = manifest && manifest.camera;
    if (!cam || !Array.isArray(cam.poses) || cam.poses.length < 2 || !(cam.frames > 0) || !(cam.fps > 0)) return;
    if (!cam.poses.every((p) => Array.isArray(p.position) && Array.isArray(p.target))) return;
    const times = cam.poses.map((p) => p.frame);
    const points = [];
    cam.poses.forEach((p) => { points.push(p.position[0], p.position[1], p.position[2], p.target[0], p.target[1], p.target[2]); });
    camSpline = CubicSpline.fromPointsLooping(cam.frames, times, points, cam.smoothness ?? 1);
    camData = cam;
    if (camPathMode === 'manual') {
      camPathActive = false;            // waits for the 🎥 button — path then starts at its own frame 0
    } else {
      camPathActive = true;             // auto (default) — ON when a path ships (showcase-first)
      controls.enabled = false;
      if (flyActive) setFly(false);     // a shipped path takes precedence over an early 🕹 toggle
    }
    if (camBtn) { camBtn.style.display = 'block'; updateCamBtn(); }  // manual → visible + dimmed
  } catch (e) {
    // a hand-edited/malformed camera block must never break playback (spec: ignore it).
    // controls ownership invariant: Orbit re-enables only if Fly doesn't own the camera.
    camSpline = null; camData = null; camPathActive = false; controls.enabled = !flyActive;
    console.warn('camera path ignored (malformed manifest.camera)', e);
  }
};

const pad4 = (i) => String(i).padStart(4, '0');
const setBar = (n, total) => { loadBar.style.width = (n / total * 100).toFixed(1) + '%'; };

// ---- load (dispatch on manifest version) ----------------------------------
async function load() {
  const manifest = await fetch('./manifest.json').then(r => {
    if (!r.ok) throw new Error('manifest ' + r.status);
    return r.json();
  });
  resolvePlayerConfig(manifest);       // URL > manifest.player > defaults (reveal effect/sec + campath mode)
  setupCameraPath(manifest);           // v1 AND v2 — manifest.camera is version-independent
  if (manifest.sceneRadius > 0) revealSceneRadius = manifest.sceneRadius;   // reveal scale (exporter-written)
  if (manifest.version === 2) return loadScene(manifest);

  // v1 (single avatar, progressive: head individual → tail zip) — exactly one animObject; frame 0
  // shows immediately and playback starts before the tail arrives, same as the pre-scene player.
  const total = manifest.frames;
  const head = Math.min(manifest.headCount || 1, total);
  const o = { meshes: [], idx: 0, last: 0, fps: manifest.fps || 30, total, hasAudio: !!manifest.audio };
  animObjects.push(o);

  // audio (top-level package file) — created now so it's ready when playback starts
  if (manifest.audio) {
    audioEl = new Audio('./' + manifest.audio);
    audioEl.loop = true;
    updateSound();
  }
  if (!manifest.audio && soundEl) soundEl.style.display = 'none';

  // HEAD: fetch individually (parallel), add in index order; frame 0 → start immediately
  loadLabel.textContent = 'Loading…';
  const headBufs = [];
  for (let i = 0; i < head; i++) headBufs.push(fetch(`./frames/frame_${pad4(i)}.spz`).then(r => r.arrayBuffer()));
  addFrameTo(o, new Uint8Array(await headBufs[0]));
  startPlayback();
  setBar(1, total);
  for (let i = 1; i < head; i++) { addFrameTo(o, new Uint8Array(await headBufs[i])); setBar(i + 1, total); }

  // TAIL: individual progressive batches (manifest.tailMode 'individual') OR one rest.zip (default).
  if (total > head) {
    if (manifest.tailMode === 'individual') {
      const BATCH = 8;   // bounded concurrency — never fire all N tail requests at once
      for (let i = head; i < total; i += BATCH) {
        const end = Math.min(i + BATCH, total);
        const bufs = [];
        for (let j = i; j < end; j++) bufs.push(fetch(`./frames/frame_${pad4(j)}.spz`).then(r => r.arrayBuffer()));
        for (let j = i; j < end; j++) { addFrameTo(o, new Uint8Array(await bufs[j - i])); setBar(j + 1, total); }
      }
    } else {
      const restBuf = await fetch('./rest.zip').then(r => { if (!r.ok) throw new Error('rest.zip ' + r.status); return r.arrayBuffer(); });
      const zip = await JSZip.loadAsync(restBuf);
      const names = Object.keys(zip.files).filter(f => f.toLowerCase().endsWith('.spz')).sort();
      for (let i = 0; i < names.length; i++) {
        addFrameTo(o, await zip.file(names[i]).async('uint8array'));
        setBar(head + i + 1, total);
      }
    }
  }
}

// v2 (scene manifest): statics + animated objects, all transform-baked at export → loaded at
// identity into the shared root group (so XR grab/recenter move the whole scene). First paint is
// after ALL statics + ALL HEAD frames (documented tradeoff vs v1's instant frame-0 start); TAILs
// then stream in per object. Statics-only scenes are legal — the render loop just orbits them.
async function loadScene(manifest) {
  const objects = manifest.objects || [];
  const statics = objects.filter((o) => o.type === 'static');
  const anims = objects.filter((o) => o.type === 'animated');

  if (manifest.audio) { audioEl = new Audio('./' + manifest.audio); audioEl.loop = true; updateSound(); }
  if (!manifest.audio && soundEl) soundEl.style.display = 'none';

  loadLabel.textContent = 'Loading…';
  const totalUnits = statics.length + anims.reduce((s, o) => s + o.frames, 0);
  let done = 0;
  const bump = () => setBar(++done, totalUnits);

  for (const o of statics) {
    const buf = await fetch('./' + o.src).then((r) => { if (!r.ok) throw new Error(o.src + ' ' + r.status); return r.arrayBuffer(); });
    const m = new SplatMesh({ fileBytes: new Uint8Array(buf), fileType: 'spz' });
    group.add(m);
    revealAdd(m);
    await m.initialized;
    bump();
  }

  // HEADs: per object, fetch in parallel, add in index order (frame 0 of each object visible)
  for (const o of anims) {
    const st = { meshes: [], idx: 0, last: 0, fps: o.fps || 30, total: o.frames, hasAudio: !!o.audio };
    animObjects.push(st);
    const head = Math.min(o.headCount || 1, o.frames);
    const bufs = [];
    for (let i = 0; i < head; i++) bufs.push(fetch(`./${o.dir}/frames/frame_${pad4(i)}.spz`).then((r) => { if (!r.ok) throw new Error(`${o.dir} frame ${r.status}`); return r.arrayBuffer(); }));
    for (let i = 0; i < head; i++) { addFrameTo(st, new Uint8Array(await bufs[i])); bump(); }
  }

  startPlayback();          // v2 first paint = after statics + all HEADs (documented tradeoff)

  // TAILs: one rest.zip per animated object, streamed in the background
  for (let a = 0; a < anims.length; a++) {
    const o = anims[a];
    const st = animObjects[a];
    if (o.frames <= (o.headCount || 1)) continue;
    const restBuf = await fetch(`./${o.dir}/rest.zip`).then((r) => { if (!r.ok) throw new Error('rest.zip ' + r.status); return r.arrayBuffer(); });
    const zip = await JSZip.loadAsync(restBuf);
    const names = Object.keys(zip.files).filter((f) => f.toLowerCase().endsWith('.spz')).sort();
    for (let i = 0; i < names.length; i++) { addFrameTo(st, await zip.file(names[i]).async('uint8array')); bump(); }
  }
}

load().catch(e => fail(e.message || String(e)));
