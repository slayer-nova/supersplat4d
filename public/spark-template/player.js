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
import { SparkRenderer, SplatMesh } from '@sparkjsdev/spark';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import JSZip from 'jszip';

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

const addFrameTo = (o, u8) => {
  const m = new SplatMesh({ fileBytes: u8, fileType: 'spz' });
  m.visible = (o.meshes.length === 0);
  group.add(m);
  o.meshes.push(m);
};

const startPlayback = () => {
  if (started) return;
  started = true;
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
    if (renderer.xr.isPresenting) { pollReset(); updateTwoHand(); } // grab/scale + reset in XR
    else controls.update();                                         // headset owns the camera in XR
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

const pad4 = (i) => String(i).padStart(4, '0');
const setBar = (n, total) => { loadBar.style.width = (n / total * 100).toFixed(1) + '%'; };

// ---- load (dispatch on manifest version) ----------------------------------
async function load() {
  const manifest = await fetch('./manifest.json').then(r => {
    if (!r.ok) throw new Error('manifest ' + r.status);
    return r.json();
  });
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
