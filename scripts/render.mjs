#!/usr/bin/env node
// npm run render -> renders/*.png  (dist/kubara.glb + print preview of dist/print/kubara.stl)
// Headless Google Chrome via puppeteer-core + three.js (served from node_modules).
import { createServer } from 'node:http';
import { readFile, mkdir, writeFile, stat } from 'node:fs/promises';
import { dirname, join, extname, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(ROOT, 'renders');
const CHROME = process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const SIZE = Number(process.env.RENDER_SIZE || 1024);

const MIME = { '.js': 'text/javascript', '.mjs': 'text/javascript', '.html': 'text/html', '.glb': 'model/gltf-binary', '.stl': 'model/stl', '.json': 'application/json', '.png': 'image/png' };

const PAGE = /* html */ `<!doctype html><html><head><meta charset="utf-8">
<style>html,body{margin:0;background:#eef1f2}canvas{display:block}</style>
<script type="importmap">{"imports":{"three":"/node_modules/three/build/three.module.js","three/addons/":"/node_modules/three/examples/jsm/"}}</script>
</head><body><script type="module">
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { STLLoader } from 'three/addons/loaders/STLLoader.js';
import { mergeVertices, toCreasedNormals } from 'three/addons/utils/BufferGeometryUtils.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';

const SIZE = ${SIZE};
const renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
renderer.setPixelRatio(1);
renderer.setSize(SIZE, SIZE);
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.NeutralToneMapping;
renderer.toneMappingExposure = 0.85;
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
document.body.appendChild(renderer.domElement);

const scene = new THREE.Scene();
scene.background = new THREE.Color('#eef1f2');
const pmrem = new THREE.PMREMGenerator(renderer);
scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
scene.environmentIntensity = 0.45;
scene.add(new THREE.HemisphereLight(0xffffff, 0xb8c4c6, 0.55));
const key = new THREE.DirectionalLight(0xffffff, 1.6);
key.position.set(1.4, 2.6, 2.2);
key.castShadow = true;
key.shadow.mapSize.set(2048, 2048);
Object.assign(key.shadow.camera, { left: -1, right: 1, top: 1, bottom: -1, near: 0.1, far: 8 });
key.shadow.radius = 6; key.shadow.bias = -0.0005;
scene.add(key);
const rim = new THREE.DirectionalLight(0xffffff, 0.7);
rim.position.set(-2, 1.5, -2);
scene.add(rim);
const ground = new THREE.Mesh(new THREE.CircleGeometry(3, 64), new THREE.ShadowMaterial({ opacity: 0.18 }));
ground.rotation.x = -Math.PI / 2; ground.receiveShadow = true;
scene.add(ground);

const camera = new THREE.PerspectiveCamera(26, 1, 0.01, 50);
let current = null;

function frame(obj, dir, upv) {
  const box = new THREE.Box3().setFromObject(obj);
  const c = box.getCenter(new THREE.Vector3());
  const sphere = box.getBoundingSphere(new THREE.Sphere());
  const dist = sphere.radius / Math.sin((camera.fov * Math.PI) / 360) * 1.02;
  camera.up.set(...upv);
  camera.position.copy(c).add(new THREE.Vector3(...dir).normalize().multiplyScalar(dist));
  camera.lookAt(c);
  camera.updateProjectionMatrix();
}

window.loadGLB = async (url) => {
  if (current) scene.remove(current);
  const gltf = await new GLTFLoader().loadAsync(url);
  current = gltf.scene;
  current.traverse((o) => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; } });
  scene.add(current);
  const names = []; current.traverse((o) => names.push(o.name));
  return names;
};
window.loadSTL = async (url) => {
  if (current) scene.remove(current);
  // STL triangles are unshared: weld them and use creased smooth normals (35 deg) so the preview shows the real
  // surface rather than per-triangle facet shading of the simplified mesh (deviation < 0.03 mm)
  let geo = await new STLLoader().loadAsync(url);
  geo.deleteAttribute('normal');
  geo = toCreasedNormals(mergeVertices(geo, 1e-4), (35 * Math.PI) / 180);
  const mesh = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({ color: 0xa9adb1, roughness: 0.62, metalness: 0 }));
  mesh.castShadow = mesh.receiveShadow = true;
  // printer frame (Z-up, mm) -> Y-up metres-ish (height ~1)
  geo.computeBoundingBox();
  const h = geo.boundingBox.max.z - geo.boundingBox.min.z;
  const g = new THREE.Group();
  mesh.rotation.x = -Math.PI / 2;
  g.add(mesh); g.scale.setScalar(1 / h);
  current = g;
  scene.add(current);
  return { tris: geo.attributes.position.count / 3, heightMM: h };
};
window.shot = (dir, up = [0, 1, 0]) => {
  frame(current, dir, up);
  renderer.render(scene, camera);
  return renderer.domElement.toDataURL('image/png');
};
// close-up: look at target from direction dir at distance dist
window.shotAt = (target, dir, dist, upv = [0, 1, 0], fov = 26) => {
  camera.fov = fov; camera.up.set(...upv);
  const t = new THREE.Vector3(...target);
  camera.position.copy(t).add(new THREE.Vector3(...dir).normalize().multiplyScalar(dist));
  camera.lookAt(t); camera.updateProjectionMatrix();
  renderer.render(scene, camera);
  camera.fov = 26;
  return renderer.domElement.toDataURL('image/png');
};
// pose: { nodeName: [rxDeg, ryDeg, rzDeg] } applied on top of the rest pose (all others reset)
const D = Math.PI / 180;
window.pose = (spec) => {
  current.traverse((o) => { if (o.userData.rest === undefined) o.userData.rest = o.quaternion.clone(); o.quaternion.copy(o.userData.rest); });
  for (const [n, r] of Object.entries(spec)) {
    const o = current.getObjectByName(n);
    if (!o) throw new Error('no node ' + n);
    o.quaternion.multiply(new THREE.Quaternion().setFromEuler(new THREE.Euler(r[0] * D, r[1] * D, r[2] * D, 'XYZ')));
  }
  current.updateMatrixWorld(true);
};
window.ready = true;
</script></body></html>`;

const server = createServer(async (req, res) => {
  try {
    const url = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    if (url === '/' || url === '/render.html') {
      res.writeHead(200, { 'content-type': 'text/html' });
      return res.end(PAGE);
    }
    const p = normalize(join(ROOT, url));
    if (!p.startsWith(ROOT)) throw new Error('forbidden');
    const data = await readFile(p);
    res.writeHead(200, { 'content-type': MIME[extname(p)] || 'application/octet-stream' });
    res.end(data);
  } catch (e) {
    res.writeHead(404); res.end(String(e));
  }
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}`;

const VIEWS = [
  ['front', [0, 0.08, 1]],
  ['three_quarter', [0.85, 0.22, 1]],
  ['side', [1, 0.06, 0]],
  ['back', [0, 0.12, -1]],
  ['top', [0, 1, 0.0001], [0, 0, -1]],
];

// close-ups of the face / accessories: [name, target, dir, dist]
const CLOSE = [
  ['face_front', [0, 0.78, 0.1], [0, 0.05, 1], 1.15],
  ['face_3q', [0, 0.78, 0.05], [0.8, 0.15, 1], 1.2],
  ['face_side', [0, 0.76, 0.0], [1, 0.05, 0], 1.3],
  ['head_back3q', [0, 0.8, -0.05], [-0.8, 0.45, -1], 1.25],
  ['head_top', [0, 0.85, 0.0], [0, 1, 0.25], 1.3],
  ['feet', [0, 0.18, 0.1], [0.5, 0.35, 1], 1.4],
];
// automated pose test (rigid parts must never open holes): [name, pose, target, dir, dist]
const POSES = [
  ['head_yaw25', { head: [0, 25, 0] }, [0, 0.6, 0], [-0.7, 0.2, -1], 2.9],
  ['head_yaw-25_front', { head: [0, -25, 0] }, [0, 0.6, 0], [0.4, 0.15, 1], 2.9],
  ['head_pitch15', { head: [15, 0, 0] }, [0, 0.6, 0], [1, 0.1, -0.35], 2.9],
  ['head_pitch-15', { head: [-15, 0, 0] }, [0, 0.6, 0], [-1, 0.25, -0.6], 2.9],
  ['arms_swing45', { arm_l: [45, 0, 0], arm_r: [-45, 0, 0] }, [0, 0.5, 0], [1, 0.15, 0.25], 2.6],
  ['wave140', { arm_l: [0, 0, 140], arm_r: [0, 0, -140], head: [0, 0, 6] }, [0, 0.6, 0], [0.3, 0.1, 1], 3.0],
  ['wave140_back', { arm_l: [0, 0, 140], arm_r: [0, 0, -140] }, [0, 0.6, 0], [-0.4, 0.2, -1], 3.0],
  ['walk35', { leg_l: [-35, 0, 0], leg_r: [35, 0, 0], arm_l: [30, 0, 0], arm_r: [-30, 0, 0], body: [0, 0, 3] }, [0, 0.45, 0], [1, 0.2, 0.15], 2.8],
  ['walk35_back_low', { leg_l: [-35, 0, 0], leg_r: [35, 0, 0] }, [0, 0.3, 0], [-0.6, 0.1, -1], 2.6],
];

const ONLY = process.argv.slice(2).find((a) => a.startsWith('--only='))?.slice(7);
const want = (k) => !ONLY || ONLY.split(',').includes(k);

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: true,
  args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', `--window-size=${SIZE},${SIZE}`],
});
try {
  const page = await browser.newPage();
  page.on('console', (m) => { if (m.type() === 'error') console.error('[page]', m.text()); });
  page.on('pageerror', (e) => console.error('[page error]', e.message));
  await page.setViewport({ width: SIZE, height: SIZE });
  await page.goto(`${base}/render.html`);
  await page.waitForFunction('window.ready === true', { timeout: 30000 });
  await mkdir(OUT, { recursive: true });
  const save = async (name, dataUrl) => {
    await writeFile(join(OUT, name), Buffer.from(dataUrl.split(',')[1], 'base64'));
    console.log('renders/' + name);
  };

  const names = await page.evaluate((u) => window.loadGLB(u), '/dist/kubara.glb');
  console.log('GLB nodes:', names.filter(Boolean).join(', '));
  if (want('views')) for (const [name, dir, up] of VIEWS) await save(`${name}.png`, await page.evaluate((d, u) => window.shot(d, u), dir, up));
  if (want('close')) for (const [name, tg, dir, dist] of CLOSE) await save(`close_${name}.png`, await page.evaluate((t, d, s) => window.shotAt(t, d, s), tg, dir, dist));
  if (want('poses')) {
    for (const [name, spec, tg, dir, dist] of POSES) {
      await page.evaluate((p) => window.pose(p), spec);
      await save(`pose_${name}.png`, await page.evaluate((t, d, s) => window.shotAt(t, d, s), tg, dir, dist));
    }
    await page.evaluate(() => window.pose({}));
  }

  const stlPath = join(ROOT, 'dist/print/kubara.stl');
  if (want('print') && await stat(stlPath).catch(() => null)) {
    const info = await page.evaluate((u) => window.loadSTL(u), '/dist/print/kubara.stl');
    console.log('STL:', info);
    for (const [name, dir, up] of VIEWS.slice(0, 4)) await save(`print_${name}.png`, await page.evaluate((d, u) => window.shot(d, u), dir, up));
    // print close-ups (STL is normalised to height 1 incl. the base, so targets shift up ~0.035)
    for (const [name, tg, dir, dist] of CLOSE.filter(([n]) => ['face_side', 'face_3q', 'head_back3q', 'feet'].includes(n))) {
      await save(`print_close_${name}.png`, await page.evaluate((t, d, s) => window.shotAt(t, d, s), [tg[0], tg[1] + 0.035, tg[2]], dir, dist));
    }
  }
} finally {
  await browser.close();
  server.close();
}
