#!/usr/bin/env node
// npm run render:print -> renders/print_*.png : print previews of dist/print
//   print_mc_*        the 4 colour parts (parts/*.stl) loaded together = what the multi-colour print looks like
//   print_overhang_*  kubara.stl with faces steeper than 45 deg (need support) in red, thin spots (< 1.2 mm) in blue
//   print_scale       80 mm vs 120 mm side by side on a 10 mm grid
// Headless Google Chrome via puppeteer-core + three.js (served from node_modules).
import { createServer } from 'node:http';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join, extname, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';
import { PALETTE } from '../src/model/kubara.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(ROOT, 'renders');
const CHROME = process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const SIZE = Number(process.env.RENDER_SIZE || 1024);
const MIME = { '.js': 'text/javascript', '.html': 'text/html', '.stl': 'model/stl', '.json': 'application/json' };

const PAGE = /* html */ `<!doctype html><html><head><meta charset="utf-8">
<style>html,body{margin:0;background:#e9eef0}canvas{display:block}</style>
<script type="importmap">{"imports":{"three":"/node_modules/three/build/three.module.js","three/addons/":"/node_modules/three/examples/jsm/"}}</script>
</head><body><script type="module">
import * as THREE from 'three';
import { STLLoader } from 'three/addons/loaders/STLLoader.js';
import { mergeVertices, toCreasedNormals } from 'three/addons/utils/BufferGeometryUtils.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';

const SIZE = ${SIZE};
const renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
renderer.setPixelRatio(1); renderer.setSize(SIZE, SIZE);
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.NeutralToneMapping; renderer.toneMappingExposure = 0.9;
renderer.shadowMap.enabled = true; renderer.shadowMap.type = THREE.PCFSoftShadowMap;
document.body.appendChild(renderer.domElement);
const scene = new THREE.Scene();
scene.background = new THREE.Color('#e9eef0');
const pmrem = new THREE.PMREMGenerator(renderer);
scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
scene.environmentIntensity = 0.5;
scene.add(new THREE.HemisphereLight(0xffffff, 0xb8c4c6, 0.6));
const key = new THREE.DirectionalLight(0xffffff, 1.5);
key.position.set(80, 160, 140); key.castShadow = true; key.shadow.mapSize.set(2048, 2048);
Object.assign(key.shadow.camera, { left: -120, right: 120, top: 120, bottom: -120, near: 1, far: 600 });
key.shadow.bias = -0.0005; scene.add(key);
const rim = new THREE.DirectionalLight(0xffffff, 0.6); rim.position.set(-120, 90, -120); scene.add(rim);
// build plate: textured PEI-ish plane with a 10 mm grid (Y-up world, mm)
const plate = new THREE.Group();
const ground = new THREE.Mesh(new THREE.PlaneGeometry(400, 400), new THREE.MeshStandardMaterial({ color: 0x3b4144, roughness: 0.9 }));
ground.rotation.x = -Math.PI / 2; ground.receiveShadow = true; plate.add(ground);
const grid = new THREE.GridHelper(400, 40, 0x6b7478, 0x51595c); grid.position.y = 0.02; plate.add(grid);
scene.add(plate);
const camera = new THREE.PerspectiveCamera(26, 1, 1, 3000);
const root = new THREE.Group(); scene.add(root);
const loader = new STLLoader();
const D = Math.PI / 180;

async function geo(url, crease = 35) {
  let g = await loader.loadAsync(url);
  g.deleteAttribute('normal');
  g = toCreasedNormals(mergeVertices(g, 1e-4), crease * D);
  return g;
}
function place(mesh, dx = 0) { // printer frame (Z-up, mm, front -Y) -> Y-up world, front +Z
  mesh.rotation.x = -Math.PI / 2; mesh.position.x = dx; mesh.castShadow = mesh.receiveShadow = true; root.add(mesh);
}
window.showPlate = (v) => { plate.visible = v; };
window.clear = () => { while (root.children.length) root.remove(root.children[0]); };
// parts: [{url, color}]
window.loadParts = async (parts, dx = 0) => {
  for (const p of parts) {
    const mat = new THREE.MeshStandardMaterial({ color: new THREE.Color(p.color), roughness: p.rough ?? 0.7, metalness: 0 });
    place(new THREE.Mesh(await geo(p.url), mat), dx);
  }
};
// overhang map: per-face colour from the face normal in the printer frame; thin points as blue dots
window.loadOverhang = async (url, thresholdDeg, thin) => {
  let g = await loader.loadAsync(url); // non-indexed, flat
  const pos = g.attributes.position, n = pos.count / 3, col = new Float32Array(pos.count * 3);
  const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3(), nn = new THREE.Vector3();
  const lim = Math.sin(thresholdDeg * D);
  const ok = new THREE.Color('#c9ced1'), warn = new THREE.Color('#f2a33a'), bad = new THREE.Color('#e0322d');
  for (let i = 0; i < n; i++) {
    a.fromBufferAttribute(pos, 3 * i); b.fromBufferAttribute(pos, 3 * i + 1); c.fromBufferAttribute(pos, 3 * i + 2);
    nn.subVectors(c, b).cross(new THREE.Vector3().subVectors(a, b)).normalize();
    const zc = (a.z + b.z + c.z) / 3;
    const down = -nn.z;
    const k = zc < 0.05 ? ok : down > lim ? bad : down > Math.sin((thresholdDeg - 10) * D) ? warn : ok;
    for (let j = 0; j < 3; j++) col.set([k.r, k.g, k.b], 9 * i + 3 * j);
  }
  g.setAttribute('color', new THREE.BufferAttribute(col, 3));
  g.computeVertexNormals();
  place(new THREE.Mesh(g, new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.75, metalness: 0 })));
  const sg = new THREE.SphereGeometry(0.35, 10, 8), sm = new THREE.MeshBasicMaterial({ color: 0x1f6fff });
  const inst = new THREE.InstancedMesh(sg, sm, Math.max(1, thin.length));
  const m4 = new THREE.Matrix4();
  thin.forEach((p, i) => inst.setMatrixAt(i, m4.makeTranslation(p[0], p[2], -p[1])));
  inst.count = thin.length; root.add(inst);
};
window.shot = (target, dir, dist, fov = 26) => {
  camera.fov = fov; camera.up.set(0, 1, 0);
  const t = new THREE.Vector3(...target);
  camera.position.copy(t).add(new THREE.Vector3(...dir).normalize().multiplyScalar(dist));
  camera.lookAt(t); camera.updateProjectionMatrix();
  renderer.render(scene, camera);
  return renderer.domElement.toDataURL('image/png');
};
window.ready = true;
</script></body></html>`;

const server = createServer(async (req, res) => {
  try {
    const url = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    if (url === '/' || url === '/render.html') { res.writeHead(200, { 'content-type': 'text/html' }); return res.end(PAGE); }
    const p = normalize(join(ROOT, url));
    if (!p.startsWith(ROOT)) throw new Error('forbidden');
    const data = await readFile(p);
    res.writeHead(200, { 'content-type': MIME[extname(p)] || 'application/octet-stream' });
    res.end(data);
  } catch (e) { res.writeHead(404); res.end(String(e)); }
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}`;

const analysisPath = join(ROOT, 'dist/print/print-analysis.json');
const analysis = existsSync(analysisPath) ? JSON.parse(await readFile(analysisPath, 'utf8')) : null;
const thin = analysis?.thickness?.thinPoints ?? [];
const thr = analysis?.overhang?.thresholdDeg ?? 45;
const PARTS = [
  { url: '/dist/print/parts/fur.stl', color: PALETTE.fur },
  { url: '/dist/print/parts/fur_shade.stl', color: PALETTE.fur_shade },
  { url: '/dist/print/parts/ink.stl', color: PALETTE.ink, rough: 0.45 },
  { url: '/dist/print/parts/glint.stl', color: PALETTE.glint, rough: 0.4 },
];

const browser = await puppeteer.launch({
  executablePath: CHROME, headless: true,
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
  const save = async (name, args) => {
    const url = await page.evaluate((a) => window.shot(...a), args);
    await writeFile(join(OUT, name), Buffer.from(url.split(',')[1], 'base64'));
    console.log('renders/' + name);
  };
  const C = [0, 41, 0]; // figure centre (mm, Y-up world)

  await page.evaluate((p) => window.loadParts(p), PARTS);
  await save('print_mc_front.png', [C, [0, 0.12, 1], 215]);
  await save('print_mc_three_quarter.png', [C, [0.8, 0.3, 1], 215]);
  await save('print_mc_back.png', [C, [-0.5, 0.25, -1], 215]);
  await save('print_mc_face.png', [[0, 66, -6], [0.45, 0.12, 1], 95]);

  await page.evaluate(() => window.clear());
  await page.evaluate((u, t, th) => window.loadOverhang(u, t, th), '/dist/print/kubara.stl', thr, thin);
  await page.evaluate(() => window.showPlate(false)); // the low views look up from below the bed
  await save('print_overhang_front_low.png', [[0, 34, 0], [0.35, -0.35, 1], 230]);
  await save('print_overhang_side_low.png', [[0, 34, 0], [1, -0.3, 0.1], 230]);
  await save('print_overhang_back_low.png', [[0, 34, 0], [-0.4, -0.3, -1], 230]);
  await save('print_overhang_chin.png', [[0, 54, -10], [0.25, -0.75, 1], 110]);

  await page.evaluate(() => { window.clear(); window.showPlate(true); });
  await page.evaluate((p) => window.loadParts(p, -38), [{ url: '/dist/print/kubara.stl', color: PALETTE.fur }]);
  await page.evaluate((p) => window.loadParts(p, 48), [{ url: '/dist/print/kubara_120mm.stl', color: PALETTE.fur }]);
  await save('print_scale.png', [[12, 58, 0], [0, 0.22, 1], 440]);
} finally {
  await browser.close();
  server.close();
}
