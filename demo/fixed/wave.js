// The hero waveform: one instanced mesh (a single draw call), drawn only when
// something changes: the opening rise, a resize, or the pointer tilting it.
import * as THREE from 'three';

const canvas = document.getElementById('wave');
const still = matchMedia('(prefers-reduced-motion: reduce)').matches;
const COLS = 48, ROWS = 9;

const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'low-power' });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
const scene = new THREE.Scene();
scene.background = new THREE.Color(0x16130f);
const camera = new THREE.PerspectiveCamera(36, 1.6, 0.1, 200);
camera.position.set(0, 6.5, 31);
camera.lookAt(0, 3.9, 0);
scene.add(new THREE.HemisphereLight(0xfff1dc, 0x2a1d12, 1.4));
const sun = new THREE.DirectionalLight(0xffe2c4, 2.2);
sun.position.set(-8, 18, 12);
scene.add(sun);

// a made-up fourteen minute stand-up: bursts of speech with pauses between
const level = (x) => {
  const talk = Math.max(0, Math.sin(x * 0.21) * 0.6 + Math.sin(x * 0.53 + 1.3) * 0.5 + 0.35);
  return 0.15 + talk * (0.55 + 0.45 * Math.sin(x * 1.7) ** 2) * 5.2;
};
const bars = new THREE.InstancedMesh(new THREE.BoxGeometry(0.42, 1, 0.42), new THREE.MeshStandardMaterial({ roughness: 0.55, metalness: 0.05 }), COLS * ROWS);
const heights = new Float32Array(COLS * ROWS);
const low = new THREE.Color(0x4a2a16), high = new THREE.Color(0xf07a3a), c = new THREE.Color();
for (let r = 0, i = 0; r < ROWS; r++) {
  for (let k = 0; k < COLS; k++, i++) {
    const fade = 1 - Math.abs(r - (ROWS - 1) / 2) / ROWS;
    heights[i] = level(k + r * 0.35) * fade;
    bars.setColorAt(i, c.copy(low).lerp(high, Math.min(1, heights[i] / 4.5)));
  }
}
const group = new THREE.Group();
group.add(bars);
scene.add(group);

const m = new THREE.Matrix4();
function place(t) {
  for (let r = 0, i = 0; r < ROWS; r++) {
    for (let k = 0; k < COLS; k++, i++) {
      const h = Math.max(0.05, heights[i] * Math.min(1, Math.max(0, t * 1.6 - k / COLS * 0.6)));
      m.makeScale(1, h, 1).setPosition((k - COLS / 2) * 0.55, h / 2, (r - ROWS / 2) * 0.62);
      bars.setMatrixAt(i, m);
    }
  }
  bars.instanceMatrix.needsUpdate = true;
}

let queued = false;
const draw = () => { queued = false; renderer.render(scene, camera); };
const request = () => { if (!queued) { queued = true; requestAnimationFrame(draw); } };

function size() {
  const w = canvas.clientWidth, h = canvas.clientHeight;
  if (!w || !h) return;
  renderer.setSize(w, h, false);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
  request();
}
new ResizeObserver(size).observe(canvas);

if (still) { place(1); request(); }
else {
  const start = performance.now();
  const rise = (now) => {
    const t = Math.min(1, (now - start) / 1400);
    place(1 - (1 - t) ** 3);
    renderer.render(scene, camera);
    if (t < 1) requestAnimationFrame(rise);
  };
  place(0);
  requestAnimationFrame(rise);
  canvas.addEventListener('pointermove', (e) => {
    const r = canvas.getBoundingClientRect();
    group.rotation.y = ((e.clientX - r.left) / r.width - 0.5) * 0.35;
    group.rotation.x = ((e.clientY - r.top) / r.height - 0.5) * 0.12;
    request();
  });
}
