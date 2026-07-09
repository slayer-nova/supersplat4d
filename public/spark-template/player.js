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
import { VRButton } from 'three/addons/webxr/VRButton.js';
import JSZip from 'jszip';

const viewer = document.getElementById('viewer');
const loadEl = document.getElementById('load');
const loadLabel = document.getElementById('load-label');
const loadBar = document.getElementById('load-bar');
const tapEl = document.getElementById('tap');
const errEl = document.getElementById('err');
const fail = (m) => { errEl.style.display = 'grid'; errEl.textContent = 'Could not load avatar: ' + m; console.error(m); };

// ---- three + spark scene -------------------------------------------------
const camera = new THREE.PerspectiveCamera(20, viewer.offsetWidth / viewer.offsetHeight, 0.01, 100);
camera.position.set(0, 0, 0.95); // FLEX heads: ~0.5u tall at origin, sub-mm splats → sit close
const renderer = new THREE.WebGLRenderer({ antialias: false });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.setSize(viewer.offsetWidth, viewer.offsetHeight);
renderer.xr.enabled = true; // WebXR: Spark renders splats per-eye in an immersive session
viewer.appendChild(renderer.domElement);

// "Enter VR" — three's VRButton auto-detects support (hides / shows "VR NOT SUPPORTED" otherwise).
const vrButton = VRButton.createButton(renderer);
document.body.appendChild(vrButton);

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

// In an immersive session the headset drives the camera, so move the avatar in front of the viewer
// at eye height (local-floor origin ≈ floor); restore to the desktop framing on exit.
renderer.xr.addEventListener('sessionstart', () => group.position.set(0, 1.4, -1.1));
renderer.xr.addEventListener('sessionend', () => group.position.set(0, 0, 0));

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
  if (audioEl) audioEl.play().catch(() => { tapEl.style.display = 'block'; }); // autoplay may be blocked
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
    if (!renderer.xr.isPresenting) controls.update(); // headset owns the camera in VR
    renderer.render(scene, camera);
  });
};

// tap-to-start-audio fallback
tapEl.addEventListener('click', () => { if (audioEl) audioEl.play().catch(() => {}); tapEl.style.display = 'none'; });

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
  }

  // HEAD: fetch individually (parallel), add in index order; frame 0 → start immediately
  loadLabel.textContent = 'Loading…';
  const headBufs = [];
  for (let i = 0; i < head; i++) headBufs.push(fetch(`./frames/frame_${pad4(i)}.spz`).then(r => r.arrayBuffer()));
  addFrame(await headBufs[0]);
  startPlayback();
  setBar(1, total);
  for (let i = 1; i < head; i++) { addFrame(await headBufs[i]); setBar(i + 1, total); }

  // TAIL: one zip in the background; append in order as the loop keeps playing the head
  if (total > head) {
    const restBuf = await fetch('./rest.zip').then(r => { if (!r.ok) throw new Error('rest.zip ' + r.status); return r.arrayBuffer(); });
    const zip = await JSZip.loadAsync(restBuf);
    const names = Object.keys(zip.files).filter(f => f.toLowerCase().endsWith('.spz')).sort();
    for (let i = 0; i < names.length; i++) {
      addFrame(await zip.file(names[i]).async('uint8array'));
      setBar(head + i + 1, total);
    }
  }
}

load().catch(e => fail(e.message || String(e)));
