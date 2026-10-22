// Cozy low-poly world: rolling meadow, a steaming onsen pond, trees, rocks, flowers, a sign
// and yuzu to collect. Everything is procedural (seeded) so there are no extra assets.

import * as THREE from 'three';

export const WORLD_RADIUS = 26;            // walkable radius
export const WATER_LEVEL = 0;
export const POND = { x: -5.5, z: 6.5, r: 4.6 };

// ---------------------------------------------------------------- helpers

export function mulberry32(seed) {
  return () => {
    seed |= 0; seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const smoothstep = (a, b, x) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};
const lerp = (a, b, t) => a + (b - a) * t;

/** Height of the ground at (x, z). The pond basin dips below WATER_LEVEL. */
export function terrainHeight(x, z) {
  const r = Math.hypot(x, z);
  let h = 0.45 * Math.sin(x * 0.17 + 0.4) * Math.cos(z * 0.14 - 0.3)
        + 0.25 * Math.sin(x * 0.07 + z * 0.11 + 1.3)
        + 0.12 * Math.sin(x * 0.41 - z * 0.37);
  h = h * smoothstep(2.5, 9, r) + 0.08;          // flat-ish clearing at spawn
  h += smoothstep(WORLD_RADIUS - 2, WORLD_RADIUS + 10, r) * 3.5; // hills ring the meadow
  const d = Math.hypot(x - POND.x, z - POND.z);
  const basin = 1 - smoothstep(POND.r * 0.45, POND.r * 1.08, d);
  h = lerp(h * smoothstep(POND.r, POND.r * 2.2, d) + 0.12, -0.5, basin);
  return h;
}

function flatToon(color, extra = {}) {
  return new THREE.MeshToonMaterial({ color, ...extra });
}

function jitterGeometry(geo, rand, amount) {
  if (geo.index) geo = geo.toNonIndexed();
  const pos = geo.attributes.position;
  const seen = new Map();
  for (let i = 0; i < pos.count; i++) {
    const key = `${pos.getX(i).toFixed(3)},${pos.getY(i).toFixed(3)},${pos.getZ(i).toFixed(3)}`;
    let off = seen.get(key);
    if (!off) { off = [(rand() - 0.5) * amount, (rand() - 0.5) * amount, (rand() - 0.5) * amount]; seen.set(key, off); }
    pos.setXYZ(i, pos.getX(i) + off[0], pos.getY(i) + off[1], pos.getZ(i) + off[2]);
  }
  geo.computeVertexNormals();
  return geo;
}

function softDotTexture() {
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const g = c.getContext('2d');
  const grd = g.createRadialGradient(32, 32, 0, 32, 32, 32);
  grd.addColorStop(0, 'rgba(255,255,255,1)');
  grd.addColorStop(0.4, 'rgba(255,255,255,0.55)');
  grd.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = grd;
  g.fillRect(0, 0, 64, 64);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

// ---------------------------------------------------------------- world

export function createWorld(scene) {
  const rand = mulberry32(7);
  const colliders = [];       // { x, z, r }
  const updaters = [];        // (dt, t) => void
  const group = new THREE.Group();
  group.name = 'world';
  scene.add(group);

  // sky dome with a soft vertical gradient
  const skyGeo = new THREE.SphereGeometry(120, 32, 16);
  const skyMat = new THREE.ShaderMaterial({
    side: THREE.BackSide, depthWrite: false, fog: false,
    uniforms: { top: { value: new THREE.Color('#7cc7e8') }, horizon: { value: new THREE.Color('#e9f6f1') }, bottom: { value: new THREE.Color('#cfe8d6') } },
    vertexShader: 'varying vec3 vP; void main(){ vP = normalize(position); gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }',
    fragmentShader: `uniform vec3 top; uniform vec3 horizon; uniform vec3 bottom; varying vec3 vP;
      void main(){ float h = vP.y; vec3 c = h > 0.0 ? mix(horizon, top, pow(smoothstep(0.0, 0.75, h), 0.8)) : mix(horizon, bottom, smoothstep(0.0, -0.2, h));
      gl_FragColor = vec4(c, 1.0); }`,
  });
  const sky = new THREE.Mesh(skyGeo, skyMat);
  sky.name = 'sky';
  sky.renderOrder = -1;
  group.add(sky);
  updaters.push((dt, t, camera) => sky.position.copy(camera.position));

  // fluffy low-poly clouds
  const cloudMat = flatToon('#ffffff', { transparent: true, opacity: 0.95 });
  for (let i = 0; i < 9; i++) {
    const cloud = new THREE.Group();
    const n = 3 + Math.floor(rand() * 3);
    for (let j = 0; j < n; j++) {
      const s = 1.6 + rand() * 1.6;
      const puff = new THREE.Mesh(new THREE.IcosahedronGeometry(s, 0), cloudMat);
      puff.position.set((j - n / 2) * 1.7, rand() * 0.8, rand() * 1.2);
      puff.scale.y = 0.6;
      cloud.add(puff);
    }
    const a = (i / 9) * Math.PI * 2 + rand();
    cloud.position.set(Math.cos(a) * 55, 20 + rand() * 9, Math.sin(a) * 55);
    cloud.lookAt(0, cloud.position.y, 0);
    group.add(cloud);
    const speed = 0.02 + rand() * 0.02;
    updaters.push((dt) => {
      const ang = Math.atan2(cloud.position.z, cloud.position.x) + speed * dt;
      cloud.position.x = Math.cos(ang) * 55; cloud.position.z = Math.sin(ang) * 55;
      cloud.lookAt(0, cloud.position.y, 0);
    });
  }

  // terrain: flat-shaded faces, colours by height/slope/pond distance
  const SIZE = 110, SEG = 110;
  const plane = new THREE.PlaneGeometry(SIZE, SIZE, SEG, SEG);
  plane.rotateX(-Math.PI / 2);
  const p = plane.attributes.position;
  for (let i = 0; i < p.count; i++) {
    const x = p.getX(i) + (rand() - 0.5) * 0.35, z = p.getZ(i) + (rand() - 0.5) * 0.35;
    p.setXYZ(i, x, terrainHeight(x, z), z);
  }
  const ground = plane.toNonIndexed();
  ground.computeVertexNormals();
  const gp = ground.attributes.position;
  const colors = new Float32Array(gp.count * 3);
  const cGrassA = new THREE.Color('#8fcf6a'), cGrassB = new THREE.Color('#7cc161'), cGrassC = new THREE.Color('#a3d977');
  const cSand = new THREE.Color('#ecd9a0'), cWet = new THREE.Color('#b9a876'), cHill = new THREE.Color('#6fae5a');
  const tmp = new THREE.Color();
  for (let f = 0; f < gp.count; f += 3) {
    const cx = (gp.getX(f) + gp.getX(f + 1) + gp.getX(f + 2)) / 3;
    const cy = (gp.getY(f) + gp.getY(f + 1) + gp.getY(f + 2)) / 3;
    const cz = (gp.getZ(f) + gp.getZ(f + 1) + gp.getZ(f + 2)) / 3;
    const dp = Math.hypot(cx - POND.x, cz - POND.z);
    const r = rand();
    tmp.copy(r < 0.33 ? cGrassA : r < 0.66 ? cGrassB : cGrassC);
    if (Math.hypot(cx, cz) > WORLD_RADIUS + 2) tmp.lerp(cHill, 0.6);
    if (dp < POND.r * 1.32) tmp.copy(cy < 0.02 ? cWet : cSand);
    // a path from spawn to the pond
    const t = Math.max(0, Math.min(1, (cx * POND.x + cz * POND.z) / (POND.x ** 2 + POND.z ** 2)));
    const pathD = Math.hypot(cx - POND.x * t, cz - POND.z * t);
    if (pathD < 0.75 && dp > POND.r * 1.1 && Math.hypot(cx, cz) > 1.2) tmp.lerp(cSand, 0.75);
    for (let k = 0; k < 3; k++) colors.set([tmp.r, tmp.g, tmp.b], (f + k) * 3);
  }
  ground.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  const groundMesh = new THREE.Mesh(ground, new THREE.MeshLambertMaterial({ vertexColors: true, flatShading: true }));
  groundMesh.name = 'ground';
  groundMesh.receiveShadow = true;
  group.add(groundMesh);

  // ------------------------------------------------ pond (a little onsen)
  const waterGeo = new THREE.CircleGeometry(POND.r * 1.15, 72);
  waterGeo.rotateX(-Math.PI / 2);
  const waterMat = new THREE.MeshPhongMaterial({ color: '#4fc3cf', transparent: true, opacity: 0.78, shininess: 90, specular: new THREE.Color('#ffffff') });
  const waterUniforms = { uTime: { value: 0 } };
  waterMat.onBeforeCompile = (shader) => {
    shader.uniforms.uTime = waterUniforms.uTime;
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vWP;')
      .replace('#include <worldpos_vertex>', '#include <worldpos_vertex>\nvWP = (modelMatrix * vec4(transformed,1.0)).xyz;');
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\nuniform float uTime; varying vec3 vWP;')
      .replace('#include <dithering_fragment>', `#include <dithering_fragment>
        float w = sin(vWP.x * 2.3 + uTime * 1.1) * sin(vWP.z * 2.1 - uTime * 0.9) + sin((vWP.x + vWP.z) * 3.7 + uTime * 1.7) * 0.5;
        float band = smoothstep(0.92, 1.05, w);
        gl_FragColor.rgb = mix(gl_FragColor.rgb, vec3(0.93, 1.0, 1.0), band * 0.45);`);
  };
  const water = new THREE.Mesh(waterGeo, waterMat);
  water.name = 'pond';
  water.position.set(POND.x, WATER_LEVEL, POND.z);
  water.receiveShadow = true;
  group.add(water);
  updaters.push((dt, t) => { waterUniforms.uTime.value = t; });

  // lily pads
  const padMat = flatToon('#5fae4e', { side: THREE.DoubleSide });
  for (let i = 0; i < 7; i++) {
    const pad = new THREE.Mesh(new THREE.CircleGeometry(0.28 + rand() * 0.18, 10, 0.3, Math.PI * 2 - 0.6), padMat);
    pad.rotation.x = -Math.PI / 2;
    pad.rotation.z = rand() * Math.PI * 2;
    const a = rand() * Math.PI * 2, d = POND.r * (0.35 + rand() * 0.5);
    pad.position.set(POND.x + Math.cos(a) * d, WATER_LEVEL + 0.012, POND.z + Math.sin(a) * d);
    pad.receiveShadow = true;
    group.add(pad);
    if (i % 3 === 0) {
      const flower = new THREE.Mesh(new THREE.ConeGeometry(0.08, 0.12, 5), flatToon('#ffb7d0'));
      flower.position.set(0.05, 0.05, 0);
      flower.rotation.x = Math.PI / 2;
      pad.add(flower);
    }
    const ph = rand() * 10;
    updaters.push((dt, t) => { pad.position.y = WATER_LEVEL + 0.012 + Math.sin(t * 1.3 + ph) * 0.008; });
  }

  // stones ringing the onsen
  const stoneMat = flatToon('#9aa3a6');
  for (let i = 0; i < 26; i++) {
    const a = (i / 26) * Math.PI * 2 + rand() * 0.1;
    if (Math.abs(((a - Math.atan2(-POND.z, -POND.x) + Math.PI * 3) % (Math.PI * 2)) - Math.PI) < 0.35) continue; // leave the path open
    const s = 0.25 + rand() * 0.2;
    const st = new THREE.Mesh(jitterGeometry(new THREE.DodecahedronGeometry(s, 0), rand, s * 0.35), stoneMat);
    const d = POND.r * (1.08 + rand() * 0.08);
    const x = POND.x + Math.cos(a) * d, z = POND.z + Math.sin(a) * d;
    st.position.set(x, terrainHeight(x, z) - s * 0.25, z);
    st.scale.y = 0.7;
    st.rotation.y = rand() * 3;
    st.castShadow = st.receiveShadow = true;
    group.add(st);
  }

  // steam wisps over the warm water
  const steamTex = softDotTexture();
  const steamMat = new THREE.SpriteMaterial({ map: steamTex, color: '#ffffff', transparent: true, opacity: 0.35, depthWrite: false });
  const wisps = [];
  for (let i = 0; i < 18; i++) {
    const sp = new THREE.Sprite(steamMat.clone());
    sp.userData = { a: rand() * Math.PI * 2, d: rand() * POND.r * 0.8, t: rand() * 4, life: 3.5 + rand() * 2 };
    group.add(sp);
    wisps.push(sp);
  }
  updaters.push((dt) => {
    for (const sp of wisps) {
      const u = sp.userData;
      u.t += dt;
      if (u.t > u.life) { u.t = 0; u.a = Math.random() * Math.PI * 2; u.d = Math.random() * POND.r * 0.8; }
      const k = u.t / u.life;
      sp.position.set(POND.x + Math.cos(u.a) * u.d + Math.sin(k * 6 + u.a) * 0.2, WATER_LEVEL + 0.1 + k * 1.6, POND.z + Math.sin(u.a) * u.d);
      const s = 0.5 + k * 1.1;
      sp.scale.set(s, s, s);
      sp.material.opacity = Math.sin(k * Math.PI) * 0.28;
    }
  });

  // ------------------------------------------------ trees
  const trunkMat = flatToon('#9b6b43');
  const leafMats = ['#5fb158', '#6cbf5f', '#4fa24f', '#7cc96a'].map((c) => flatToon(c));
  const pineMat = flatToon('#3f8f5a');
  const blossomMat = flatToon('#ffc6d9');
  const placed = [];
  const free = (x, z, r) => {
    if (Math.hypot(x, z) < 4) return false;
    if (Math.hypot(x - POND.x, z - POND.z) < POND.r + 1.6 + r) return false;
    if (Math.hypot(x - 3.5, z - 3.2) < 2) return false; // sign
    return placed.every((q) => Math.hypot(q.x - x, q.z - z) > q.r + r + 0.6);
  };
  const place = (r, minR, maxR) => {
    for (let tries = 0; tries < 200; tries++) {
      const a = rand() * Math.PI * 2, d = minR + rand() * (maxR - minR);
      const x = Math.cos(a) * d, z = Math.sin(a) * d;
      if (free(x, z, r)) { placed.push({ x, z, r }); return { x, z }; }
    }
    return null;
  };

  const trees = [];
  for (let i = 0; i < 34; i++) {
    const inner = i < 16;
    const spot = place(1.1, inner ? 6 : WORLD_RADIUS - 4, inner ? WORLD_RADIUS - 3 : WORLD_RADIUS + 6);
    if (!spot) continue;
    const tree = new THREE.Group();
    const s = 0.85 + rand() * 0.6;
    const kind = rand();
    const trunk = new THREE.Mesh(new THREE.CylinderGeometry(0.13 * s, 0.2 * s, 1.3 * s, 6), trunkMat);
    trunk.position.y = 0.65 * s;
    trunk.castShadow = true;
    tree.add(trunk);
    let crown;
    if (kind < 0.3) {
      crown = new THREE.Group();
      for (let k = 0; k < 3; k++) {
        const cone = new THREE.Mesh(new THREE.ConeGeometry((1.0 - k * 0.24) * s, 1.1 * s, 7), pineMat);
        cone.position.y = (1.3 + k * 0.62) * s;
        cone.castShadow = true;
        crown.add(cone);
      }
    } else {
      crown = new THREE.Group();
      const mat = kind > 0.9 ? blossomMat : leafMats[Math.floor(rand() * leafMats.length)];
      const blobs = 2 + Math.floor(rand() * 2);
      for (let k = 0; k < blobs; k++) {
        const r = (0.75 + rand() * 0.35) * s;
        const blob = new THREE.Mesh(jitterGeometry(new THREE.IcosahedronGeometry(r, 1), rand, r * 0.12), mat);
        blob.position.set((rand() - 0.5) * 0.8 * s, (1.7 + k * 0.45) * s, (rand() - 0.5) * 0.8 * s);
        blob.castShadow = true;
        blob.receiveShadow = true;
        crown.add(blob);
      }
    }
    tree.add(crown);
    tree.position.set(spot.x, terrainHeight(spot.x, spot.z) - 0.05, spot.z);
    tree.rotation.y = rand() * Math.PI * 2;
    group.add(tree);
    trees.push(tree);
    colliders.push({ x: spot.x, z: spot.z, r: 0.35 * s });
    const ph = rand() * 10;
    updaters.push((dt, t) => { crown.rotation.z = Math.sin(t * 0.9 + ph) * 0.018; crown.rotation.x = Math.sin(t * 0.7 + ph) * 0.012; });
  }

  // ------------------------------------------------ rocks
  const rockMat = flatToon('#a7adb0');
  const mossMat = flatToon('#8bbd6a');
  for (let i = 0; i < 16; i++) {
    const s = 0.35 + rand() * 0.6;
    const spot = place(s, 5, WORLD_RADIUS);
    if (!spot) continue;
    const rock = new THREE.Mesh(jitterGeometry(new THREE.DodecahedronGeometry(s, 0), rand, s * 0.4), rockMat);
    rock.scale.set(1, 0.65 + rand() * 0.3, 1);
    rock.rotation.y = rand() * Math.PI;
    rock.position.set(spot.x, terrainHeight(spot.x, spot.z) + s * 0.15, spot.z);
    rock.castShadow = rock.receiveShadow = true;
    if (rand() < 0.5) {
      const moss = new THREE.Mesh(new THREE.SphereGeometry(s * 0.55, 6, 3, 0, Math.PI * 2, 0, Math.PI / 2), mossMat);
      moss.position.y = s * 0.5;
      moss.scale.y = 0.35;
      rock.add(moss);
    }
    group.add(rock);
    colliders.push({ x: spot.x, z: spot.z, r: s * 0.9 });
  }

  // ------------------------------------------------ grass tufts & flowers (instanced)
  const tuftGeo = new THREE.ConeGeometry(0.06, 0.28, 3);
  tuftGeo.translate(0, 0.14, 0);
  const tufts = new THREE.InstancedMesh(tuftGeo, flatToon('#6db456'), 900);
  const flowerGeo = new THREE.IcosahedronGeometry(0.06, 0);
  flowerGeo.translate(0, 0.16, 0);
  const flowers = new THREE.InstancedMesh(flowerGeo, new THREE.MeshToonMaterial({ color: '#ffffff' }), 260);
  const petal = ['#ffffff', '#ffd166', '#ff9fc2', '#c8b6ff'].map((c) => new THREE.Color(c));
  const m = new THREE.Matrix4(), q = new THREE.Quaternion(), sc = new THREE.Vector3(), ps = new THREE.Vector3(), up = new THREE.Vector3(0, 1, 0);
  let ti = 0, fi = 0;
  while (ti < tufts.count || fi < flowers.count) {
    const a = rand() * Math.PI * 2, d = Math.sqrt(rand()) * (WORLD_RADIUS + 4);
    const x = Math.cos(a) * d, z = Math.sin(a) * d;
    if (Math.hypot(x - POND.x, z - POND.z) < POND.r * 1.35) continue;
    const y = terrainHeight(x, z);
    q.setFromAxisAngle(up, rand() * Math.PI * 2);
    if (ti < tufts.count) {
      const s = 0.7 + rand() * 0.8;
      for (let k = 0; k < 3 && ti < tufts.count; k++, ti++) {
        sc.set(s, s * (0.8 + rand() * 0.5), s);
        ps.set(x + (rand() - 0.5) * 0.15, y - 0.02, z + (rand() - 0.5) * 0.15);
        q.setFromAxisAngle(new THREE.Vector3(rand() - 0.5, 4, rand() - 0.5).normalize(), rand() * 0.4);
        tufts.setMatrixAt(ti, m.compose(ps, q, sc));
      }
    } else {
      sc.setScalar(0.8 + rand() * 0.6);
      ps.set(x, y, z);
      flowers.setMatrixAt(fi, m.compose(ps, q, sc));
      flowers.setColorAt(fi, petal[Math.floor(rand() * petal.length)]);
      fi++;
    }
  }
  tufts.receiveShadow = true;
  group.add(tufts, flowers);

  // ------------------------------------------------ signpost
  const sign = new THREE.Group();
  const post = new THREE.Mesh(new THREE.BoxGeometry(0.12, 1.3, 0.12), trunkMat);
  post.position.y = 0.65;
  post.castShadow = true;
  const canvas = document.createElement('canvas');
  canvas.width = 512; canvas.height = 256;
  const g = canvas.getContext('2d');
  g.fillStyle = '#c8935f'; g.fillRect(0, 0, 512, 256);
  g.fillStyle = '#b07d4c'; for (let y = 30; y < 256; y += 58) g.fillRect(0, y, 512, 6);
  g.fillStyle = '#0a0f0f';
  g.font = 'bold 92px ui-rounded, "Avenir Next", system-ui, sans-serif';
  g.textAlign = 'center'; g.textBaseline = 'middle';
  g.fillText('kubara', 256, 105);
  g.font = 'bold 42px ui-rounded, "Avenir Next", system-ui, sans-serif';
  g.fillText('onsen  →', 256, 190);
  const signTex = new THREE.CanvasTexture(canvas);
  signTex.colorSpace = THREE.SRGBColorSpace;
  const boardMats = [trunkMat, trunkMat, trunkMat, trunkMat, new THREE.MeshToonMaterial({ map: signTex }), trunkMat];
  const board = new THREE.Mesh(new THREE.BoxGeometry(1.2, 0.6, 0.08), boardMats);
  board.position.set(0, 1.15, 0.1); // in front of the post (the post must not poke through the lettering)
  board.castShadow = true;
  sign.add(post, board);
  sign.position.set(3.5, terrainHeight(3.5, 3.2), 3.2);
  sign.lookAt(0, sign.position.y, 0);
  sign.rotateY(0.35);
  group.add(sign);
  colliders.push({ x: 3.5, z: 3.2, r: 0.25 });

  return { group, colliders, updaters, water, ground: groundMesh, trees };
}

// ---------------------------------------------------------------- yuzu collectibles

export function createYuzu(scene, count = 12) {
  const rand = mulberry32(42);
  const fruitGeo = new THREE.IcosahedronGeometry(0.16, 2);
  fruitGeo.scale(1, 0.92, 1);
  const fruitMat = new THREE.MeshToonMaterial({ color: '#ffbf2e', emissive: new THREE.Color('#5a3200') });
  const leafGeo = new THREE.ConeGeometry(0.06, 0.16, 4);
  leafGeo.rotateZ(Math.PI / 2.6);
  const leafMat = new THREE.MeshToonMaterial({ color: '#4caf50' });
  const glowTex = softDotTexture();

  const items = [];
  const spots = [];
  // a few float in the onsen (capybaras + yuzu baths are a thing), the rest are around the meadow
  for (let i = 0; i < 3; i++) {
    const a = (i / 3) * Math.PI * 2 + 0.6;
    spots.push([POND.x + Math.cos(a) * POND.r * 0.45, POND.z + Math.sin(a) * POND.r * 0.45, true]);
  }
  spots.push([0, 2.6, false]); // one right in front of the spawn
  while (spots.length < count) {
    const a = rand() * Math.PI * 2, d = 5 + rand() * (WORLD_RADIUS - 8);
    const x = Math.cos(a) * d, z = Math.sin(a) * d;
    if (Math.hypot(x - POND.x, z - POND.z) < POND.r * 1.4) continue;
    if (spots.some(([sx, sz]) => Math.hypot(sx - x, sz - z) < 4)) continue;
    spots.push([x, z, false]);
  }
  for (const [x, z, floating] of spots) {
    const g = new THREE.Group();
    const fruit = new THREE.Mesh(fruitGeo, fruitMat);
    fruit.castShadow = true;
    const leaf = new THREE.Mesh(leafGeo, leafMat);
    leaf.position.set(0.06, 0.15, 0);
    fruit.add(leaf);
    const glow = new THREE.Sprite(new THREE.SpriteMaterial({ map: glowTex, color: '#fff2a8', transparent: true, opacity: 0.5, depthWrite: false }));
    glow.scale.setScalar(0.75);
    g.add(glow, fruit);
    const base = floating ? WATER_LEVEL + 0.1 : terrainHeight(x, z) + 0.45;
    g.position.set(x, base, z);
    g.userData = { base, floating, phase: rand() * 10, fruit, glow, collected: false, pop: 0 };
    scene.add(g);
    items.push(g);
  }

  // pickup sparkles
  const sparkGeo = new THREE.OctahedronGeometry(0.035, 0);
  const sparkMat = new THREE.MeshBasicMaterial({ color: '#fff3b0' });
  const sparks = [];

  function burst(pos) {
    for (let i = 0; i < 14; i++) {
      const s = new THREE.Mesh(sparkGeo, sparkMat);
      s.position.copy(pos);
      const a = Math.random() * Math.PI * 2;
      s.userData = { v: new THREE.Vector3(Math.cos(a) * (1 + Math.random()), 2 + Math.random() * 2, Math.sin(a) * (1 + Math.random())), life: 0.7 };
      scene.add(s);
      sparks.push(s);
    }
  }

  function update(dt, t) {
    for (const g of items) {
      const u = g.userData;
      if (u.collected) {
        if (u.pop > 0) {
          u.pop = Math.max(0, u.pop - dt * 3);
          const s = u.pop > 0.6 ? 1 + (1 - u.pop) * 2 : u.pop * 1.6;
          g.scale.setScalar(Math.max(0.001, s));
          g.position.y += dt * 1.5;
          if (u.pop === 0) g.visible = false;
        }
        continue;
      }
      g.position.y = u.base + Math.sin(t * 2 + u.phase) * (u.floating ? 0.025 : 0.08);
      u.fruit.rotation.y += dt * 1.4;
      u.glow.material.opacity = 0.35 + Math.sin(t * 3 + u.phase) * 0.12;
    }
    for (let i = sparks.length - 1; i >= 0; i--) {
      const s = sparks[i];
      s.userData.life -= dt;
      s.userData.v.y -= 9 * dt;
      s.position.addScaledVector(s.userData.v, dt);
      s.rotation.x += dt * 8;
      s.scale.setScalar(Math.max(0.01, s.userData.life / 0.7));
      if (s.userData.life <= 0) { scene.remove(s); sparks.splice(i, 1); }
    }
  }

  /** returns number of newly collected items near `pos` */
  function collect(pos, radius = 0.75) {
    let n = 0;
    for (const g of items) {
      const u = g.userData;
      if (u.collected) continue;
      const dx = g.position.x - pos.x, dz = g.position.z - pos.z, dy = g.position.y - (pos.y + 0.5);
      if (dx * dx + dz * dz < radius * radius && Math.abs(dy) < 1.0) {
        u.collected = true;
        u.pop = 1;
        burst(g.position);
        n++;
      }
    }
    return n;
  }

  return { items, update, collect, total: items.length };
}

// ---------------------------------------------------------------- water ripples

export function createRipples(scene) {
  const geo = new THREE.RingGeometry(0.85, 1, 32);
  geo.rotateX(-Math.PI / 2);
  const pool = [];
  for (let i = 0; i < 14; i++) {
    const r = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ color: '#ffffff', transparent: true, opacity: 0, depthWrite: false }));
    r.visible = false;
    r.userData.t = 1;
    scene.add(r);
    pool.push(r);
  }
  let idx = 0;
  return {
    spawn(x, z, size = 0.4) {
      const r = pool[idx++ % pool.length];
      r.position.set(x, WATER_LEVEL + 0.015, z);
      r.userData = { t: 0, size };
      r.visible = true;
    },
    update(dt) {
      for (const r of pool) {
        if (!r.visible) continue;
        r.userData.t += dt / 1.3;
        const t = r.userData.t;
        if (t >= 1) { r.visible = false; continue; }
        r.scale.setScalar(r.userData.size + t * 1.1);
        r.material.opacity = (1 - t) * 0.55;
      }
    },
  };
}
