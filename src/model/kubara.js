// kubara mascot: parametric SDF model.
// Single source of truth for the game GLB and the print files.
//
// Frame: Y-up, metres, total height ~1.0 (ground -> ear tips), origin on the
// ground between the feet, character faces +Z. `_l` = character's left = +X.
// SDF convention: negative inside (see sdf.js).
//
// Two consumers:
//  * PRINT uses `F` (everything smooth-min blended into one organic solid, with
//    finger/toe/jaw grooves) plus the colour volumes inkPrint / glintAll / muzzle / ear inner.
//  * GAME uses `nodes`: every animatable part is its OWN closed primitive SDF
//    (not a partition of the blended solid). Joints are ball joints: the parent
//    carries a sphere centred on the child's pivot and the child carries a slightly
//    smaller sphere at the same place, so any rotation keeps the joint closed.
//
// Tweak the PARAMS block below; everything else is derived from it.

import {
  DEG, clamp, smin, smax, sdEllipsoid, sdEllipse2, sdRoundBox, sdCapsule, sdPolyline,
  v3, makeFrame, yawPitchFrame, raySurface, roundRect, sdSegment2, catmullRom, gradient,
} from './sdf.js';
import { buildLensMeshes } from './lensMesh.js';

// ============================================================== PALETTE
export const PALETTE = {
  fur: '#9BE0DF',
  fur_shade: '#21B3B4',
  ink: '#0A0F0F',
  glint: '#FCFDFD',
  mouth_inside: '#3A1414',
  tongue: '#F07073',
  brand_teal: '#0ABEBE',
};

// ============================================================== PARAMETERS
export const PARAMS = {
  // ---- body (pear / barrel) -------------------------------------------
  belly: { c: [0, 0.32, 0.015], r: [0.275, 0.235, 0.255] },
  chest: { c: [0, 0.47, -0.01], r: [0.23, 0.17, 0.22] },
  rump: { c: [0, 0.18, -0.04], r: [0.22, 0.10, 0.215] },
  nape: { c: [0, 0.585, -0.075], r: [0.225, 0.13, 0.17] }, // back of the neck: meets the head's occiput so the back is one straight line
  bodyBlend: 0.08,

  // ---- head ------------------------------------------------------------
  cranium: { c: [0, 0.772, -0.03], r: [0.23, 0.158, 0.19] },
  occiput: { c: [0, 0.665, -0.07], r: [0.226, 0.13, 0.18] }, // lower back of the skull, flows down into the nape (no neck)
  snout: { c: [0, 0.74, 0.17], half: [0.138, 0.128, 0.16], round: 0.105, pitch: 0 }, // blunt rounded box: 'D' profile
  snoutBulge: { c: [0, 0.735, 0.28], r: [0.12, 0.11, 0.075], k: 0.04 }, // domes the snout front forward (no flat 'screen')
  headBlend: 0.09, // cranium <-> snout (no waist behind the muzzle)
  neckBlend: 0.05, // head <-> body (print solid)

  // ---- joints (game ball joints; pivots are the part pivots) ------------
  joints: {
    neckPivot: [0, 0.60, -0.03], neckR: 0.14, neckBlend: 0.06,
    // the body also blends toward a slightly shrunken STATIC copy of the head's occiput, so the back of
    // the neck is one smooth surface in the rest pose (no head-on-a-pedestal crease) and stays closed when the head moves
    occiputShrink: 0.0025, occiputBlend: 0.07,
    occiputTrimY: 0.66, occiputTrimZ: -0.05, occiputCapR: [0.27, 0.235, 0.235], // ~concentric with the head's back about the neck pivot
    shoulderBlend: 0.035, hipBlend: 0.05,
    // game shading: vertex normals near a joint seam come from the smooth-min of both parts (continuous shading)
    normalBlend: { neck: 0.06, shoulder: 0.04, hip: 0.05, wrist: 0.03, ankle: 0.03, ear: 0.02 },
    inset: 0.004, // child ball is this much smaller than the parent's socket ball
  },

  // ---- muzzle (fur_shade): oval cap = fur inside this ellipsoid, above yMin
  muzzle: { c: [0, 0.74, 0.345], r: [0.21, 0.15, 0.155], yMin: 0.55 },

  // ---- ears ------------------------------------------------------------
  ear: {
    c: [0.15, 0.895, -0.12], r: [0.056, 0.062, 0.038], yaw: 30, blend: 0.045,
    innerR: 0.03, innerInset: 0.006, innerLift: 0.006,
  },

  // ---- arms / paws -----------------------------------------------------
  arm: { shoulder: [0.215, 0.52, 0.01], wrist: [0.245, 0.37, 0.17], r0: 0.056, r1: 0.046, blend: 0.018 },
  // paw rests on the front-side of the belly; yaw = direction the back of the paw faces (deg from +Z toward +X)
  hand: { c: [0.215, 0.335, 0.215], r: [0.056, 0.056, 0.05], blend: 0.03, yaw: 45, grooves: [-0.022, 0, 0.022] },

  // ---- legs / feet -----------------------------------------------------
  leg: { hip: [0.14, 0.15, 0], ankle: [0.15, 0.06, 0.02], r: 0.08, blend: 0.05 },
  foot: { c: [0.15, 0.04, 0.05], r: [0.08, 0.05, 0.115], splay: 5, blend: 0.035, grooves: [-0.028, 0, 0.028] },

  // grooves (fingers / toes): round profile; halfWidth 0.0075 = 1.2 mm wide at 80 mm
  groove: { depth: 0.006, halfWidth: 0.009, blend: 0.005 },

  // ---- face details (ink) ---------------------------------------------
  // tilt > 0: outer ends higher ("\ /" commas right under the top edge of the snout front)
  nostril: { x: 0.05, y: 0.80, len: 0.012, r: 0.009, tilt: 15, inset: 0.0045 },
  mouth: {
    r: 0.007, proud: -0.004,
    // (x, y) points on the muzzle, projected along +Z. Right half is mirrored.
    philtrum: [[0, 0.742], [0, 0.713]],
    smile: [[0, 0.713], [0.011, 0.703], [0.024, 0.700], [0.036, 0.703], [0.045, 0.711]],
  },
  // chin crease: follows the head/body seam under the snout, one continuous U.
  // game: flush ink line; print: V-groove in the fur (no raised ink, no undercut)
  jaw: {
    enabled: true, zMin: 0.0, zMax: 0.22, yMax: 0.70, axisZ: -0.03, thetaMax: 76,
    r: 0.0075, inset: -0.003, // game: ink tube along the crease, mostly sunk (reads like the mouth line)
    grooveHalfWidth: 0.009, grooveDepth: 0.007, // print: round groove 1.45 mm wide, 0.58 mm deep (no undercut, no relief)
  },

  // ---- sunglasses (ink) -------------------------------------------------
  glasses: {
    lensAnchor: [0.15, 0.855, 0.15], lensYaw: 30,
    lensHalfW: 0.12, lensTop: 0.055, lensBottom: -0.068, lensCorner: 0.016, lensRound: 0.008,
    lensProud: 0.02, lensBend: 2.4, lensEmbed: 0.012, lensThick: 0.06, lensBevelGame: 0.005,
    glintHalfW: 0.014, glintOffset: 0.02, glintDepth: 0.008, glintInset: 0.005,
    axisZ: -0.03, // vertical axis of the head used for angular placement
    bridgeY: 0.895, bridgeR: 0.0145, frameProud: 0.009, frameProudBack: 0.006,
    strapYTemple: 0.865, strapYBack: 0.80, strapHalfH: 0.015, strapEmbed: 0.012, strapRound: 0.005,
    tail: { from: [-136, 0.0], to: [-150, -0.042], halfW: 0.011, proud: 0.007 }, // y values are offsets from the strap centre
  },

  // ---- print -----------------------------------------------------------
  print: {
    heightMM: 80, // figure height (ground -> ear tips); base adds its thickness below
    furEdge: 0.0035, // level-set edge length (units) for the fur shell
    detailEdge: 0.0025, // for ink / glint / shade detail volumes
    furSmoothPasses: 2, // Taubin passes on the fur shell before the colour-part booleans
    furSimplifyTol: 0.0003, // ~0.024 mm at 80 mm: far below layer height
    detailSimplifyTol: 0.00004, // ~0.003 mm, applied to colour volumes AND their grown twins (well below partGap)
    partGap: 0.000125, // ~0.01 mm clearance between colour parts (no coincident faces)
    minShellMM3: 0.05, // shells smaller than this are dropped from print meshes
    pawGusset: { from: [0.207, 0.305, 0.205], to: [0.17, 0.235, 0.16], r: 0.03, blend: 0.025 },
    lensChamfer: true,
    lensDraft: 0.8, // print lens walls: outline inset per unit depth behind the face (0.8 ~ 39 deg) // 45 deg fillet under the lens bottom edge (no overhang lip)
    base: { enabled: true, circumradius: 0.33, thickness: 0.035, corner: 0.04, overlap: 0.003, color: 'ink' },
  },

  // ---- game ------------------------------------------------------------
  game: {
    edge: 0.0065,
    detailEdge: 0.0025,
    pawEdge: 0.003,
    creaseDeg: 60,
    normalizeHeight: true, // GLB is uniformly scaled so ground -> ear tips is exactly 1.0 m
    budgets: {
      body: 6000, head: 5600, muzzle: 1000, ear_l: 650, ear_r: 650, ear_inner_l: 200, ear_inner_r: 200,
      glasses: 2900, lens_l: 1400, lens_r: 1400, glint_l: 250, glint_r: 250,
      nostril_l: 220, nostril_r: 220, mouth: 450, jaw_line: 300,
      arm_l: 800, arm_r: 800, hand_l: 1300, hand_r: 1300,
      leg_l: 700, leg_r: 700, foot_l: 1100, foot_r: 1100,
    },
  },
};

// ============================================================== MODEL
export function createModel(P = PARAMS) {
  const sides = [1, -1]; // +1 = _l (+X), -1 = _r (-X)
  const mx = (p, s) => [p[0] * s, p[1], p[2]];

  // ---- primitive frames
  const snoutF = yawPitchFrame(P.snout.c, 0, P.snout.pitch);
  const earF = sides.map((s) => yawPitchFrame(mx(P.ear.c, s), s * P.ear.yaw, 0));
  const footF = sides.map((s) => yawPitchFrame(mx(P.foot.c, s), s * P.foot.splay, 0));
  const handC = sides.map((s) => mx(P.hand.c, s));
  const sh = sides.map((s) => mx(P.arm.shoulder, s));
  const wr = sides.map((s) => mx(P.arm.wrist, s));
  const hip = sides.map((s) => mx(P.leg.hip, s));
  const ank = sides.map((s) => mx(P.leg.ankle, s));
  const L = new Float64Array(3);
  const J = P.joints;
  const NP = J.neckPivot;

  const { belly, chest, rump, nape, cranium, occiput, snout, ear, arm, hand, leg, foot } = P;
  const sphere = (x, y, z, c, r) => Math.hypot(x - c[0], y - c[1], z - c[2]) - r;

  // ================================================== primitive parts
  function dBodyCore(x, y, z) {
    const a = sdEllipsoid(x - belly.c[0], y - belly.c[1], z - belly.c[2], ...belly.r);
    const b = sdEllipsoid(x - chest.c[0], y - chest.c[1], z - chest.c[2], ...chest.r);
    const c = sdEllipsoid(x - rump.c[0], y - rump.c[1], z - rump.c[2], ...rump.r);
    const d = sdEllipsoid(x - nape.c[0], y - nape.c[1], z - nape.c[2], ...nape.r);
    return smin(smin(smin(a, b, P.bodyBlend), c, P.bodyBlend), d, P.bodyBlend);
  }
  /** Body with its joint sockets (neck, shoulders, hips) blended in. */
  function dBody(x, y, z) {
    let d = smin(dBodyCore(x, y, z), sphere(x, y, z, NP, J.neckR), J.neckBlend);
    if (z < 0.16) { // (no y gate: a gate here made a shading line at the gate height; the cap bounds it)
      // lower back half of the skull (cranium + occiput), shrunk, flat-topped and cut at the ear line
      const cr = sdEllipsoid(x - cranium.c[0], y - cranium.c[1], z - cranium.c[2], ...cranium.r);
      const oc = sdEllipsoid(x - occiput.c[0], y - occiput.c[1], z - occiput.c[2], ...occiput.r);
      // top cut = a sphere about the neck pivot (concentric with the head's rotation): when the head nods, the
      // exposed part of the proxy is a rounded ball-joint cap, never a flat shelf
      const proxy = smax(smax(smin(cr, oc, P.headBlend) + J.occiputShrink, sdEllipsoid(x - NP[0], y - NP[1], z - NP[2], ...J.occiputCapR), 0.03), z - 0.02, 0.02);
      d = smin(d, proxy, J.occiputBlend);
    }
    for (let i = 0; i < 2; i++) {
      d = smin(d, sphere(x, y, z, sh[i], arm.r0), J.shoulderBlend);
      d = smin(d, sphere(x, y, z, hip[i], leg.r), J.hipBlend);
    }
    return d;
  }
  function dHeadCore(x, y, z) {
    const a = sdEllipsoid(x - cranium.c[0], y - cranium.c[1], z - cranium.c[2], ...cranium.r);
    snoutF.toLocal(x, y, z, L);
    let b = sdRoundBox(L[0], L[1], L[2], ...snout.half, snout.round);
    if (P.snoutBulge) { const SB = P.snoutBulge; b = smin(b, sdEllipsoid(x - SB.c[0], y - SB.c[1], z - SB.c[2], ...SB.r), SB.k); }
    const o = sdEllipsoid(x - occiput.c[0], y - occiput.c[1], z - occiput.c[2], ...occiput.r);
    return smin(smin(a, o, P.headBlend), b, P.headBlend);
  }
  /** Game head: core + neck ball (smaller than the body's socket). */
  // The lower back of the head (below the strap, behind the neck pivot) is trimmed away: the body's static occiput
  // proxy carries that silhouette, so a pitched/yawed head never shows its own occiput as a ledge.
  const dHeadGame = (x, y, z) => {
    const d = smin(dHeadCore(x, y, z), sphere(x, y, z, NP, J.neckR - J.inset), J.neckBlend);
    const region = smax(y - J.occiputTrimY, z - J.occiputTrimZ, 0.03); // < 0 in the lower-back quadrant
    return smax(d, -region, 0.03);
  };
  function dEar(i, x, y, z) {
    earF[i].toLocal(x, y, z, L);
    return sdEllipsoid(L[0], L[1], L[2], ...ear.r);
  }
  function dPaw(i, x, y, z) {
    const c = handC[i];
    return sdEllipsoid(x - c[0], y - c[1], z - c[2], ...hand.r);
  }
  function dFootEll(i, x, y, z) {
    footF[i].toLocal(x, y, z, L);
    return sdEllipsoid(L[0], L[1], L[2], ...foot.r);
  }
  const dArm = (i, x, y, z, inset = 0) => sdCapsule(x, y, z, sh[i], wr[i], arm.r0 - inset, arm.r1);
  const dLeg = (i, x, y, z, inset = 0) => sdCapsule(x, y, z, hip[i], ank[i], leg.r - inset);

  // ---- grooves (fingers, toes): round profile, radius R centred `a` above the surface
  const g = P.groove;
  const gR = (g.halfWidth ** 2 + g.depth ** 2) / (2 * g.depth);
  const gA = gR - g.depth;
  /** Negative inside the groove cut. d = distance to the host primitive. */
  const hYaw = hand.yaw * DEG;
  function handGroove(i, x, y, z, d) {
    const s = sides[i], c = handC[i];
    const dx = (x - c[0]) * s, ly = y - c[1], dz = z - c[2];
    if (Math.abs(ly) > 0.09 || Math.abs(dx) > 0.09 || Math.abs(dz) > 0.09) return 1;
    // ln: along the outward (back-of-paw) direction, lt: across the fingers (horizontal tangent)
    const ln = dx * Math.sin(hYaw) + dz * Math.cos(hYaw);
    const lt = dx * Math.cos(hYaw) - dz * Math.sin(hYaw);
    let cut = 1;
    for (const gt of hand.grooves) cut = Math.min(cut, Math.hypot(lt - gt, d - gA) - gR);
    // front-bottom (finger tips) of the outer face only, soft ends -> 3 clean strokes
    return smax(smax(cut, ly + 0.012, 0.01), -ln - 0.008, 0.01);
  }
  function footGroove(i, x, y, z, d) {
    const s = sides[i];
    footF[i].toLocal(x, y, z, L);
    if (L[2] < 0.04 || Math.abs(L[0]) > 0.12) return 1;
    const lxf = L[0] * s;
    let cut = 1;
    for (const gx of foot.grooves) cut = Math.min(cut, Math.hypot(lxf - gx, d - gA) - gR);
    // front-top of the toes only, ~0.03 long, never down to the sole
    return smax(smax(cut, 0.078 - L[2], 0.01), 0.014 - L[1], 0.008);
  }
  const cutGroove = (f, gc) => (gc < 0.03 ? smax(f, -gc, g.blend) : f);

  // ---- ear inner (pocket in the fur, filled by the fur_shade disc)
  function earPocket(i, x, y, z) {
    earF[i].toLocal(x, y, z, L);
    // only through the ear's own front face; soft rim (smax) so the pocket edge meshes cleanly
    return smax(smax(Math.hypot(L[0], L[1] - ear.innerLift) - ear.innerR, -L[2], 0.002), L[2] - ear.r[2] - 0.012, 0.002);
  }
  function earInner(i, x, y, z) {
    earF[i].toLocal(x, y, z, L);
    // 0.002 larger than the pocket (radius and floor) so the disc fully fills it
    const cyl = Math.hypot(L[0], L[1] - ear.innerLift) - ear.innerR - 0.002;
    const shifted = sdEllipsoid(L[0], L[1], L[2] + ear.innerInset, ...ear.r);
    return smax(smax(cyl, shifted, 0.002), -L[2] - 0.003, 0.002);
  }
  const nearEar = (y) => Math.abs(y - ear.c[1]) < 0.12;

  // ================================================== blended print solid
  /** Smooth fur envelope before grooves/pockets (used to place accessories). */
  function F0(x, y, z) {
    let f = smin(dBody(x, y, z), dHeadCore(x, y, z), P.neckBlend);
    for (let i = 0; i < 2; i++) {
      f = smin(f, dEar(i, x, y, z), ear.blend);
      f = smin(f, smin(dArm(i, x, y, z), dPaw(i, x, y, z), hand.blend), arm.blend);
      f = smin(f, smin(dLeg(i, x, y, z), dFootEll(i, x, y, z), foot.blend), leg.blend);
    }
    return f;
  }

  // ---- jaw / chin crease: a smooth path sampled once along the seam between head and body
  //      (one continuous U under the chin, running back along the sides), then used as a tube
  const JW = P.jaw;
  function seamPath(surf, seam) {
    const bins = new Map();
    const step = 0.004, BW = 4; // grid step, angle bin width (deg)
    for (let x = -0.26; x <= 0.26; x += step)
      for (let y = 0.56; y <= JW.yMax; y += step)
        for (let z = JW.zMin - 0.02; z <= 0.3; z += step) {
          const f = surf(x, y, z);
          if (Math.abs(f) > step) continue;
          if (Math.abs(seam(x, y, z)) > step) continue;
          const th = Math.atan2(x, z - JW.axisZ) / DEG;
          if (Math.abs(th) > JW.thetaMax) continue;
          const k = Math.round(th / BW);
          const b = bins.get(k) || [0, 0, 0, 0];
          b[0] += x; b[1] += y; b[2] += z; b[3]++;
          bins.set(k, b);
        }
    const keys = [...bins.keys()].sort((a, b) => a - b);
    const pts = [];
    for (const k of keys) {
      const b = bins.get(k);
      let p = [b[0] / b[3], b[1] / b[3], b[2] / b[3]];
      // project onto the surface and the seam (alternating gradient steps)
      for (let it = 0; it < 12; it++) {
        const gs = gradient(surf, ...p);
        p = v3.sub(p, v3.scale(gs, surf(...p)));
        const gq = gradient(seam, ...p);
        p = v3.sub(p, v3.scale(gq, seam(...p) * 0.5));
      }
      if (p[2] < JW.zMin || p[1] > JW.yMax) continue;
      pts.push(p);
    }
    // continuity: split into runs at jumps (> 0.035 between neighbouring bins) and keep the longest run as ONE
    // stroke (no detached end pieces), then smooth (moving average, ends fixed)
    const runs = [[]];
    pts.forEach((p, i) => {
      if (i > 0 && v3.len(v3.sub(pts[i - 1], p)) > 0.035) runs.push([]);
      runs[runs.length - 1].push(p);
    });
    let ok = runs.reduce((a, b) => (b.length > a.length ? b : a));
    // trim ends that curl upward (the seam climbs toward the back of the head): keep one level stroke
    const steep = (a, c) => Math.abs(c[1] - a[1]) > 0.5 * Math.hypot(c[0] - a[0], c[2] - a[2]);
    while (ok.length > 4 && steep(ok[ok.length - 2], ok[ok.length - 1])) ok.pop();
    while (ok.length > 4 && steep(ok[1], ok[0])) ok.shift();
    for (let pass = 0; pass < 3; pass++) {
      ok = ok.map((p, i) => (i === 0 || i === ok.length - 1 ? p : v3.scale(v3.add(v3.add(ok[i - 1], ok[i + 1]), v3.scale(p, 2)), 0.25)));
    }
    // back onto the surface after smoothing
    ok = ok.map((p) => v3.sub(p, v3.scale(gradient(surf, ...p), surf(...p))));
    return catmullRom(ok, 4);
  }
  /** Tube along a path; the radius tapers to 60 % over the last 15 % at both ends. */
  function taperTube(path, x, y, z, r, offsetFn = null) {
    let d = Infinity;
    const n = path.length;
    for (let i = 0; i < n - 1; i++) {
      const t = (i + 0.5) / (n - 1);
      const rr = r * clamp(Math.min(t, 1 - t) / 0.15, 0.6, 1);
      const v = sdCapsule(x, y, z, path[i], path[i + 1], rr);
      if (v < d) d = v;
    }
    return d;
  }
  let jawPathPrint = null, jawPathGame = null, jawBB = null;
  const jawNear = (x, y, z) => jawBB && x > jawBB[0][0] && x < jawBB[1][0] && y > jawBB[0][1] && y < jawBB[1][1] && z > jawBB[0][2] && z < jawBB[1][2];
  const gR2 = (JW.grooveHalfWidth ** 2 + JW.grooveDepth ** 2) / (2 * JW.grooveDepth);
  /** Print: round-profile groove along the crease (negative inside the cut). */
  function jawGroove(x, y, z) {
    if (!JW.enabled || !jawNear(x, y, z)) return 1;
    return taperTube(jawPathPrint, x, y, z, gR2);
  }

  const D1 = { f0: 0 };
  /** Final print fur solid, no ground cut. */
  function F(x, y, z) {
    const f = Fnp(x, y, z);
    if (!nearEar(y)) return f;
    return Math.max(f, -earPocket(0, x, y, z), -earPocket(1, x, y, z));
  }
  /** Print fur solid WITHOUT the ear-inner pockets (the build subtracts a finer pocket mesh). */
  // print-only paw gusset: a steep (> 55 deg) fillet from the paw's underside back into the belly, so the forward-held
  // paws start on the layer below instead of as floating islands (game paws stay free to move)
  const gus = sides.map((s) => [mx(P.print.pawGusset.from, s), mx(P.print.pawGusset.to, s)]);
  function Fnp(x, y, z) {
    let f = F0(x, y, z);
    if (Math.abs(x) > 0.1 && y < 0.4 && z > 0.08)
      for (let i = 0; i < 2; i++) f = smin(f, sdCapsule(x, y, z, gus[i][0], gus[i][1], P.print.pawGusset.r), P.print.pawGusset.blend);
    const f0 = f;
    for (let i = 0; i < 2; i++) {
      f = cutGroove(f, handGroove(i, x, y, z, dPaw(i, x, y, z)));
      f = cutGroove(f, footGroove(i, x, y, z, dFootEll(i, x, y, z)));
    }
    const jg = jawGroove(x, y, z);
    if (jg < 0.02) f = smax(f, -jg, 0.003);
    D1.f0 = f0;
    return f;
  }

  // ---- muzzle region (oval cap)
  const MZ = P.muzzle;
  const muzzleRegion = (x, y, z) => Math.max(sdEllipsoid(x - MZ.c[0], y - MZ.c[1], z - MZ.c[2], ...MZ.r), MZ.yMin - y);

  // ================================================== accessory placement
  const G = P.glasses;
  const up = [0, 1, 0];
  const proj = (origin, dir) => {
    const r = raySurface(F0, origin, v3.norm(dir), 0.6, 0.003);
    if (!r) throw new Error(`projection failed from ${origin} along ${dir}`);
    return r;
  };
  const projZ = (x, y) => proj([x, y, 0.1], [0, 0, 1]);
  const projAngle = (thetaDeg, y) => {
    const t = thetaDeg * DEG;
    return proj([0, y, G.axisZ], [Math.sin(t), 0, Math.cos(t)]);
  };
  const offsetAlong = (r, d) => v3.add(r.p, v3.scale(r.n, d));
  const angleOf = (p) => Math.atan2(p[0], p[2] - G.axisZ) / DEG;

  // lenses
  const lenses = sides.map((s) => {
    const n = [s * Math.sin(G.lensYaw * DEG), 0, Math.cos(G.lensYaw * DEG)];
    const a = mx(G.lensAnchor, s);
    const hit = proj(v3.sub(a, v3.scale(n, 0.2)), n);
    const uFront = [-s * Math.cos(G.lensYaw * DEG), 0, Math.sin(G.lensYaw * DEG)];
    const o = [hit.p[0], a[1], hit.p[2]];
    return { s, n, o, uFront, frame: makeFrame(o, uFront, up, n) };
  });
  const LR = G.lensCorner;
  const lensVt = G.lensTop - LR;
  const lensRy = G.lensTop - G.lensBottom - 2 * LR;
  const lensRx = G.lensHalfW - LR;
  /** "D" outline: flat top, rounded bottom. */
  function lens2D(u, v) {
    return Math.max(sdEllipse2(u, v - lensVt, lensRx, lensRy), v - lensVt) - LR;
  }
  // lens local coords: u = toward the front, v = up, w = along the lens normal (0 at the head surface)
  const lensUVW = (i, x, y, z) => {
    const ln = lenses[i];
    const dx = x - ln.o[0], dy = y - ln.o[1], dz = z - ln.o[2];
    return [dx * ln.uFront[0] + dz * ln.uFront[2], dy, dx * ln.n[0] + dz * ln.n[2]];
  };
  // flat-ish outer face (slightly bent around the head), back side embedded in the fur
  const lensFace = (u, w) => w - G.lensProud + G.lensBend * u * u;
  function lensSDF(i, x, y, z, f0, print = false) {
    const [u, v, w] = lensUVW(i, x, y, z);
    const face = lensFace(u, w);
    let vv = v;
    // print: extend the outline downward 1:1 with depth below the face -> 45 deg chamfer, no lip
    // (capped at lensProud + 0.012 below the face so it only fills the lip-to-head gap, never a ramp off the cheek)
    if (print && P.print.lensChamfer && v < 0 && face < 0) vv = Math.min(v + Math.min(-face, G.lensProud + 0.012), 0);
    let o2 = lens2D(u, vv);
    // print: the top and the front/rear walls get a draft (outline shrinks with depth behind the face), so the lens
    // reads as a curved shade hugging the skull instead of a slab with a flat top shelf; upward-facing, so no overhang
    if (print && face < 0) o2 += P.print.lensDraft * Math.max(0, -face - G.lensRound) * clamp((v + 0.01) / 0.04, 0, 1);
    // true round (radius lensRound) on the whole front perimeter -> no boxy slab edge
    return Math.max(roundRect(o2, face, G.lensRound), -(f0 + G.lensEmbed), -(face + G.lensThick));
  }
  // glint: diagonal stripe from upper-rear to lower-front, inlaid G.glintDepth into the lens face
  function glintSDF(i, x, y, z, f0) {
    const [u, v, w] = lensUVW(i, x, y, z);
    const stripe = Math.abs((u - G.glintOffset) + v) / Math.SQRT2 - G.glintHalfW;
    const face = lensFace(u, w);
    return Math.max(lens2D(u, v) + G.glintInset, stripe, face - 0.002, -G.glintDepth - face);
  }

  // ---- bridge across the forehead: smooth spline hugging the forehead, its ends run INTO the lenses
  const lensCorner = (ln, du, dv) => v3.add(ln.o, v3.add(v3.scale(ln.uFront, du), [0, dv, 0]));
  const innerTop = lenses.map((ln) => lensCorner(ln, G.lensHalfW - 0.035, G.bridgeY - ln.o[1]));
  const thetaInner = Math.abs(angleOf(innerTop[0]));
  const arc = [];
  const NB = 12;
  for (let k = 0; k <= NB; k++) {
    const th = -thetaInner + (2 * thetaInner * k) / NB;
    arc.push(offsetAlong(projAngle(th, G.bridgeY), G.frameProud - G.bridgeR));
  }
  const bridgePts = catmullRom(arc, 5);

  // ---- strap: band hugging the skull from the lens rear edges around the back (rounded section)
  const rearTop = lenses.map((ln) => lensCorner(ln, -(G.lensHalfW - 0.02), G.lensTop - 0.02));
  const thetaStrap = Math.abs(angleOf(rearTop[0])) - 6;
  const GE = 4e-4;
  /** F0 rescaled to (approximately) true distance: |grad F0| drops to ~0.75 in the blends at the back of the head,
   *  which made a constant-f0 band visibly thicker (a brim) there. */
  const f0Dist = (x, y, z, f0) => {
    const gx = F0(x + GE, y, z) - F0(x - GE, y, z), gy = F0(x, y + GE, z) - F0(x, y - GE, z), gz = F0(x, y, z + GE) - F0(x, y, z - GE);
    return f0 / Math.max(0.5, Math.hypot(gx, gy, gz) / (2 * GE));
  };
  const strapT = (th) => (1 - Math.cos(Math.PI * clamp((th - thetaStrap) / (180 - thetaStrap), 0, 1))) / 2; // smooth, level at the back
  const strapY = (th) => G.strapYTemple + (G.strapYBack - G.strapYTemple) * strapT(Math.abs(th));
  function strapSDF(x, y, z, f0) {
    const th = Math.abs(Math.atan2(x, z - G.axisZ)) / DEG;
    if (th < thetaStrap - 8) return 0.1;
    const t = strapT(th);
    const ys = strapY(th);
    const dy = Math.abs(y - ys) - G.strapHalfH;
    if (dy > 0.012 || Math.abs(f0) > 0.03) return Math.max(dy, Math.abs(f0) - 0.015);
    // constant thickness along the surface normal; thinner at the back (hugs the occiput)
    const proud = G.frameProud + (G.frameProudBack - G.frameProud) * t;
    const a = f0Dist(x, y, z, f0);
    const mid = (proud - G.strapEmbed) / 2, ht = (proud + G.strapEmbed) / 2;
    let d = roundRect(dy, Math.abs(a - mid) - ht, G.strapRound);
    // 45 deg underside: never further out than the height above the band's lower edge (no shelf / brim)
    d = smax(d, (a - (y - (ys - G.strapHalfH))) / Math.SQRT2, 0.004);
    return Math.max(d, (thetaStrap - th) * DEG * 0.2);
  }
  // loose strap end: a short flat band flicking back/down behind the right ear (same section as the strap)
  const TR = 0.2; // arc-length radius for the (theta, y) parameterisation
  const T = G.tail;
  const tailMid = (T.proud - G.strapEmbed) / 2, tailHT = (T.proud + G.strapEmbed) / 2;
  // tail end points: (theta, y offset from the strap centre line at that theta)
  const tailA = [T.from[0] * DEG * TR, strapY(T.from[0]) + T.from[1]], tailB = [T.to[0] * DEG * TR, strapY(T.to[0]) + T.to[1]];
  function tailSDF(x, y, z, f0) {
    if (x > 0.05 || z > 0.05) return 0.1;
    const th = Math.atan2(x, z - G.axisZ) / DEG;
    const d2 = sdSegment2(th * DEG * TR, y, tailA[0], tailA[1], tailB[0], tailB[1], T.halfW);
    if (d2 > 0.02) return d2;
    const a = f0Dist(x, y, z, f0);
    let d = roundRect(d2, Math.abs(a - tailMid) - tailHT, G.strapRound);
    // same 45 deg underside as the strap (printable, lies flat on the occiput)
    return smax(d, (a - (y - (tailB[1] - T.halfW))) / Math.SQRT2, 0.004);
  }
  // bounding box for the bridge polyline (cheap early-out)
  const bbMin = [0, 1, 2].map((k) => Math.min(...bridgePts.map((p) => p[k])) - G.bridgeR);
  const bbMax = [0, 1, 2].map((k) => Math.max(...bridgePts.map((p) => p[k])) + G.bridgeR);
  function bridgeSDF(x, y, z) {
    const dx = Math.max(bbMin[0] - x, x - bbMax[0], 0), dy = Math.max(bbMin[1] - y, y - bbMax[1], 0), dz = Math.max(bbMin[2] - z, z - bbMax[2], 0);
    const out = Math.hypot(dx, dy, dz);
    if (out > 0.01) return out;
    return sdPolyline(x, y, z, bridgePts, G.bridgeR);
  }
  function glassesFrameSDF(x, y, z, f0) {
    return Math.min(bridgeSDF(x, y, z), strapSDF(x, y, z, f0), tailSDF(x, y, z, f0));
  }

  // nostrils: small soft dashes "/ \" near the top of the muzzle
  const N = P.nostril;
  const nostrils = sides.map((s) => {
    const dx = s * Math.sin(N.tilt * DEG) * N.len / 2, dy = Math.cos(N.tilt * DEG) * N.len / 2;
    const top = offsetAlong(projZ(s * N.x + dx, N.y + dy), -N.inset);
    const bot = offsetAlong(projZ(s * N.x - dx, N.y - dy), -N.inset);
    return [top, bot];
  });
  const nostrilSDF = (i, x, y, z) => sdCapsule(x, y, z, nostrils[i][0], nostrils[i][1], N.r);

  // mouth: philtrum + "w" smile
  const M = P.mouth;
  const onMuzzle = ([x, y]) => offsetAlong(projZ(x, y), M.proud);
  const mouthLines = [
    M.philtrum.map(onMuzzle),
    catmullRom(M.smile.map(onMuzzle), 3),
    catmullRom(M.smile.map(([x, y]) => onMuzzle([-x, y])), 3),
  ];
  const mouthSDF = (x, y, z) => Math.min(...mouthLines.map((pts) => sdPolyline(x, y, z, pts, M.r)));

  // ---- jaw paths (print: on the blended solid; game: on the rigid head/body union) + game ink tube
  if (JW.enabled) {
    const seamP = (x, y, z) => dHeadCore(x, y, z) - dBody(x, y, z);
    const seamG = (x, y, z) => dHeadGame(x, y, z) - dBody(x, y, z);
    const surfG = (x, y, z) => Math.min(dHeadGame(x, y, z), dBody(x, y, z));
    const pp = seamPath(F0, seamP);
    const pg = seamPath(surfG, seamG);
    // groove tube centre sits (R - depth) outside the surface; ink tube centre sits |inset| inside it
    jawPathPrint = pp.map((p) => v3.add(p, v3.scale(gradient(F0, ...p), gR2 - JW.grooveDepth)));
    jawPathGame = pg.map((p) => v3.add(p, v3.scale(gradient(surfG, ...p), JW.inset)));
    const all = [...jawPathPrint, ...jawPathGame];
    jawBB = [[0, 1, 2].map((k) => Math.min(...all.map((p) => p[k])) - 0.03), [0, 1, 2].map((k) => Math.max(...all.map((p) => p[k])) + 0.03)];
  }
  const jawInkGame = (x, y, z) => (jawNear(x, y, z) ? taperTube(jawPathGame, x, y, z, JW.r) : 0.05);

  // ================================================== composite SDFs
  const HEAD_BOX = { min: [-0.3, 0.52, -0.32], max: [0.3, 1.0, 0.4] };
  const nearHead = (x, y, z) =>
    x > HEAD_BOX.min[0] && x < HEAD_BOX.max[0] && y > HEAD_BOX.min[1] && y < HEAD_BOX.max[1] && z > HEAD_BOX.min[2] && z < HEAD_BOX.max[2];

  /** Print ink: glasses incl. lenses (chamfered), nostrils, mouth. Jaw is a groove in the fur. */
  function inkPrint(x, y, z) {
    if (!nearHead(x, y, z)) return 0.1;
    const f0 = F0(x, y, z);
    if (f0 > 0.06 || f0 < -0.06) return Math.abs(f0) - 0.03;
    let d = glassesFrameSDF(x, y, z, f0);
    for (let i = 0; i < 2; i++) d = Math.min(d, lensSDF(i, x, y, z, f0, true), nostrilSDF(i, x, y, z));
    return Math.min(d, mouthSDF(x, y, z));
  }
  function glintAll(x, y, z) {
    if (!nearHead(x, y, z)) return 0.1;
    const f0 = F0(x, y, z);
    return Math.min(glintSDF(0, x, y, z, f0), glintSDF(1, x, y, z, f0));
  }
  const earInnerAll = (x, y, z) => Math.min(earInner(0, x, y, z), earInner(1, x, y, z));

  // ================================================== game node list
  const pv = {
    body: [0, 0.14, 0],
    head: NP,
    muzzle: [0, 0.745, 0.30],
    glasses: [0, 0.86, 0.12],
  };
  const ground = (d, y) => Math.max(d, -y);
  const earBaseC = sides.map((s) => [s * ear.c[0] * 0.92, ear.c[1] - ear.r[1] * 0.75, ear.c[2]]);
  const gameParts = {
    body: (x, y, z) => dBody(x, y, z),
    head: (x, y, z) => dHeadGame(x, y, z),
    // ear + a soft fillet skirt onto the skull (the skull copy is shrunk by 0.003 and bounded to the ear base, so
    // everywhere except the fillet it stays hidden inside the head)
    ear: (i) => (x, y, z) => {
      const base = Math.max(dHeadCore(x, y, z) + 0.012, sphere(x, y, z, earBaseC[i], 0.105));
      return Math.max(smin(dEar(i, x, y, z), base, 0.032), -earPocket(i, x, y, z));
    },
    arm: (i) => (x, y, z) => dArm(i, x, y, z, J.inset),
    hand: (i) => (x, y, z) => {
      const d = smin(dPaw(i, x, y, z), sphere(x, y, z, wr[i], arm.r1 - J.inset), hand.blend);
      return cutGroove(d, handGroove(i, x, y, z, dPaw(i, x, y, z)));
    },
    // the leg stops above the sole so only the foot owns it (no leg geometry poking through when the ankle turns)
    leg: (i) => (x, y, z) => smax(dLeg(i, x, y, z, 0), 0.03 - y, 0.01),
    foot: (i) => (x, y, z) => {
      const d = smin(dFootEll(i, x, y, z), sphere(x, y, z, ank[i], leg.r - 2 * J.inset), foot.blend);
      return ground(cutGroove(d, footGroove(i, x, y, z, dFootEll(i, x, y, z))), y);
    },
  };

  const nodes = [];
  const add = (name, parent, pivot, material, sdf, opts = {}) => nodes.push({ name, parent, pivot, material, sdf, ...opts });
  const nearHeadSdf = (f) => (x, y, z) => (nearHead(x, y, z) ? f(x, y, z, F0(x, y, z)) : 0.1);

  // normal fields: a part's shading normal = gradient of smin(part, neighbours) -> no shading seam where rigid parts meet
  const NBl = J.normalBlend;
  const nf = (self, ...others) => (x, y, z) => {
    let d = self(x, y, z);
    for (const [o, k] of others) d = smin(d, o(x, y, z), k);
    return d;
  };
  const gArm = sides.map((_, i) => gameParts.arm(i)), gHand = sides.map((_, i) => gameParts.hand(i));
  const gLeg = sides.map((_, i) => gameParts.leg(i)), gFoot = sides.map((_, i) => gameParts.foot(i));
  // limbs only influence each other's normals inside a ball around their joint, so moving a limb never leaves a
  // baked "imprint" in the shading of the body (e.g. where the resting paw/arm was close to the belly)
  const near = (f, c, r) => (x, y, z) => Math.max(f(x, y, z), sphere(x, y, z, c, r));
  const normalField = {
    body: nf(gameParts.body, [gameParts.head, NBl.neck],
      [near(gArm[0], sh[0], 0.1), NBl.shoulder], [near(gArm[1], sh[1], 0.1), NBl.shoulder],
      [near(gLeg[0], hip[0], 0.12), NBl.hip], [near(gLeg[1], hip[1], 0.12), NBl.hip]),
    head: nf(gameParts.head, [gameParts.body, NBl.neck], [(x, y, z) => dEar(0, x, y, z), NBl.ear], [(x, y, z) => dEar(1, x, y, z), NBl.ear]),
    arm: (i) => nf(gArm[i], [near(gameParts.body, sh[i], 0.1), NBl.shoulder], [gHand[i], NBl.wrist]),
    hand: (i) => nf(gHand[i], [gArm[i], NBl.wrist]),
    leg: (i) => nf(gLeg[i], [near(gameParts.body, hip[i], 0.12), NBl.hip], [gFoot[i], NBl.ankle]),
    foot: (i) => nf(gFoot[i], [gLeg[i], NBl.ankle]),
  };

  add('body', 'kubara', pv.body, 'fur', gameParts.body, { fur: true, normalSdf: normalField.body });
  // head + muzzle come from one level set split by the muzzle ellipsoid (curved oval colour edge)
  const headSdf = gameParts.head;
  add('head', 'body', pv.head, 'fur', headSdf, { fur: true, normalSdf: normalField.head, clip: { sdf: muzzleRegion, keep: 'outside' } });
  add('muzzle', 'head', pv.muzzle, 'fur_shade', headSdf, { fur: true, clip: { sdf: muzzleRegion, keep: 'inside' } });
  sides.forEach((s, i) => {
    const sfx = s > 0 ? '_l' : '_r';
    add('nostril' + sfx, 'head', v3.lerp(nostrils[i][0], nostrils[i][1], 0.5), 'ink', (x, y, z) => nostrilSDF(i, x, y, z), { detail: true });
  });
  add('mouth', 'head', [0, 0.70, 0.32], 'ink', mouthSDF, { detail: true });
  if (JW.enabled) add('jaw_line', 'head', [0, 0.62, 0.15], 'ink', jawInkGame, { detail: true, edge: 0.002 });
  sides.forEach((s, i) => {
    const sfx = s > 0 ? '_l' : '_r';
    const earPivot = [s * ear.c[0], ear.c[1] - ear.r[1] * 0.6, ear.c[2]];
    add('ear' + sfx, 'head', earPivot, 'fur', gameParts.ear(i), { fur: true, edge: 0.004, normalSdf: nf((x, y, z) => Math.max(smin(dEar(i, x, y, z), dHeadCore(x, y, z), NBl.ear), -earPocket(i, x, y, z))) });
    add('ear_inner' + sfx, 'ear' + sfx, earPivot, 'fur_shade', (x, y, z) => earInner(i, x, y, z), { detail: true });
  });
  add('glasses', 'head', pv.glasses, 'ink', nearHeadSdf(glassesFrameSDF), { detail: true });
  sides.forEach((s, i) => {
    const sfx = s > 0 ? '_l' : '_r';
    const ln = lenses[i];
    // game: the glint is a separate plate standing 0.002 proud of the (unpocketed) lens face
    // game: analytic meshes (crisp D outline + clean glint stripe); the print uses lensSDF / glintSDF
    const lm = buildLensMeshes(ln, G, F0, { bevel: G.lensBevelGame, rings: 4, bevelSteps: 2 });
    add('lens' + sfx, 'glasses', ln.o, 'ink', nearHeadSdf((x, y, z, f0) => lensSDF(i, x, y, z, f0)), { detail: true, mesh: lm.lens, creaseDeg: 40 });
    add('glint' + sfx, 'lens' + sfx, ln.o, 'glint', nearHeadSdf((x, y, z, f0) => glintSDF(i, x, y, z, f0)), { detail: true, mesh: lm.glint, creaseDeg: 40 });
  });
  sides.forEach((s, i) => {
    const sfx = s > 0 ? '_l' : '_r';
    add('arm' + sfx, 'body', sh[i], 'fur', gArm[i], { fur: true, normalSdf: normalField.arm(i) });
    add('hand' + sfx, 'arm' + sfx, wr[i], 'fur', gHand[i], { fur: true, edge: P.game.pawEdge, normalSdf: normalField.hand(i), attrNormals: 0.5 });
    add('leg' + sfx, 'body', hip[i], 'fur', gLeg[i], { fur: true, normalSdf: normalField.leg(i) });
    add('foot' + sfx, 'leg' + sfx, ank[i], 'fur', gFoot[i], { fur: true, edge: P.game.pawEdge, normalSdf: normalField.foot(i), attrNormals: 0.5 });
  });

  return {
    params: P,
    palette: PALETTE,
    F, F0,
    Fnp, earPocketAll: (x, y, z) => Math.min(earPocket(0, x, y, z), earPocket(1, x, y, z)),
    inkPrint, glintAll, muzzleRegion, earInnerAll,
    nodes,
    height: ear.c[1] + ear.r[1], // ear tips (ears are only yawed, so the ellipsoid top is the highest point)
    bounds: { min: [-0.36, -0.02, -0.32], max: [0.36, 1.03, 0.4] },
    headBox: HEAD_BOX,
    debug: { lenses, bridgePts, nostrils, mouthLines, thetaStrap, thetaInner, jawPathPrint, jawPathGame },
  };
}
