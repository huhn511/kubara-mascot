import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { KubaraCharacter } from './KubaraCharacter.js';
import { createWorld, createYuzu, createRipples, terrainHeight, WORLD_RADIUS, WATER_LEVEL } from './world.js';
import { Input } from './input.js';
import { Sfx } from './sfx.js';
import kubaraUrl from '../../dist/kubara.glb?url';
import './style.css';

// ---------------------------------------------------------------- renderer / scene

const app = document.getElementById('app');
const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.NeutralToneMapping;
renderer.toneMappingExposure = 1.0;
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFShadowMap; // soft via shadow.radius
app.appendChild(renderer.domElement);

const scene = new THREE.Scene();
scene.fog = new THREE.Fog('#dff1ea', 22, 70);

const camera = new THREE.PerspectiveCamera(50, window.innerWidth / window.innerHeight, 0.05, 300);
camera.position.set(1.9, 1.55, 3.3);

const hemi = new THREE.HemisphereLight('#e4f6ff', '#8fb27a', 1.5);
scene.add(hemi);
const sun = new THREE.DirectionalLight('#fff3dc', 2.3);
sun.position.set(6, 10, 5);
sun.castShadow = true;
sun.shadow.mapSize.set(2048, 2048);
Object.assign(sun.shadow.camera, { left: -9, right: 9, top: 9, bottom: -9, near: 1, far: 40 });
sun.shadow.bias = -0.0006;
sun.shadow.normalBias = 0.04;
sun.shadow.radius = 1.2; // three's PCF dithers larger radii; keep it crisp-soft
scene.add(sun, sun.target);
const SUN_OFFSET = new THREE.Vector3(6, 10, 5);

const world = createWorld(scene);
const yuzu = createYuzu(scene, 12);
const ripples = createRipples(scene);

// ---------------------------------------------------------------- HUD

const $ = (id) => document.getElementById(id);
const hud = {
  count: $('count'), total: $('total'), toast: $('toast'), help: $('help'),
  loading: $('loading'), bar: $('loading-bar'), touch: $('touch'), mute: $('mute'),
};
hud.total.textContent = yuzu.total;
let toastTimer = 0;
function toast(text, seconds = 2.2) {
  hud.toast.textContent = text;
  hud.toast.classList.add('show');
  toastTimer = seconds;
}

const input = new Input({ joystick: $('stick'), jumpButton: $('btn-jump'), emoteButton: $('btn-wave') });
const sfx = new Sfx();
const coarse = window.matchMedia('(pointer: coarse)').matches || new URLSearchParams(location.search).has('touch');
if (coarse) document.body.classList.add('touch');
window.addEventListener('touchstart', () => document.body.classList.add('touch'), { once: true, passive: true });
hud.mute.addEventListener('click', () => { sfx.toggle(); hud.mute.classList.toggle('off', sfx.muted); });

// ---------------------------------------------------------------- camera controls

const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;
controls.dampingFactor = 0.09;
controls.enablePan = false;
controls.minDistance = 2.2;
controls.maxDistance = 10;
controls.minPolarAngle = 0.25;
controls.maxPolarAngle = 1.48;
controls.rotateSpeed = 0.7;
controls.zoomSpeed = 0.8;
controls.target.set(0, 0.7, 0);
controls.update();

// ---------------------------------------------------------------- player

const player = {
  pos: new THREE.Vector3(0, terrainHeight(0, 0), 0),
  vel: new THREE.Vector3(),
  vy: 0,
  yaw: 0,
  yawVel: 0,
  grounded: true,
  coyote: 0,
  jumpBuffer: 0,
  rippleTimer: 0,
  inWater: false,
};
const WALK = 2.1, RUN = 3.9, GRAVITY = 17, JUMP_V = 5.3;
let kubara = null;
let collected = 0;
let celebrated = false;

const tmpF = new THREE.Vector3(), tmpR = new THREE.Vector3(), desired = new THREE.Vector3();
const camTarget = new THREE.Vector3(0, 0.7, 0), lastTarget = new THREE.Vector3(0, 0.7, 0);
const damp = (a, b, rate, dt) => a + (b - a) * (1 - Math.exp(-rate * dt));
const wrapAngle = (a) => Math.atan2(Math.sin(a), Math.cos(a));

function resetPlayer() {
  player.pos.set(0, terrainHeight(0, 0), 0);
  player.vel.set(0, 0, 0);
  player.vy = 0;
}

function updatePlayer(dt) {
  const mv = input.move();
  const hasInput = Math.hypot(mv.x, mv.y) > 0.01;

  // camera-relative move direction on the ground plane
  camera.getWorldDirection(tmpF);
  tmpF.y = 0;
  if (tmpF.lengthSq() < 1e-6) tmpF.set(0, 0, -1);
  tmpF.normalize();
  tmpR.set(-tmpF.z, 0, tmpF.x);
  desired.copy(tmpR).multiplyScalar(mv.x).addScaledVector(tmpF, mv.y);
  const mag = Math.min(1, desired.length());
  if (mag > 0) desired.normalize();

  const waterDepth = WATER_LEVEL - terrainHeight(player.pos.x, player.pos.z);
  player.inWater = waterDepth > 0.08;
  const emoting = kubara.state === 'emote';
  let maxSpeed = (mv.run ? RUN : WALK) * mag * (player.inWater ? 0.55 : 1);
  if (emoting && !hasInput) maxSpeed = 0;
  desired.multiplyScalar(maxSpeed);

  const accel = player.grounded ? 12 : 4;
  player.vel.x = damp(player.vel.x, desired.x, accel, dt);
  player.vel.z = damp(player.vel.z, desired.z, accel, dt);

  // integrate + collide with trees/rocks and the world edge
  player.pos.x += player.vel.x * dt;
  player.pos.z += player.vel.z * dt;
  const bodyR = 0.32;
  for (const c of world.colliders) {
    const dx = player.pos.x - c.x, dz = player.pos.z - c.z;
    const d = Math.hypot(dx, dz), min = c.r + bodyR;
    if (d < min && d > 1e-5) {
      player.pos.x = c.x + (dx / d) * min;
      player.pos.z = c.z + (dz / d) * min;
    }
  }
  const r = Math.hypot(player.pos.x, player.pos.z);
  if (r > WORLD_RADIUS) player.pos.multiplyScalar(WORLD_RADIUS / r).setY(player.pos.y);

  // facing: turn toward travel direction, lean into turns
  const planar = Math.hypot(player.vel.x, player.vel.z);
  if (planar > 0.15) {
    const targetYaw = Math.atan2(player.vel.x, player.vel.z);
    const diff = wrapAngle(targetYaw - player.yaw);
    const step = diff * (1 - Math.exp(-12 * dt));
    player.yaw = wrapAngle(player.yaw + step);
    player.yawVel = damp(player.yawVel, step / Math.max(dt, 1e-4), 10, dt);
  } else {
    player.yawVel = damp(player.yawVel, 0, 10, dt);
  }

  // vertical: jump buffer + coyote time
  const groundY = terrainHeight(player.pos.x, player.pos.z);
  if (input.consume('jump')) player.jumpBuffer = 0.14;
  player.jumpBuffer = Math.max(0, player.jumpBuffer - dt);
  player.coyote = player.grounded ? 0.1 : Math.max(0, player.coyote - dt);

  if (player.jumpBuffer > 0 && player.coyote > 0) {
    player.vy = JUMP_V * (player.inWater ? 0.85 : 1);
    player.grounded = false;
    player.coyote = 0;
    player.jumpBuffer = 0;
    kubara.setState('jump');
    sfx.jump();
    if (player.inWater) splash(1.0);
  }

  if (!player.grounded) {
    player.vy -= GRAVITY * dt;
    player.pos.y += player.vy * dt;
    if (player.pos.y <= groundY && player.vy <= 0) {
      player.pos.y = groundY;
      player.grounded = true;
      const impact = Math.min(1.3, -player.vy / JUMP_V);
      player.vy = 0;
      kubara.setState(planar > 0.3 ? 'walk' : 'idle');
      kubara.land(impact);
      sfx.land();
      if (player.inWater) splash(1.2);
    }
  } else {
    // stick to the ground on slopes, but walk off steep drops as a fall
    if (player.pos.y - groundY > 0.25) {
      player.grounded = false;
      player.vy = 0;
    } else {
      player.pos.y = damp(player.pos.y, groundY, 30, dt);
    }
  }

  // emote
  if (input.consume('emote') && player.grounded && kubara.state !== 'emote') {
    kubara.setState('emote');
    sfx.wave();
  }

  // animation state
  if (player.grounded) {
    if (kubara.state === 'emote') {
      if (hasInput) kubara.setState('walk');
    } else if (kubara.state !== 'jump') {
      kubara.setState(planar > 0.3 ? 'walk' : 'idle');
    }
  }
  kubara.setSpeed(Math.max(0, (planar - 0.8) / (RUN - 0.8)));
  kubara.setLean(-player.yawVel * 0.12 * Math.min(1, planar / WALK));

  kubara.object.position.copy(player.pos);
  kubara.object.rotation.y = player.yaw;

  // water ripples while wading
  if (player.inWater && player.grounded) {
    player.rippleTimer -= dt * (planar > 0.3 ? 2.2 : 0.6);
    if (player.rippleTimer <= 0) {
      ripples.spawn(player.pos.x, player.pos.z, 0.35);
      player.rippleTimer = 0.45;
    }
  }

  // collect yuzu
  const got = yuzu.collect(player.pos);
  if (got) {
    collected += got;
    hud.count.textContent = collected;
    hud.count.parentElement.classList.remove('bump');
    void hud.count.parentElement.offsetWidth;
    hud.count.parentElement.classList.add('bump');
    sfx.pickup(collected);
    if (collected >= yuzu.total && !celebrated) {
      celebrated = true;
      toast('All yuzu found! Time for a bath.', 4);
      setTimeout(() => { if (player.grounded) kubara.setState('emote', { force: true }); sfx.fanfare(); }, 350);
    } else {
      toast(`+1 yuzu  (${collected}/${yuzu.total})`, 1.3);
    }
  }
}

function splash(size) {
  for (let i = 0; i < 3; i++) setTimeout(() => ripples.spawn(player.pos.x, player.pos.z, 0.3 + i * 0.25 * size), i * 110);
  sfx.splash();
}

function updateCamera(dt) {
  // follow the player: shift camera and target by the same delta so the user's orbit is kept
  const followY = player.pos.y + (player.grounded ? 0.7 : 0.7 - Math.max(0, player.pos.y - terrainHeight(player.pos.x, player.pos.z)) * 0.5);
  camTarget.x = damp(camTarget.x, player.pos.x, 10, dt);
  camTarget.z = damp(camTarget.z, player.pos.z, 10, dt);
  camTarget.y = damp(camTarget.y, followY, 6, dt);
  const delta = camTarget.clone().sub(lastTarget);
  camera.position.add(delta);
  controls.target.copy(camTarget);
  lastTarget.copy(camTarget);
  controls.update(dt);
  // keep the camera above the terrain
  const gy = terrainHeight(camera.position.x, camera.position.z) + 0.35;
  if (camera.position.y < gy) camera.position.y = gy;

  sun.position.copy(player.pos).add(SUN_OFFSET);
  sun.target.position.copy(player.pos);
}

// ---------------------------------------------------------------- loop

const timer = new THREE.Timer();
timer.connect(document); // pauses cleanly while the tab is hidden
let elapsed = 0;
function frame(timestamp) {
  timer.update(timestamp);
  const dt = Math.min(timer.getDelta(), 1 / 20);
  elapsed += dt;
  if (kubara) {
    if (input.consume('help')) hud.help.classList.toggle('hidden');
    if (input.consume('mute')) { sfx.toggle(); hud.mute.classList.toggle('off', sfx.muted); }
    if (input.consume('reset')) resetPlayer();
    updatePlayer(dt);
    kubara.update(dt);
    updateCamera(dt);
  }
  for (const u of world.updaters) u(dt, elapsed, camera);
  yuzu.update(dt, elapsed);
  ripples.update(dt);
  if (toastTimer > 0) {
    toastTimer -= dt;
    if (toastTimer <= 0) hud.toast.classList.remove('show');
  }
  renderer.render(scene, camera);
}

window.addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
});

// ---------------------------------------------------------------- boot

KubaraCharacter.load(kubaraUrl, {
  selfJump: false,
  onProgress: (e) => { if (e.total) hud.bar.style.width = `${(100 * e.loaded) / e.total}%`; },
}).then((character) => {
  kubara = character;
  scene.add(kubara.object);
  kubara.object.position.copy(player.pos);
  hud.loading.classList.add('done');
  setTimeout(() => hud.loading.remove(), 600);
  toast('Find all the yuzu!', 2.6);
  window.__kubara = { ready: true, character: kubara, player, camera, controls, setView };
}).catch((err) => {
  console.error(err);
  hud.loading.querySelector('p').textContent = `Could not load kubara.glb: ${err.message}`;
});

/** debug/screenshot helper: orbit the camera to yaw/pitch (degrees) around the player */
function setView(yawDeg, pitchDeg, dist) {
  const yaw = THREE.MathUtils.degToRad(yawDeg), pitch = THREE.MathUtils.degToRad(pitchDeg);
  camera.position.set(
    controls.target.x + Math.sin(yaw) * Math.cos(pitch) * dist,
    controls.target.y + Math.sin(pitch) * dist,
    controls.target.z + Math.cos(yaw) * Math.cos(pitch) * dist,
  );
  controls.update();
}

renderer.setAnimationLoop(frame);
