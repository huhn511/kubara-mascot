// KubaraCharacter: drop-in three.js controller for the kubara mascot (dist/kubara.glb).
//
// The GLB has no skin and no clips; every body part is its own node with its pivot at the
// natural joint (head at the neck, arms at the shoulders, legs at the hips, ...). This class
// animates those pivots procedurally, so no animation data is needed:
//
//   import { KubaraCharacter } from './KubaraCharacter.js';
//   const kubara = await KubaraCharacter.load('/kubara.glb');
//   scene.add(kubara.object);            // move / rotate kubara.object in your game
//   kubara.setState('walk');             // 'idle' | 'walk' | 'jump' | 'emote'
//   kubara.setSpeed(0.5);                // 0 = stroll ... 1 = run (walk cadence + amplitude)
//   renderer.setAnimationLoop(() => kubara.update(clock.getDelta()));
//
// Jumping has two modes:
//   selfJump: true  (default) 'jump' plays a complete hop on its own (the model leaves the
//                    ground inside kubara.object) and then returns to the previous state.
//   selfJump: false  your game moves kubara.object up and down (physics). Call
//                    setState('jump') on take-off and setState('idle'|'walk') on landing;
//                    the landing squash plays automatically.
//
// Events (THREE.EventDispatcher): 'statechange' {from, to}, 'emoteend', 'land'.
//
// Conventions of the asset: Y-up, metres, ~1.0 m tall, origin between the feet, faces +Z.
// _l parts are the character's left (+X).

import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';

export const KUBARA_STATES = ['idle', 'walk', 'jump', 'emote'];

const JOINTS = [
  'body', 'head', 'glasses',
  'arm_l', 'arm_r', 'hand_l', 'hand_r',
  'leg_l', 'leg_r', 'foot_l', 'foot_r',
  'ear_l', 'ear_r',
];

// meshes that are already ink-coloured or tiny decals get no outline shell
const NO_OUTLINE = /^(nostril|mouth|jaw_line|glint|ear_inner|glasses|lens)/;

const DEFAULTS = {
  toon: true,            // MeshToonMaterial with a 3-step ramp (false = keep the GLB's PBR materials)
  outline: true,         // inverted-hull ink outline
  outlineWidth: 0.009,   // in model units (metres at scale 1)
  outlineColor: 0x0a0f0f,
  castShadow: true,
  receiveShadow: true,
  selfJump: true,
  jumpHeight: 0.55,      // selfJump only
  jumpDuration: 0.62,    // selfJump only, seconds in the air
  emoteDuration: 2.4,    // seconds of waving before returning to the previous state
  scale: 1,
};

const damp = (a, b, rate, dt) => a + (b - a) * (1 - Math.exp(-rate * dt));
const smooth = (e0, e1, x) => {
  const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0)));
  return t * t * (3 - 2 * t);
};

let sharedGradient = null;
function toonGradient() {
  if (sharedGradient) return sharedGradient;
  // 3 tones: core shadow, mid, lit. Kept bright so the mint fur stays mint.
  const data = new Uint8Array([150, 150, 150, 255, 215, 215, 215, 255, 255, 255, 255, 255]);
  sharedGradient = new THREE.DataTexture(data, 3, 1, THREE.RGBAFormat);
  sharedGradient.minFilter = THREE.NearestFilter;
  sharedGradient.magFilter = THREE.NearestFilter;
  sharedGradient.generateMipmaps = false;
  sharedGradient.needsUpdate = true;
  return sharedGradient;
}

function makeOutlineMaterial(color, width) {
  const mat = new THREE.MeshBasicMaterial({ color, side: THREE.BackSide });
  mat.name = 'kubara_outline';
  mat.userData.width = { value: width };
  mat.onBeforeCompile = (shader) => {
    shader.uniforms.outlineWidth = mat.userData.width;
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nuniform float outlineWidth;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\ntransformed += normalize(normal) * outlineWidth;');
  };
  mat.customProgramCacheKey = () => 'kubara_outline';
  return mat;
}

export class KubaraCharacter extends THREE.EventDispatcher {
  /** Load the GLB and build a character. `options.loader` may be a preconfigured GLTFLoader. */
  static async load(url, options = {}) {
    const loader = options.loader ?? new GLTFLoader();
    const gltf = await loader.loadAsync(url, options.onProgress);
    return new KubaraCharacter(gltf.scene, options);
  }

  /** @param {THREE.Object3D} model the loaded gltf.scene (or a clone of it) */
  constructor(model, options = {}) {
    super();
    this.options = { ...DEFAULTS, ...options };
    const o = this.options;

    this.object = new THREE.Group();          // move / rotate this one
    this.object.name = 'KubaraCharacter';
    this.rig = new THREE.Group();             // hop + squash & stretch (scales about the feet)
    this.rig.name = 'kubara_rig';
    this.object.add(this.rig);
    this.model = model;
    this.model.scale.setScalar(o.scale);
    this.rig.add(model);

    this.parts = {};
    this.rest = {};
    for (const name of JOINTS) {
      const node = model.getObjectByName(name);
      if (!node) continue;
      this.parts[name] = node;
      this.rest[name] = { p: node.position.clone(), q: node.quaternion.clone(), s: node.scale.clone() };
    }
    if (!this.parts.body) throw new Error('KubaraCharacter: GLB has no "body" node');

    this._setupMaterials();

    // state machine
    this.state = 'idle';
    this.prevState = 'idle';
    this.time = 0;
    this.stateTime = 0;
    this.speed = 0.4;
    this.lean = 0;
    this.weights = { idle: 1, walk: 0, air: 0, emote: 0 };
    this.walkPhase = 0;
    this.squash = 0;
    this.squashVel = 0;
    this.hop = 0;
    this._returnState = 'idle';
    this._earTwitch = { l: 0, r: 0, next: 1.5 };
    this._nudge = { t: 0, next: 3.5 };

    this._acc = {};
    for (const name of Object.keys(this.parts)) this._acc[name] = new Float32Array(9);
    this._euler = new THREE.Euler();
    this._quat = new THREE.Quaternion();

    this.update(0);
  }

  // ---------------------------------------------------------------- public API

  /** 'idle' | 'walk' | 'jump' | 'emote'. Re-setting the current state is a no-op. */
  setState(next, { force = false } = {}) {
    if (!KUBARA_STATES.includes(next)) throw new Error(`KubaraCharacter: unknown state "${next}"`);
    if (next === this.state && !force) return this;
    const from = this.state;
    if (from === 'jump' && next !== 'jump') this.land();
    if (next === 'jump') {
      this.squashVel += 5.5; // stretch on take-off
      if (from !== 'jump') this._returnState = from === 'emote' ? 'idle' : from;
    }
    if (next === 'emote') this._returnState = from === 'jump' || from === 'emote' ? 'idle' : from;
    this.prevState = from;
    this.state = next;
    this.stateTime = 0;
    this.dispatchEvent({ type: 'statechange', from, to: next });
    return this;
  }

  /** 0..1, scales walk cadence and stride (0 = stroll, 1 = run). */
  setSpeed(v) { this.speed = Math.min(1, Math.max(0, v)); return this; }

  /** Turning lean, roughly -1..1 (positive = turning left). */
  setLean(v) { this.lean = Math.min(1, Math.max(-1, v)); return this; }

  /** Trigger the landing squash (called automatically when leaving 'jump'). */
  land(intensity = 1) {
    this.squashVel -= 7 * intensity;
    this.dispatchEvent({ type: 'land' });
    return this;
  }

  /** Advance the procedural animation by dt seconds. */
  update(dt) {
    dt = Math.min(dt, 0.1);
    this.time += dt;
    this.stateTime += dt;
    const o = this.options;

    // self-contained hop
    if (this.state === 'jump' && o.selfJump) {
      const x = this.stateTime / o.jumpDuration;
      if (x >= 1) {
        this.hop = 0;
        this.setState(this._returnState);
      } else {
        this.hop = 4 * o.jumpHeight * x * (1 - x);
      }
    } else {
      this.hop = 0;
    }

    if (this.state === 'emote' && this.stateTime >= o.emoteDuration) {
      this.setState(this._returnState === 'emote' ? 'idle' : this._returnState);
      this.dispatchEvent({ type: 'emoteend' });
    }

    // layer weights
    const w = this.weights;
    const tgt = {
      idle: { idle: 1, walk: 0, air: 0, emote: 0 },
      walk: { idle: 0.35, walk: 1, air: 0, emote: 0 },
      jump: { idle: 0.2, walk: 0, air: 1, emote: 0 },
      emote: { idle: 0.5, walk: 0, air: 0, emote: 1 },
    }[this.state];
    for (const k in w) w[k] = damp(w[k], tgt[k], k === 'air' ? 14 : 9, dt);

    // walk phase: cadence in steps/s grows with speed
    const cadence = 1.55 + 1.25 * this.speed; // full cycles per second
    if (w.walk < 0.02 && this.state !== 'walk') this.walkPhase = 0; // start every walk on a fresh stride
    else this.walkPhase += dt * cadence * Math.PI * 2;

    // squash & stretch spring
    const k = 220, c = 13;
    this.squashVel += (-k * this.squash - c * this.squashVel) * dt;
    this.squash += this.squashVel * dt;
    const s = Math.max(-0.32, Math.min(0.32, this.squash));
    const sy = 1 + s, sxz = 1 / Math.sqrt(sy);
    this.rig.scale.set(sxz, sy, sxz);
    this.rig.position.y = this.hop;

    // accumulate the pose
    for (const a of Object.values(this._acc)) a.fill(0);
    this._idle(w.idle, dt);
    if (w.walk > 0.001) this._walk(w.walk);
    if (w.air > 0.001) this._air(w.air);
    if (w.emote > 0.001) this._emote(w.emote);
    this._add('body', 0, 0, this.lean * 0.12);
    this._apply();
    return this;
  }

  /** Cleans up GPU resources created by this class (outline/toon materials). */
  dispose() {
    for (const m of this._ownedMaterials) m.dispose();
    this.object.removeFromParent();
  }

  // ---------------------------------------------------------------- layers
  // _add(joint, rx, ry, rz, px, py, pz, scaleY): additive offsets on top of the rest pose

  _add(name, rx = 0, ry = 0, rz = 0, px = 0, py = 0, pz = 0, sy = 0) {
    const a = this._acc[name];
    if (!a) return;
    a[0] += rx; a[1] += ry; a[2] += rz; a[3] += px; a[4] += py; a[5] += pz; a[6] += sy;
  }

  _idle(w, dt) {
    const t = this.time;
    const breath = Math.sin(t * 2.1);
    // breathing: chest scale + head rides along, arms drift out a touch
    this._add('body', 0, 0, Math.sin(t * 0.85) * 0.022 * w, 0, 0, 0, breath * 0.014 * w);
    this._add('head', Math.sin(t * 2.1 + 0.7) * 0.03 * w, Math.sin(t * 0.33) * Math.sin(t * 0.21) * 0.22 * w, Math.sin(t * 0.6) * 0.025 * w);
    this._add('arm_l', 0, 0, (0.03 + breath * 0.03) * w);
    this._add('arm_r', 0, 0, -(0.03 + breath * 0.03) * w);
    this._add('hand_l', Math.sin(t * 1.3) * 0.05 * w, 0, 0);
    this._add('hand_r', Math.sin(t * 1.3 + 1) * 0.05 * w, 0, 0);

    // ear twitches at random intervals (the "blink" of a creature whose eyes hide behind shades)
    const e = this._earTwitch;
    e.next -= dt;
    if (e.next <= 0) {
      const which = Math.random();
      if (which < 0.45) e.l = 1; else if (which < 0.9) e.r = 1; else { e.l = 1; e.r = 1; }
      e.next = 1.8 + Math.random() * 3.5;
    }
    e.l = Math.max(0, e.l - dt * 3.2);
    e.r = Math.max(0, e.r - dt * 3.2);
    const tw = (v) => Math.sin(v * Math.PI * 4) * v * 0.45;
    this._add('ear_l', tw(e.l) * 0.6, 0, -tw(e.l));
    this._add('ear_r', tw(e.r) * 0.6, 0, tw(e.r));

    // every few seconds kubara nudges the shades back up the snout
    const n = this._nudge;
    n.next -= dt;
    if (n.next <= 0) { n.t = 1; n.next = 4 + Math.random() * 5; }
    n.t = Math.max(0, n.t - dt * 2.5);
    const nudge = Math.sin(n.t * Math.PI) * w;
    this._add('glasses', 0, 0, 0, 0, -0.006 * nudge, 0);
    this._add('head', -0.06 * nudge, 0, 0);
  }

  _walk(w) {
    const p = this.walkPhase;
    const sp = this.speed;
    const sn = Math.sin(p), cs = Math.cos(p);
    const legAmp = (0.38 + 0.22 * sp) * w;
    const armAmp = (0.42 + 0.35 * sp) * w;

    // legs swing about the hips; the foot counter-rotates to stay flatter, swing leg lifts
    this._add('leg_l', -legAmp * sn, 0, 0, 0, 0.035 * Math.max(0, cs) * w, 0);
    this._add('leg_r', legAmp * sn, 0, 0, 0, 0.035 * Math.max(0, -cs) * w, 0);
    this._add('foot_l', legAmp * sn * 0.55 - 0.25 * Math.max(0, cs) * w, 0, 0);
    this._add('foot_r', -legAmp * sn * 0.55 - 0.25 * Math.max(0, -cs) * w, 0, 0);

    // arms opposite to legs, a little outward so the paws clear the belly
    this._add('arm_l', armAmp * sn, 0, (0.14 + 0.1 * sp) * w);
    this._add('arm_r', -armAmp * sn, 0, -(0.14 + 0.1 * sp) * w);
    this._add('hand_l', -0.25 * armAmp * sn, 0, 0);
    this._add('hand_r', 0.25 * armAmp * sn, 0, 0);

    // body: bounce twice per cycle, waddle roll, hip twist, lean into the run
    const bob = sn * sn;
    this._add('body', (0.05 + 0.12 * sp) * w, 0.07 * sn * w, 0.065 * sn * w, 0, (0.022 + 0.03 * sp) * bob * w, 0, -0.02 * Math.cos(2 * p) * w);
    this._add('head', (-0.04 - 0.08 * sp) * w + 0.035 * Math.cos(2 * p) * w, -0.06 * sn * w, -0.04 * sn * w);
    this._add('ear_l', 0.18 * Math.cos(2 * p) * w, 0, -0.08 * sn * w);
    this._add('ear_r', 0.18 * Math.cos(2 * p) * w, 0, -0.08 * sn * w);
  }

  _air(w) {
    const t = this.stateTime;
    const flap = Math.sin(t * 18) * 0.12 * Math.exp(-t * 3);
    this._add('arm_l', -0.35 * w, 0, (1.0 + flap) * w);
    this._add('arm_r', -0.35 * w, 0, -(1.0 + flap) * w);
    this._add('hand_l', 0, 0, 0.3 * w);
    this._add('hand_r', 0, 0, -0.3 * w);
    this._add('leg_l', -0.45 * w, 0, 0.06 * w);
    this._add('leg_r', 0.3 * w, 0, -0.06 * w);
    this._add('foot_l', 0.2 * w, 0, 0);
    this._add('foot_r', 0.35 * w, 0, 0);
    this._add('head', -0.12 * w, 0, 0);
    this._add('ear_l', 0.45 * w, 0, -0.15 * w);
    this._add('ear_r', 0.45 * w, 0, 0.15 * w);
    this._add('body', -0.06 * w, 0, 0);
  }

  _emote(w) {
    const t = this.stateTime;
    const dur = this.options.emoteDuration;
    const raise = smooth(0, 0.35, t) * (1 - smooth(dur - 0.45, dur, t)) * w;
    const wave = Math.sin(t * 13);
    // right paw way up, waving; left paw on the hip; happy bounce and head tilt
    this._add('arm_r', -0.12 * raise, 0.1 * raise, (-2.6 + 0.3 * wave) * raise);
    this._add('hand_r', 0, 0, 0.4 * Math.sin(t * 13 - 0.7) * raise);
    this._add('arm_l', 0.15 * raise, 0, 0.32 * raise);
    this._add('hand_l', 0, 0, -0.35 * raise);
    const bounce = Math.abs(Math.sin(t * 6.5));
    this._add('body', 0, -0.12 * raise, -0.05 * raise, 0, 0.02 * bounce * raise, 0, -0.015 * bounce * raise);
    this._add('head', -0.1 * raise, 0.1 * raise, -0.12 * raise + 0.04 * Math.sin(t * 6.5) * raise);
    this._add('ear_l', 0.2 * Math.sin(t * 16) * raise, 0, -0.15 * raise);
    this._add('ear_r', 0.2 * Math.sin(t * 16 + 1) * raise, 0, 0.15 * raise);
  }

  _apply() {
    for (const [name, node] of Object.entries(this.parts)) {
      const a = this._acc[name];
      const r = this.rest[name];
      this._euler.set(a[0], a[1], a[2], 'XYZ');
      node.quaternion.copy(r.q).multiply(this._quat.setFromEuler(this._euler));
      node.position.set(r.p.x + a[3], r.p.y + a[4], r.p.z + a[5]);
      const sy = 1 + a[6];
      const sxz = 1 - a[6] * 0.5;
      node.scale.set(r.s.x * sxz, r.s.y * sy, r.s.z * sxz);
    }
  }

  // ---------------------------------------------------------------- materials

  _setupMaterials() {
    const o = this.options;
    this._ownedMaterials = [];
    const toonCache = new Map();
    const outlineMat = o.outline ? makeOutlineMaterial(o.outlineColor, o.outlineWidth * o.scale) : null;
    if (outlineMat) this._ownedMaterials.push(outlineMat);
    this.outlineMaterial = outlineMat;

    const meshes = [];
    this.model.traverse((n) => { if (n.isMesh) meshes.push(n); });
    for (const mesh of meshes) {
      mesh.castShadow = o.castShadow;
      mesh.receiveShadow = o.receiveShadow;
      if (o.toon) {
        const src = mesh.material;
        let mat = toonCache.get(src);
        if (!mat) {
          mat = new THREE.MeshToonMaterial({ color: src.color.clone(), gradientMap: toonGradient() });
          mat.name = src.name;
          if (src.name === 'glint') mat.emissive = new THREE.Color(0x444444);
          toonCache.set(src, mat);
          this._ownedMaterials.push(mat);
        }
        mesh.material = mat;
      }
      if (outlineMat && !NO_OUTLINE.test(mesh.name)) {
        const hull = new THREE.Mesh(mesh.geometry, outlineMat);
        hull.name = `${mesh.name}_outline`;
        hull.castShadow = false;
        hull.receiveShadow = false;
        hull.raycast = () => {};
        mesh.add(hull);
      }
    }
  }
}

export default KubaraCharacter;
