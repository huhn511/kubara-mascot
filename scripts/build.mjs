#!/usr/bin/env node
// npm run build  ->  dist/kubara.glb, dist/print/{kubara.stl, kubara_nobase.stl, kubara_multicolor.3mf, parts/*.stl}
// Flags: --game-only | --print-only | --fast (coarser print mesh for quick iteration)
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import Module from 'manifold-3d';
import { Document, NodeIO } from '@gltf-transform/core';
import { MeshoptSimplifier } from 'meshoptimizer';
import { createModel, PARAMS } from '../src/model/kubara.js';
import { gradient } from '../src/model/sdf.js';
import { writeSTL, write3MF, hexToLinear } from './lib/io.mjs';
import { decimate, creasedNormals, readSTLWelded, topology, dropDegenerate, compact, taubin } from './lib/mesh.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DIST = join(ROOT, 'dist');
const PRINT = join(DIST, 'print');
const args = new Set(process.argv.slice(2));
const doGame = !args.has('--print-only');
const doPrint = !args.has('--game-only');
const fast = args.has('--fast');

const wasm = await Module();
wasm.setup();
const { Manifold, CrossSection, Mesh } = wasm;
await MeshoptSimplifier.ready;

const model = createModel(PARAMS);
const P = model.params;
const t0 = Date.now();
const log = (...a) => console.log(`[${((Date.now() - t0) / 1000).toFixed(1)}s]`, ...a);

// ------------------------------------------------------------------ helpers
/** Mesh an SDF (negative inside) with Manifold's marching tetrahedra. */
function levelSet(sdf, bounds, edge) {
  const m = Manifold.levelSet((p) => -sdf(p[0], p[1], p[2]), bounds, edge);
  if (m.status() !== 'NoError') throw new Error('levelSet status ' + m.status());
  return m;
}

/** Tight bounds of {sdf < 0} found on a coarse grid, padded. */
function autoBounds(sdf, B, step = 0.01, pad = 0.025) {
  const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
  for (let x = B.min[0]; x <= B.max[0]; x += step)
    for (let y = B.min[1]; y <= B.max[1]; y += step)
      for (let z = B.min[2]; z <= B.max[2]; z += step) {
        if (sdf(x, y, z) < step) {
          if (x < min[0]) min[0] = x; if (y < min[1]) min[1] = y; if (z < min[2]) min[2] = z;
          if (x > max[0]) max[0] = x; if (y > max[1]) max[1] = y; if (z > max[2]) max[2] = z;
        }
      }
  if (!isFinite(min[0])) return null;
  return { min: min.map((v) => v - pad), max: max.map((v) => v + pad) };
}

/** Is this indexed mesh a valid closed 2-manifold (as Manifold sees it), with the expected shell count? */
function validClosed(pos, idx, shells = null) {
  try {
    const m = new Manifold(new Mesh({ numProp: 3, vertProperties: pos, triVerts: idx }));
    if (m.status() !== 'NoError' || m.numTri() === 0) return false;
    const t = topology(idx, pos.length / 3);
    if (process.env.DEBUG_DECIMATE) console.log('  validClosed', idx.length / 3, JSON.stringify(t), 'want shells', shells);
    if (t.boundary || t.nonManifold || t.misoriented) return false;
    return shells == null || t.components === shells;
  } catch (e) {
    if (process.env.DEBUG_DECIMATE) console.log('  validClosed throw', e.message, idx.length / 3, JSON.stringify(topology(idx, pos.length / 3)));
    return false;
  }
}

function check(name, m) {
  const st = m.status();
  const info = {
    name,
    status: st,
    triangles: m.numTri(),
    genus: m.genus(),
    volume: +m.volume().toFixed(3),
    shells: m.decompose().length,
    bbox: (({ min, max }) => ({ min: min.map((v) => +v.toFixed(2)), max: max.map((v) => +v.toFixed(2)) }))(m.boundingBox()),
  };
  info.watertight = st === 'NoError' && m.numTri() > 0 && info.volume > 0;
  return info;
}

const r3 = (a) => a.map((v) => +v.toFixed(4));

// ================================================================== GAME
async function buildGame() {
  const G = P.game;
  const doc = new Document();
  doc.createBuffer();
  const mats = {};
  // flat-ish toon-friendly PBR: matte fur, satin ink (no specular streaks showing facets)
  const matDefs = { fur: { rough: 0.85 }, fur_shade: { rough: 0.85 }, ink: { rough: 0.55 }, glint: { rough: 0.4 } };
  for (const [name, d] of Object.entries(matDefs)) {
    mats[name] = doc.createMaterial(name)
      .setBaseColorFactor([...hexToLinear(model.palette[name]), 1])
      .setMetallicFactor(0)
      .setRoughnessFactor(d.rough);
  }
  const scene = doc.createScene('Scene');
  const root = doc.createNode('kubara');
  // normalise to exactly 1.0 m (ground -> ear tips); the model's own units put the ear tips at model.height
  const S = G.normalizeHeight ? 1 / model.height : 1;
  root.setExtras({ palette: model.palette, units: 'm', up: 'Y', forward: '+Z', height: +(model.height * S).toFixed(4), modelScale: +S.toFixed(5) });
  scene.addChild(root);
  const nodes = { kubara: { node: root, pivot: [0, 0, 0] } };
  let total = 0;
  const report = [];

  const lsCache = new Map();
  const sdfId = new Map();
  const getLS = (sdf, edge, detail, B = model.bounds) => {
    if (!sdfId.has(sdf)) sdfId.set(sdf, sdfId.size);
    const key = sdfId.get(sdf) + '|' + edge;
    let m = lsCache.get(key);
    if (!m) {
      const bounds = autoBounds(sdf, B, detail ? 0.006 : 0.012);
      if (!bounds) throw new Error('empty part');
      m = levelSet(sdf, bounds, edge);
      lsCache.set(key, m);
    }
    return m;
  };
  for (const n of model.nodes) {
    const edge0 = n.edge ?? (n.detail ? G.detailEdge : G.edge);
    const budget = G.budgets[n.name] ?? 1000;
    let pos, idx, shells, ok = false;
    // mesh fine, decimate to budget keeping the part closed; if that fails, re-mesh coarser and retry
    // first try a few slightly different grids with (almost) the full budget, only then accept fewer triangles
    const plan = n.mesh ? [] : [[1, 'near'], [1.06, 'near'], [1.13, 'near'], [1, 'far'], [1.35, 'far'], [1.8, 'far'], [2.4, 'far']];
    if (n.mesh) { pos = n.mesh.pos; idx = n.mesh.idx; ok = true; } // analytic mesh (lenses, glints)
    for (const [mul, range] of plan) {
      const edge = edge0 * mul;
      let m = getLS(n.sdf, edge, n.detail);
      if (n.clip) {
        const bb = m.boundingBox();
        const C = getLS(n.clip.sdf, 0.004, false, { min: bb.min.map((v) => v - 0.02), max: bb.max.map((v) => v + 0.02) });
        m = n.clip.keep === 'inside' ? m.intersect(C) : m.subtract(C);
      }
      shells = m.decompose().length;
      const mesh = m.getMesh();
      pos = new Float32Array(mesh.vertProperties);
      idx = new Uint32Array(mesh.triVerts);
      // (no vertex locking: locked seams make meshopt fold triangles into non-manifold fins)
      let attrs = null;
      if (n.attrNormals) {
        // per-vertex SDF normals as a decimation attribute: keeps small shading features (finger/toe grooves)
        const nv0 = pos.length / 3, data = new Float32Array(nv0 * 3);
        for (let v = 0; v < nv0; v++) data.set(gradient(n.sdf, pos[3 * v], pos[3 * v + 1], pos[3 * v + 2], 2.5e-4), 3 * v);
        attrs = { data, stride: 3, weights: [n.attrNormals, n.attrNormals, n.attrNormals] };
      }
      const r = decimate(pos, idx, budget, (p, i) => validClosed(p, i, shells), null, !n.detail, range === 'near' ? [1, 1.015, 1.03, 1.05, 1.08] : [1.12, 1.18, 1.3, 1.5], attrs);
      pos = r.pos; idx = r.idx; ok = r.ok;
      if (ok) break;
    }
    const closed = validClosed(pos, idx);
    // normals: creased (ink plates keep flat faces + crisp rims); fur parts use the smooth SDF gradient, and near
    // joints the gradient of the smooth-min with the neighbouring part (normalSdf) so the shading is continuous
    const sm = n.mesh ? null : (x, y, z) => gradient(n.normalSdf ?? n.sdf, x, y, z, 2.5e-4);
    const out = creasedNormals(pos, idx, n.creaseDeg ?? G.creaseDeg, sm, n.normalSdf ? 60 : 35);
    const nv = out.pos.length / 3;
    for (let v = 0; v < nv; v++) for (let k = 0; k < 3; k++) out.pos[3 * v + k] = (out.pos[3 * v + k] - n.pivot[k]) * S;
    const buf = doc.getRoot().listBuffers()[0];
    const prim = doc.createPrimitive()
      .setAttribute('POSITION', doc.createAccessor().setType('VEC3').setArray(out.pos).setBuffer(buf))
      .setAttribute('NORMAL', doc.createAccessor().setType('VEC3').setArray(out.nrm).setBuffer(buf))
      .setIndices(doc.createAccessor().setType('SCALAR').setArray(nv < 65535 ? new Uint16Array(out.idx) : out.idx).setBuffer(buf))
      .setMaterial(mats[n.material]);
    const parent = nodes[n.parent];
    const node = doc.createNode(n.name)
      .setTranslation(r3(n.pivot.map((v, k) => (v - parent.pivot[k]) * S)))
      .setMesh(doc.createMesh(n.name).addPrimitive(prim));
    node.setExtras({ pivotWorld: r3(n.pivot.map((v) => v * S)), material: n.material });
    parent.node.addChild(node);
    nodes[n.name] = { node, pivot: n.pivot };
    const tris = out.idx.length / 3;
    total += tris;
    report.push({ part: n.name, tris, material: n.material, closed, shells });
  }
  mkdirSync(DIST, { recursive: true });
  await new NodeIO().write(join(DIST, 'kubara.glb'), doc);
  log(`GLB: ${model.nodes.length} parts, ${total} triangles -> dist/kubara.glb`);
  const open = report.filter((r) => !r.closed).map((r) => r.part);
  if (open.length) console.warn('WARNING: game parts not closed 2-manifold after decimation:', open.join(', '));
  return { total, parts: report, notClosed: open };
}

// ================================================================== PRINT
function buildPrint() {
  const PR = P.print;
  const furEdge = fast ? 0.008 : PR.furEdge;
  const detailEdge = fast ? 0.004 : PR.detailEdge;
  const gap = PR.partGap;
  mkdirSync(join(PRINT, 'parts'), { recursive: true });

  // --- fur shell (flat sole: trimmed exactly at y = 0)
  // fur WITHOUT the ear-inner pockets (Fnp): those are subtracted below as a finer mesh so their rims stay crisp
  let FUR = levelSet(model.Fnp, model.bounds, furEdge).trimByPlane([0, 1, 0], 0);
  log('fur shell', FUR.numTri());
  if (PR.furSmoothPasses > 0) {
    // Taubin smoothing (no shrink): removes the level-set faceting / streaks; the flat sole stays exactly at y = 0
    const mesh = FUR.getMesh();
    const np = mesh.numProp, nV = mesh.vertProperties.length / np;
    const p64 = new Float64Array(nV * 3);
    for (let v = 0; v < nV; v++) for (let k = 0; k < 3; k++) p64[3 * v + k] = mesh.vertProperties[v * np + k];
    taubin(p64, mesh.triVerts, PR.furSmoothPasses, 0.5, -0.53, (y) => Math.abs(y) < 1e-9);
    const sm = new Manifold(new Mesh({ numProp: 3, vertProperties: Float32Array.from(p64), triVerts: mesh.triVerts }));
    if (sm.status() === 'NoError' && sm.decompose().length === FUR.decompose().length) FUR = sm;
    else console.warn('fur smoothing rejected:', sm.status());
  }
  if (PR.furSimplifyTol > 0) FUR = FUR.simplify(PR.furSimplifyTol);
  log('fur shell simplified', FUR.numTri());
  {
    const pb = autoBounds(model.earPocketAll, model.headBox, 0.005);
    const POCKET = levelSet(model.earPocketAll, pb, Math.min(detailEdge, 0.002));
    FUR = FUR.subtract(POCKET);
    log('ear pockets subtracted');
  }

  // --- colour volumes; each "grown" twin is the same SDF offset by `gap` on the SAME grid, used for
  //     subtracting, so neighbouring colour parts never share coincident faces (no pinched edges).
  const pair = (sdf, B, edge) => {
    const bounds = autoBounds(sdf, B, 0.005);
    const t = PR.detailSimplifyTol;
    return [levelSet(sdf, bounds, edge).simplify(t), levelSet((x, y, z) => sdf(x, y, z) - gap, bounds, edge).simplify(t)];
  };
  const [MUZ, MUZg] = pair(model.muzzleRegion, model.headBox, detailEdge);
  const [EAR, EARg] = pair(model.earInnerAll, model.headBox, detailEdge);
  const [INK, INKg] = pair(model.inkPrint, model.headBox, detailEdge);
  log('ink', INK.numTri());
  const [GL, GLg] = pair(model.glintAll, model.headBox, Math.min(detailEdge, 0.002));
  log('glint', GL.numTri());

  // --- base (rounded heptagon, flat edge at the back)
  let BASE = null, BASEpart = null;
  const B = PR.base;
  if (B.enabled) {
    const pts = [];
    for (let k = 0; k < 7; k++) {
      const a = (90 + 360 / 14 + (k * 360) / 7) * Math.PI / 180;
      pts.push([B.circumradius * Math.cos(a), B.circumradius * Math.sin(a)]);
    }
    const cs = new CrossSection([pts]).offset(-B.corner, 'Miter').offset(B.corner, 'Round', 2, 96);
    // extrude along +Z then rotate so Z->Y ; (a,b,h) -> (a,h,-b)
    BASEpart = cs.extrude(B.thickness - gap).rotate([-90, 0, 0]).translate([0, -B.thickness, 0]); // stops `gap` below the soles
    // single body: the same plate plus a sole-shaped plug bridging the `gap` (so kubara.stl == union of the parts,
    // apart from that 0.01 mm plug, instead of a 0.25 mm thicker plate top)
    const sole = FUR.rotate([90, 0, 0]).slice(0.0005); // Y-up -> Z-up, cross-section just above the ground
    const plug = sole.extrude(gap + 0.001).translate([0, 0, -(gap + 0.0005)]).rotate([-90, 0, 0]);
    BASE = BASEpart.add(plug);
  }

  // --- disjoint colour groups (priority glint > ink > shade > fur)
  const glint = GL.intersect(INK); // true inlay inside the lens: kubara.stl contains it
  const ink = INK.subtract(GLg);
  const shade = FUR.intersect(MUZ).add(EAR).subtract(INKg);
  const fur = FUR.subtract(MUZg).subtract(EARg).subtract(INKg);

  // --- to printer frame: Z-up, mm, figure height = heightMM, sitting on the base
  const figH = FUR.boundingBox().max[1];
  const s = PR.heightMM / figH;
  const lift = BASE ? B.thickness : 0;
  const toPrint = (m) => m.translate([0, lift, 0]).rotate([90, 0, 0]).scale(s);

  const groups = [
    { name: 'fur', color: model.palette.fur, extruder: 1, m: fur },
    { name: 'fur_shade', color: model.palette.fur_shade, extruder: 2, m: shade },
    { name: 'ink', color: model.palette.ink, extruder: 3, m: BASEpart && B.color === 'ink' ? ink.add(BASEpart) : ink },
    { name: 'glint', color: model.palette.glint, extruder: 4, m: glint },
  ];
  if (BASEpart && B.color !== 'ink') {
    groups.push({ name: 'base', color: model.palette[B.color] ?? model.palette.brand_teal, extruder: 2, m: BASEpart });
  }
  // drop tiny boolean slivers / micro-cavities
  const clean = (m) => {
    const sh = m.decompose();
    if (sh.length === 1) return m;
    return Manifold.compose(sh.filter((x) => Math.abs(x.volume()) > PR.minShellMM3));
  };

  // verify-on-write: re-read the STL, weld by position like a slicer, demand a closed 2-manifold
  const verify = (path, expectShells) => {
    const r = readSTLWelded(path);
    const t = topology(r.idx, r.pos.length / 3);
    let reload = 'ok', reShells = null;
    try {
      const m = new Manifold(new Mesh({ numProp: 3, vertProperties: r.pos, triVerts: r.idx }));
      reShells = m.decompose().length;
      if (m.status() !== 'NoError') reload = m.status();
    } catch (e) { reload = 'error: ' + e.message; }
    const ok = !t.boundary && !t.nonManifold && !t.misoriented && !r.degenerate && reload === 'ok' && (expectShells == null || reShells === expectShells);
    return { welded: { ...t, degenerate: r.degenerate, reload, reloadShells: reShells }, verified: ok };
  };
  /**
   * Write an STL; if the position-welded read-back is not a clean 2-manifold (two index-distinct vertices that
   * collapse to the same float32 position, e.g. where two sheets kiss after a boolean), "unpinch": nudge every
   * colliding duplicate 1e-4 mm inward along its own vertex normal so the sheets separate, then write again.
   */
  const writeVerified = (path, m, title, expectShells = null) => {
    const shells = expectShells ?? m.decompose().length;
    const mesh = m.getMesh();
    const np = mesh.numProp, tv = mesh.triVerts;
    const nV = mesh.vertProperties.length / np;
    const vp = new Float64Array(nV * 3);
    for (let v = 0; v < nV; v++) for (let k = 0; k < 3; k++) vp[3 * v + k] = mesh.vertProperties[v * np + k];
    const out = { vertProperties: vp, numProp: 3, triVerts: tv };
    writeSTL(path, out, title);
    let v = verify(path, shells);
    for (let pass = 1; pass <= 3 && !v.verified; pass++) {
      const nrm = new Float64Array(nV * 3);
      for (let t = 0; t < tv.length; t += 3) {
        const a = tv[t] * 3, b = tv[t + 1] * 3, c = tv[t + 2] * 3;
        const ux = vp[b] - vp[a], uy = vp[b + 1] - vp[a + 1], uz = vp[b + 2] - vp[a + 2];
        const wx = vp[c] - vp[a], wy = vp[c + 1] - vp[a + 1], wz = vp[c + 2] - vp[a + 2];
        const nx = uy * wz - uz * wy, ny = uz * wx - ux * wz, nz = ux * wy - uy * wx;
        for (const q of [a, b, c]) { nrm[q] += nx; nrm[q + 1] += ny; nrm[q + 2] += nz; }
      }
      const seen = new Map();
      let moved = 0;
      const f32 = new Float32Array(3);
      for (let i = 0; i < nV; i++) {
        f32[0] = vp[3 * i]; f32[1] = vp[3 * i + 1]; f32[2] = vp[3 * i + 2];
        const k = `${f32[0]},${f32[1]},${f32[2]}`;
        if (!seen.has(k)) { seen.set(k, i); continue; }
        const l = Math.hypot(nrm[3 * i], nrm[3 * i + 1], nrm[3 * i + 2]) || 1;
        const d = 1e-4 * pass;
        for (let q = 0; q < 3; q++) vp[3 * i + q] -= (nrm[3 * i + q] / l) * d;
        moved++;
      }
      writeSTL(path, out, title);
      v = verify(path, shells);
      v.unpinched = (v.unpinched || 0) + moved;
    }
    return { m, v, mesh: out };
  };

  const checks = [];
  for (const gp of groups) {
    gp.m = clean(toPrint(gp.m));
    const { m, v, mesh } = writeVerified(join(PRINT, 'parts', `${gp.name}.stl`), gp.m, `kubara ${gp.name}`);
    gp.m = m;
    gp.mesh = mesh; // the exact (unpinched) vertices written to the STL -> the 3MF carries identical geometry
    checks.push({ ...check(`parts/${gp.name}.stl`, m), ...v });
  }
  // single body from the raw (overlapping) volumes: fur + ear discs + ink (+ base); the muzzle and glint
  // are already inside FUR / INK, so nothing in the union depends on coincident faces.
  let union = clean(toPrint(Manifold.union([FUR, EAR, INK, ...(BASE ? [BASE] : [])])));
  {
    const { m, v } = writeVerified(join(PRINT, 'kubara.stl'), union, 'kubara', 1);
    union = m;
    checks.unshift({ ...check('kubara.stl', m), ...v });
  }
  // no-base variant
  const nb = clean(Manifold.union([FUR, EAR, INK]).rotate([90, 0, 0]).scale(s));
  {
    const { m, v } = writeVerified(join(PRINT, 'kubara_nobase.stl'), nb, 'kubara (no base)', 1);
    checks.push({ ...check('kubara_nobase.stl', m), ...v });
  }

  // human-readable print notes next to the files (slicer settings the geometry needs)
  const baseMM = (lift * s).toFixed(2);
  writeFileSync(join(PRINT, 'PRINT_NOTES.txt'), [
    'kubara mascot - print notes (generated by npm run build)',
    'Full guide with measured overhangs, filament and slicer numbers: PRINTING.md (npm run print:report)',
    '',
    `Size: figure ${PR.heightMM} mm tall (ground to ear tips) + ${baseMM} mm heptagon base = ${(PR.heightMM + lift * s).toFixed(1)} mm total.`,
    '      kubara_nobase.stl is the bare figure (exactly ' + PR.heightMM + ' mm, flat soles).',
    '      Scale uniformly in the slicer for other sizes; below ~60 mm the nostrils/mouth/glint get thinner than 1 mm.',
    '',
    'Files:',
    '  kubara.stl              single watertight body (single-colour print)',
    '  kubara_multicolor.3mf   one object, 4 named parts with filament slots pre-assigned (Bambu Studio / OrcaSlicer)',
    '  parts/*.stl             the same 4 colour parts as STL, shared coordinate frame (load together -> they reassemble)',
    '',
    'Supports: REQUIRED. Use tree supports (Bambu: "tree(auto)"), overhang threshold 45-50 deg, "on build plate only" is fine',
    '  (everything that needs support is reachable from the base). Areas that need it:',
    '   - under the chin / snout (~53-56 mm; the largest ceiling, tree supports reach it from the plate)',
    '   - the belly / crotch between the legs just above the base, and the rump underside',
    '  Alternatively paint supports on those three areas only. The lenses, strap, arms and paws print without support',
    '  (lens undersides are chamfered 45 deg, the strap underside is 45 deg, the paws have a hidden gusset into the belly).',
    '',
    'Multi-colour (AMS): map the filament slots as',
    `  slot 1 = fur        ${model.palette.fur}  light mint / aqua`,
    `  slot 2 = fur_shade  ${model.palette.fur_shade}  turquoise / dark teal (muzzle, inner ears)`,
    `  slot 3 = ink        ${model.palette.ink}  black (glasses, strap, nostrils, mouth, base)`,
    `  slot 4 = glint      ${model.palette.glint}  white (lens glints)`,
    '  Bambu Studio reads the part -> slot assignment from the 3MF but may show all 4 slots in its default colour;',
    '  set the slot colours (or your AMS mapping) as above before slicing.',
    '',
  ].join('\n'));

  write3MF(join(PRINT, 'kubara_multicolor.3mf'), groups.map((g) => ({ name: g.name, color: g.color, extruder: g.extruder, mesh: g.mesh })));
  log('3MF written');

  // overlap check between colour parts (should be ~0) and containment in the single body
  let overlap = 0;
  for (let i = 0; i < groups.length; i++)
    for (let j = i + 1; j < groups.length; j++) overlap += groups[i].m.intersect(groups[j].m).volume();
  const partsUnion = Manifold.union(groups.map((g) => g.m));
  const outside = partsUnion.subtract(union).volume();
  return {
    scaleMMPerUnit: +s.toFixed(3), figureHeightMM: PR.heightMM, baseMM: +(lift * s).toFixed(2),
    partOverlapMM3: +overlap.toFixed(4), partsOutsideBodyMM3: +outside.toFixed(4), checks,
  };
}

// ================================================================== run
let prev = {};
try { prev = JSON.parse(readFileSync(join(DIST, 'build-report.json'), 'utf8')); } catch {}
const report = { ...prev, date: new Date().toISOString(), fast };
if (doGame) report.game = await buildGame();
if (doPrint) report.print = buildPrint();
mkdirSync(DIST, { recursive: true });
writeFileSync(join(DIST, 'build-report.json'), JSON.stringify(report, null, 2));

// ---- sanity summary
console.log('\n================ sanity check ================');
if (doGame) {
  console.log(`game GLB triangles: ${report.game.total} (budget 30000) ${report.game.total <= 30000 ? 'OK' : 'OVER BUDGET'}`);
  if (report.game.notClosed.length) console.log('game parts not closed:', report.game.notClosed.join(', '));
}
if (doPrint) {
  const pr = report.print;
  console.log(`print scale: ${pr.scaleMMPerUnit} mm/unit, base ${pr.baseMM} mm, colour-part overlap ${pr.partOverlapMM3} mm^3, parts outside body ${pr.partsOutsideBodyMM3} mm^3`);
  for (const c of pr.checks) {
    const w = c.welded;
    console.log(`${c.watertight && c.verified ? 'OK  ' : 'FAIL'} ${c.name.padEnd(22)} tris=${String(c.triangles).padStart(7)} genus=${c.genus} shells=${c.shells} vol=${c.volume}mm3 | welded: nonManifold=${w.nonManifold} boundary=${w.boundary} misoriented=${w.misoriented} degenerate=${w.degenerate} reloadShells=${w.reloadShells}${c.unpinched ? ` (unpinched ${c.unpinched} verts)` : ''}`);
  }
  const bad = pr.checks.filter((c) => !c.watertight || !c.verified);
  const multi = pr.checks.find((c) => c.name === 'kubara.stl').shells !== 1;
  if (bad.length || multi) {
    console.error('PRINT CHECK FAILED', multi ? '(kubara.stl is not a single shell)' : '', bad.map((c) => c.name).join(', '));
    process.exitCode = 1;
  }
}
log('done');
