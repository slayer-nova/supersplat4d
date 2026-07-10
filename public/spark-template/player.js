// FlexAvatar · Spark player — self-contained, offline, progressive 3DGS talking-head playback.
//
// Loads a package produced by the SuperSplat editor's "Export Spark Player" (see DESIGN.md):
//   manifest.json + frames/frame_%04d.spz (HEAD, individual) + rest.zip (TAIL) + audio.m4a
// The HEAD frames stream in individually so frame 0 shows in ~50 ms and playback starts at once; the
// TAIL arrives as one zip in the background and the loop expands to the full clip. One SplatMesh per
// frame, cycled by visibility at the bake fps; audio drives the frame index so A/V stay in sync.

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
const frames = [];          // dense, in order; one SplatMesh per frame
let fps = 30, started = false, frameIndex = 0, lastSwap = 0;
let audioEl = null;

const addFrame = (bytes) => {
  const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  const mesh = new SplatMesh({ fileBytes: u8, fileType: 'spz' });
  mesh.visible = (frames.length === 0);
  group.add(mesh);
  frames.push(mesh);
  return mesh;
};

const startPlayback = () => {
  if (started) return;
  started = true;
  loadEl.style.opacity = '0';
  setTimeout(() => { loadEl.style.display = 'none'; }, 600);
  if (audioEl) audioEl.play().catch(() => { audioEl.muted = true; updateSound(); }); // autoplay blocked → start muted, toggle unmutes
  renderer.setAnimationLoop((t) => {
    if (frames.length > 1 && (t - lastSwap) > (1000 / fps)) {
      frames[frameIndex].visible = false;
      if (audioEl && !audioEl.paused && audioEl.duration) {
        frameIndex = Math.floor(audioEl.currentTime * fps) % frames.length;
      } else {
        frameIndex = (frameIndex + 1) % frames.length;
      }
      frames[frameIndex].visible = true;
      lastSwap = t;
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

// ---- load (progressive: head individual → tail zip) ----------------------
async function load() {
  const manifest = await fetch('./manifest.json').then(r => {
    if (!r.ok) throw new Error('manifest ' + r.status);
    return r.json();
  });
  fps = manifest.fps || 30;
  const total = manifest.frames;
  const head = Math.min(manifest.headCount || 1, total);

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
  addFrame(await headBufs[0]);
  startPlayback();
  setBar(1, total);
  for (let i = 1; i < head; i++) { addFrame(await headBufs[i]); setBar(i + 1, total); }

  // TAIL: individual progressive batches (manifest.tailMode 'individual') OR one rest.zip (default).
  if (total > head) {
    if (manifest.tailMode === 'individual') {
      const BATCH = 8;   // bounded concurrency — never fire all N tail requests at once
      for (let i = head; i < total; i += BATCH) {
        const end = Math.min(i + BATCH, total);
        const bufs = [];
        for (let j = i; j < end; j++) bufs.push(fetch(`./frames/frame_${pad4(j)}.spz`).then(r => r.arrayBuffer()));
        for (let j = i; j < end; j++) { addFrame(await bufs[j - i]); setBar(j + 1, total); }
      }
    } else {
      const restBuf = await fetch('./rest.zip').then(r => { if (!r.ok) throw new Error('rest.zip ' + r.status); return r.arrayBuffer(); });
      const zip = await JSZip.loadAsync(restBuf);
      const names = Object.keys(zip.files).filter(f => f.toLowerCase().endsWith('.spz')).sort();
      for (let i = 0; i < names.length; i++) {
        addFrame(await zip.file(names[i]).async('uint8array'));
        setBar(head + i + 1, total);
      }
    }
  }
}

load().catch(e => fail(e.message || String(e)));
