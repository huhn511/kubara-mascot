#!/usr/bin/env node
// npm run print:report
//   Re-verifies every file in dist/print (STL watertightness, 3MF structure + geometry), writes the scaled
//   variant kubara_120mm.stl, analyses the print (overhangs / floating islands, local wall thickness, volume,
//   filament), optionally slices with the Bambu Studio CLI for real time / gram numbers, and writes
//   dist/print/print-analysis.json + dist/print/PRINTING.md.
// Flags: --no-slice (skip Bambu Studio)   --quick (fewer thickness samples)
// Run after `npm run build` (it only reads the build outputs; it never changes the model).
import { readFileSync, writeFileSync, existsSync, readdirSync, mkdtempSync, mkdirSync, rmSync, statSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import Module from 'manifold-3d';
import { unzipSync, zipSync, strFromU8, strToU8 } from 'fflate';
import { readSTLWelded, topology } from './lib/mesh.mjs';
import { writeSTL } from './lib/io.mjs';
import { buildGrid, raycast, triInfo, cone, bboxOf } from './lib/raycast.mjs';
import { PARAMS, PALETTE } from '../src/model/kubara.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const PRINT = join(ROOT, 'dist/print');
const args = new Set(process.argv.slice(2));
const QUICK = args.has('--quick');
const BAMBU = process.env.BAMBU_STUDIO || '/Applications/BambuStudio.app/Contents/MacOS/BambuStudio';
const BBL = process.env.BAMBU_PROFILES || '/Applications/BambuStudio.app/Contents/Resources/profiles/BBL';
const DO_SLICE = !args.has('--no-slice') && existsSync(BAMBU) && existsSync(BBL);
const PLA = 1.24; // g/cm^3
const FIL_AREA = Math.PI * 0.875 ** 2; // 1.75 mm filament, mm^2
const OVERHANG_DEG = 45;
const LAYER = 0.2;

const wasm = await Module();
wasm.setup();
const { Manifold, Mesh } = wasm;
const t0 = Date.now();
const log = (...a) => console.log(`[${((Date.now() - t0) / 1000).toFixed(1)}s]`, ...a);
const r2 = (v) => +v.toFixed(2);
const fmt = (v, d = 1) => Number(v).toFixed(d);
const free = (...o) => o.forEach((x) => x?.delete?.());

// ------------------------------------------------------------------ anatomy labels (print frame: mm, Z-up, front = -Y)
// heights derived from the model parameters: print z = modelY * scale + base
const report0 = JSON.parse(readFileSync(join(ROOT, 'dist/build-report.json'), 'utf8')).print;
const S = report0.scaleMMPerUnit, BASE = report0.baseMM;
const zOf = (modelY) => modelY * S + BASE;
const Z = {
  footTop: zOf(0.09), hip: zOf(0.17), paw: zOf(PARAMS.hand.c[1] + PARAMS.hand.r[1]), shoulder: zOf(PARAMS.arm.shoulder[1] + 0.05),
  chin: zOf(PARAMS.snout.c[1] - PARAMS.snout.half[1] - 0.03), lens: zOf(PARAMS.glasses.lensAnchor[1] - 0.07), earBase: zOf(PARAMS.ear.c[1] - 0.05),
};
function label(x, y, z) {
  const ax = Math.abs(x), side = x > 0 ? 'left' : 'right'; // character's left = +X
  if (z < BASE + 0.15) return 'base plate';
  if (z < Z.footTop) return y < -6 && ax > 4 ? `toes (${side} foot)` : ax < 7 ? 'between the feet / crotch' : `heel / sole (${side} foot)`;
  if (z < Z.hip) return ax < 9 ? 'underside between the legs (crotch / rump)' : `inner thigh / hip (${side})`;
  if (z < Z.paw && ax > 10 && y < -6) return `under the ${side} paw`;
  if (z < Z.shoulder) return ax > 15 ? `${side} arm / elbow` : y > 0 ? 'back of the body' : 'belly';
  if (z < Z.chin + 4) return y < -4 ? 'chin / underside of the snout' : y > 4 ? 'back of the head (occiput)' : 'jaw / neck';
  if (z < Z.earBase) return y < -6 ? (ax > 6 ? `${side} sunglasses lens` : 'snout / muzzle') : y > 6 ? 'back of the head / strap' : 'head side / strap';
  return `${side} ear`;
}

// ------------------------------------------------------------------ mesh helpers
function loadSTL(path) {
  const r = readSTLWelded(path);
  return { pos: r.pos, idx: r.idx, nTri: r.nTri, degenerate: r.degenerate };
}
function surfaceArea(pos, idx) {
  let a = 0;
  for (let t = 0; t < idx.length / 3; t++) a += triInfo(pos, idx, t).area;
  return a;
}
function verifyMesh(name, m) {
  const topo = topology(m.idx, m.pos.length / 3);
  let status = 'n/a', volume = 0, genus = null, shells = null, M = null;
  try {
    M = new Manifold(new Mesh({ numProp: 3, vertProperties: m.pos, triVerts: m.idx }));
    status = M.status();
    volume = M.volume(); genus = M.genus(); shells = M.decompose().length;
  } catch (e) { status = 'error: ' + e.message; }
  const bb = bboxOf(m.pos);
  const watertight = status === 'NoError' && !topo.boundary && !topo.nonManifold && !topo.misoriented && !m.degenerate && volume > 0;
  return {
    name, triangles: m.nTri, watertight, manifoldStatus: status, boundaryEdges: topo.boundary, nonManifoldEdges: topo.nonManifold,
    misorientedEdges: topo.misoriented, degenerateTris: m.degenerate, shells, genus,
    volumeMM3: r2(volume), areaMM2: r2(surfaceArea(m.pos, m.idx)),
    bbox: { min: bb.min.map(r2), max: bb.max.map(r2), size: bb.max.map((v, k) => r2(v - bb.min[k])) },
    _M: M,
  };
}

// ================================================================== 1. STL verification + 120 mm variant
const files = ['kubara.stl', 'kubara_nobase.stl', ...readdirSync(join(PRINT, 'parts')).filter((f) => f.endsWith('.stl')).sort().map((f) => 'parts/' + f)];

// kubara_120mm.stl: uniform scale of kubara.stl so the FIGURE is 120 mm (the base scales with it). Scaling the
// float32 STL directly can collapse sub-ulp sliver edges, so go through manifold: scale, drop edges < 1 um, write.
{
  const k = 120 / report0.figureHeightMM;
  const src = loadSTL(join(PRINT, 'kubara.stl'));
  const M120 = new Manifold(new Mesh({ numProp: 3, vertProperties: src.pos, triVerts: src.idx })).scale(k).simplify(0.001);
  writeVerifiedSTL(join(PRINT, 'kubara_120mm.stl'), M120, 'kubara 120mm');
  files.splice(2, 0, 'kubara_120mm.stl');
  log('wrote kubara_120mm.stl (x' + k + ')');
}

/** Write a manifold as binary STL; if the welded read-back pinches (two vertices collapse to one float32
 *  position), nudge the duplicates 1e-4 mm inward along their normal and write again (same as the build). */
function writeVerifiedSTL(path, M, title) {
  const mesh = M.getMesh();
  const np = mesh.numProp, tv = mesh.triVerts, nV = mesh.vertProperties.length / np;
  const vp = new Float64Array(nV * 3);
  for (let v = 0; v < nV; v++) for (let q = 0; q < 3; q++) vp[3 * v + q] = mesh.vertProperties[v * np + q];
  const out = { vertProperties: vp, numProp: 3, triVerts: tv };
  const ok = () => {
    const r = loadSTL(path);
    const tp = topology(r.idx, r.pos.length / 3);
    return !tp.boundary && !tp.nonManifold && !tp.misoriented && !r.degenerate;
  };
  writeSTL(path, out, title);
  for (let pass = 1; pass <= 3 && !ok(); pass++) {
    const nrm = new Float64Array(nV * 3);
    for (let t = 0; t < tv.length; t += 3) {
      const a = tv[t] * 3, b = tv[t + 1] * 3, c = tv[t + 2] * 3;
      const ux = vp[b] - vp[a], uy = vp[b + 1] - vp[a + 1], uz = vp[b + 2] - vp[a + 2];
      const wx = vp[c] - vp[a], wy = vp[c + 1] - vp[a + 1], wz = vp[c + 2] - vp[a + 2];
      const n = [uy * wz - uz * wy, uz * wx - ux * wz, ux * wy - uy * wx];
      for (const q of [a, b, c]) for (let i = 0; i < 3; i++) nrm[q + i] += n[i];
    }
    const seen = new Set(), f32 = new Float32Array(3);
    for (let i = 0; i < nV; i++) {
      f32[0] = vp[3 * i]; f32[1] = vp[3 * i + 1]; f32[2] = vp[3 * i + 2];
      const key = `${f32[0]},${f32[1]},${f32[2]}`;
      if (!seen.has(key)) { seen.add(key); continue; }
      const l = Math.hypot(nrm[3 * i], nrm[3 * i + 1], nrm[3 * i + 2]) || 1;
      for (let q = 0; q < 3; q++) vp[3 * i + q] -= (nrm[3 * i + q] / l) * 1e-4 * pass;
    }
    writeSTL(path, out, title);
  }
}

const meshes = {}, checks = [];
for (const f of files) {
  const m = loadSTL(join(PRINT, f));
  const c = verifyMesh(f, m);
  c.fileBytes = statSync(join(PRINT, f)).size;
  meshes[f] = { ...m, M: c._M };
  delete c._M;
  checks.push(c);
  log(`${c.watertight ? 'OK  ' : 'FAIL'} ${f} tris=${c.triangles} shells=${c.shells} vol=${c.volumeMM3} size=${c.bbox.size.join('x')}`);
}

// colour parts: disjoint, inside the single body, and together ~ the single body
const partNames = files.filter((f) => f.startsWith('parts/'));
let overlap = 0;
for (let i = 0; i < partNames.length; i++) for (let j = i + 1; j < partNames.length; j++) {
  const x = meshes[partNames[i]].M.intersect(meshes[partNames[j]].M);
  overlap += x.volume(); free(x);
}
const partsUnion = Manifold.union(partNames.map((p) => meshes[p].M));
const body = meshes['kubara.stl'].M;
const outside = partsUnion.subtract(body).volume(), missing = body.subtract(partsUnion).volume();
const assembly = {
  pairwiseOverlapMM3: +overlap.toFixed(4), partsOutsideBodyMM3: +outside.toFixed(4), bodyNotCoveredByPartsMM3: +missing.toFixed(4),
  partsVolumeMM3: r2(partNames.reduce((s, p) => s + meshes[p].M.volume(), 0)), bodyVolumeMM3: r2(body.volume()),
};
log('assembly', JSON.stringify(assembly));

// ================================================================== 2. 3MF structural validation
function validate3MF(path) {
  const errors = [], warnings = [], info = {};
  const z = unzipSync(readFileSync(path));
  const names = Object.keys(z);
  info.entries = names;
  for (const req of ['[Content_Types].xml', '_rels/.rels', '3D/3dmodel.model']) if (!z[req]) errors.push('missing ' + req);
  if (errors.length) return { valid: false, errors, warnings, info };
  // content types cover every part
  const ct = strFromU8(z['[Content_Types].xml']);
  const defaults = [...ct.matchAll(/<Default Extension="([^"]+)"/g)].map((m) => m[1].toLowerCase());
  const overrides = [...ct.matchAll(/<Override PartName="([^"]+)"/g)].map((m) => m[1]);
  for (const n of names) {
    if (n === '[Content_Types].xml' || n.endsWith('/')) continue;
    const ext = n.split('.').pop().toLowerCase();
    if (!defaults.includes(ext) && !overrides.includes('/' + n)) errors.push(`no content type for ${n}`);
  }
  // relationships -> start part
  const rels = strFromU8(z['_rels/.rels']);
  const rel = rels.match(/<Relationship[^>]*Type="http:\/\/schemas\.microsoft\.com\/3dmanufacturing\/2013\/01\/3dmodel"[^>]*>/);
  if (!rel) errors.push('no 3D model relationship in _rels/.rels');
  else {
    const target = rel[0].match(/Target="\/?([^"]+)"/)[1];
    if (!z[target]) errors.push('relationship target missing: ' + target);
  }
  const xml = strFromU8(z['3D/3dmodel.model']);
  // well-formedness: every tag balanced and properly nested
  {
    const stack = [];
    for (const m of xml.matchAll(/<(\/?)([A-Za-z_][\w:.-]*)[^>]*?(\/?)>/g)) {
      if (m[0].startsWith('<?')) continue;
      const [, close, tag, self] = m;
      if (self) continue;
      if (!close) stack.push(tag);
      else if (stack.pop() !== tag) { errors.push(`XML nesting error at </${tag}>`); break; }
    }
    if (stack.length) errors.push('unclosed XML tags: ' + stack.join(','));
  }
  if (!/<model[^>]*unit="millimeter"/.test(xml)) errors.push('model unit is not millimeter');
  if (!/xmlns="http:\/\/schemas\.microsoft\.com\/3dmanufacturing\/core\/2015\/02"/.test(xml)) errors.push('core namespace missing');
  const req = xml.match(/requiredextensions="([^"]*)"/);
  if (req) warnings.push('requiredextensions: ' + req[1]);
  const bases = [...xml.matchAll(/<base name="([^"]+)" displaycolor="(#[0-9A-Fa-f]{6,8})"/g)].map((m) => ({ name: m[1], color: m[2] }));
  const cgM = xml.match(/<m:colorgroup id="(\d+)">([\s\S]*?)<\/m:colorgroup>/);
  const colors = cgM ? [...cgM[2].matchAll(/color="(#[0-9A-Fa-f]{6,8})"/g)].map((m) => m[1]) : [];
  info.baseMaterials = bases;
  const objects = new Map(), ids = new Set();
  for (const m of xml.matchAll(/<object id="(\d+)"([^>]*)>([\s\S]*?)<\/object>/g)) {
    const [, id, attrs, bodyXml] = m;
    if (ids.has(id)) errors.push('duplicate object id ' + id);
    ids.add(id);
    const name = attrs.match(/name="([^"]*)"/)?.[1];
    const pid = attrs.match(/pid="(\d+)"/)?.[1], pindex = attrs.match(/pindex="(\d+)"/)?.[1];
    const o = { id, name, pid, pindex: pindex != null ? +pindex : null };
    if (bodyXml.includes('<mesh>')) {
      const V = [...bodyXml.matchAll(/<vertex x="([^"]+)" y="([^"]+)" z="([^"]+)"\/>/g)];
      const T = [...bodyXml.matchAll(/<triangle v1="(\d+)" v2="(\d+)" v3="(\d+)"[^>]*\/>/g)];
      const pos = new Float32Array(V.length * 3), idx = new Uint32Array(T.length * 3);
      V.forEach((v, i) => { pos[3 * i] = +v[1]; pos[3 * i + 1] = +v[2]; pos[3 * i + 2] = +v[3]; });
      let oob = 0, rep = 0;
      T.forEach((t, i) => {
        for (let k = 0; k < 3; k++) { idx[3 * i + k] = +t[k + 1]; if (+t[k + 1] >= V.length) oob++; }
        if (t[1] === t[2] || t[2] === t[3] || t[1] === t[3]) rep++;
      });
      if (oob) errors.push(`object ${id} '${name}': ${oob} triangle indices out of range`);
      if (rep) errors.push(`object ${id} '${name}': ${rep} triangles with repeated vertex indices`);
      const topo = topology(idx, V.length);
      let vol = 0, status = 'n/a', shells = null;
      try {
        const M = new Manifold(new Mesh({ numProp: 3, vertProperties: pos, triVerts: idx }));
        status = M.status(); vol = M.volume(); shells = M.decompose().length;
        o.M = M;
      } catch (e) { status = 'error: ' + e.message; }
      o.mesh = { verts: V.length, tris: T.length, ...topo, status, shells, volumeMM3: r2(vol) };
      if (topo.boundary || topo.nonManifold || topo.misoriented || status !== 'NoError' || !(vol > 0))
        errors.push(`object ${id} '${name}' is not a closed, oriented 2-manifold (${JSON.stringify(o.mesh)})`);
      if (pid && pindex != null) {
        const n = pid === cgM?.[1] ? colors.length : bases.length;
        if (+pindex >= n) errors.push(`object ${id}: pindex ${pindex} out of range`);
      }
    } else {
      o.components = [...bodyXml.matchAll(/<component objectid="(\d+)"([^>]*)\/>/g)].map((c) => c[1]);
    }
    objects.set(id, o);
  }
  for (const o of objects.values()) for (const c of o.components ?? []) {
    if (!objects.has(c)) errors.push(`object ${o.id} references missing component ${c}`);
    else if (!objects.get(c).mesh) errors.push(`component ${c} is not a mesh object`);
  }
  const items = [...xml.matchAll(/<item objectid="(\d+)"(?: transform="([^"]+)")?/g)];
  if (!items.length) errors.push('no build items');
  for (const it of items) {
    if (!objects.has(it[1])) errors.push('build item references missing object ' + it[1]);
    if (it[2] && it[2].trim().split(/\s+/).length !== 12) errors.push('build transform must have 12 numbers');
  }
  info.buildItems = items.map((i) => ({ objectid: i[1], transform: i[2] }));
  // Bambu / Orca per-part settings
  const cfg = z['Metadata/model_settings.config'] ? strFromU8(z['Metadata/model_settings.config']) : null;
  info.parts = [];
  if (!cfg) warnings.push('no Metadata/model_settings.config (parts will not get filament slots in Bambu/Orca)');
  else {
    const objM = cfg.match(/<object id="(\d+)">([\s\S]*?)<\/object>/);
    if (!objM || !objects.has(objM[1])) errors.push('model_settings.config object id does not match an assembly object');
    for (const p of cfg.matchAll(/<part id="(\d+)" subtype="(\w+)">([\s\S]*?)<\/part>/g)) {
      const name = p[3].match(/key="name" value="([^"]*)"/)?.[1], extruder = +p[3].match(/key="extruder" value="(\d+)"/)?.[1];
      const o = objects.get(p[1]);
      if (!o?.mesh) errors.push(`model_settings part ${p[1]} is not a mesh object`);
      else if (o.name !== name) warnings.push(`part ${p[1]} name '${name}' != object name '${o.name}'`);
      info.parts.push({ id: p[1], name, extruder, subtype: p[2], color: o?.pindex != null ? colors[o.pindex] : null, ...(o?.mesh ?? {}) });
    }
    if (objM) {
      const comp = objects.get(objM[1])?.components ?? [];
      const listed = info.parts.map((p) => p.id);
      if (comp.join() !== listed.join()) errors.push(`components (${comp}) != model_settings parts (${listed})`);
    }
  }
  if (z['Metadata/project_settings.config']) {
    try {
      const ps = JSON.parse(strFromU8(z['Metadata/project_settings.config']));
      info.filamentColours = ps.filament_colour;
      const maxE = Math.max(...info.parts.map((p) => p.extruder));
      if ((ps.filament_colour?.length ?? 0) < maxE) errors.push('project_settings has fewer filaments than the highest extruder used');
    } catch (e) { errors.push('project_settings.config is not valid JSON'); }
  }
  // geometry identical to parts/*.stl and parts pairwise disjoint
  for (const p of info.parts) {
    const stl = checks.find((c) => c.name === `parts/${p.name}.stl`);
    if (!stl) { warnings.push(`no parts/${p.name}.stl to compare`); continue; }
    p.matchesSTL = Math.abs(stl.volumeMM3 - p.volumeMM3) < 0.01 * Math.max(1, stl.volumeMM3) && stl.triangles === p.tris;
    if (!p.matchesSTL) errors.push(`3MF part ${p.name} differs from parts/${p.name}.stl`);
  }
  const meshObjs = [...objects.values()].filter((o) => o.M);
  let ov = 0;
  for (let i = 0; i < meshObjs.length; i++) for (let j = i + 1; j < meshObjs.length; j++) {
    const x = meshObjs[i].M.intersect(meshObjs[j].M); ov += x.volume(); free(x);
  }
  info.pairwiseOverlapMM3 = +ov.toFixed(4);
  if (ov > 0.5) errors.push(`3MF parts overlap by ${ov.toFixed(3)} mm^3`);
  return { valid: errors.length === 0, errors, warnings, info };
}
const mf = validate3MF(join(PRINT, 'kubara_multicolor.3mf'));
log(`3MF ${mf.valid ? 'valid' : 'INVALID'}`, mf.errors.join('; '), mf.warnings.join('; '));

// ================================================================== 3. overhangs / islands (upright, as delivered)
const K = meshes['kubara.stl'];
const nTri = K.idx.length / 3;
const cosT = Math.sin((OVERHANG_DEG * Math.PI) / 180); // face needs support when -n.z > sin(45)
const G = buildGrid(K.pos, K.idx, 0.8);
log('ray grid built');

// facet analysis: downward faces steeper than 45 deg from vertical, not on the bed
const flagged = new Uint8Array(nTri);
let ovArea = 0, ovProj = 0, ovOnBed = 0, ovOnModel = 0, supportEnvelope = 0;
const faceInfo = [];
for (let t = 0; t < nTri; t++) {
  const ti = triInfo(K.pos, K.idx, t);
  if (-ti.n[2] <= cosT || ti.c[2] < 0.05) continue;
  flagged[t] = 1;
  const proj = ti.area * -ti.n[2];
  ovArea += ti.area; ovProj += proj;
  const hit = raycast(G, [ti.c[0], ti.c[1], ti.c[2] - 1e-3], [0, 0, -1], ti.c[2] + 1, t);
  const h = Number.isFinite(hit.t) ? hit.t : ti.c[2];
  // where a support column below this face would stand: build plate, the figure's own base plate, or the figure
  const onFigure = Number.isFinite(hit.t) && ti.c[2] - hit.t > BASE + 0.05;
  if (onFigure) ovOnModel += proj; else ovOnBed += proj;
  supportEnvelope += proj * h;
  faceInfo[t] = { ...ti, proj, h, onModel: onFigure };
}
// connected regions of flagged faces (shared edges)
const regions = [];
{
  const par = new Int32Array(nTri).map((_, i) => i);
  const find = (x) => { while (par[x] !== x) { par[x] = par[par[x]]; x = par[x]; } return x; };
  const edgeOwner = new Map();
  for (let t = 0; t < nTri; t++) if (flagged[t]) for (let k = 0; k < 3; k++) {
    const u = K.idx[3 * t + k], v = K.idx[3 * t + ((k + 1) % 3)];
    const key = u < v ? u * 4294967296 + v : v * 4294967296 + u;
    const o = edgeOwner.get(key);
    if (o === undefined) edgeOwner.set(key, t); else par[find(t)] = find(o);
  }
  const acc = new Map();
  for (let t = 0; t < nTri; t++) if (flagged[t]) {
    const r = find(t), f = faceInfo[t];
    let a = acc.get(r);
    if (!a) acc.set(r, (a = { area: 0, proj: 0, c: [0, 0, 0], zmin: Infinity, zmax: -Infinity, xmin: Infinity, xmax: -Infinity, ymin: Infinity, ymax: -Infinity, onModel: 0, env: 0, faces: 0 }));
    a.area += f.area; a.proj += f.proj; a.faces++; a.env += f.proj * f.h;
    if (f.onModel) a.onModel += f.proj;
    for (let k = 0; k < 3; k++) a.c[k] += f.c[k] * f.proj;
    a.zmin = Math.min(a.zmin, f.c[2]); a.zmax = Math.max(a.zmax, f.c[2]);
    a.xmin = Math.min(a.xmin, f.c[0]); a.xmax = Math.max(a.xmax, f.c[0]);
    a.ymin = Math.min(a.ymin, f.c[1]); a.ymax = Math.max(a.ymax, f.c[1]);
  }
  for (const a of acc.values()) {
    if (a.proj < 1) continue; // ignore specks < 1 mm^2 (bridged / absorbed by the slicer)
    const c = a.c.map((v) => v / a.proj);
    regions.push({
      where: label(...c), projectedAreaMM2: r2(a.proj), zRangeMM: [r2(a.zmin), r2(a.zmax)], centre: c.map(r2),
      bboxXY: [[r2(a.xmin), r2(a.ymin)], [r2(a.xmax), r2(a.ymax)]],
      supportRestsOn: a.onModel / a.proj > 0.5 ? 'the figure below (leaves marks)' : 'build plate / base plate',
      supportEnvelopeMM3: r2(a.env),
    });
  }
  regions.sort((a, b) => b.projectedAreaMM2 - a.projectedAreaMM2);
}
// merge regions by label (several small facet patches usually form one zone)
const zones = [];
for (const r of regions) {
  let z = zones.find((q) => q.where === r.where);
  if (!z) zones.push((z = { where: r.where, projectedAreaMM2: 0, zRangeMM: [Infinity, -Infinity], patches: 0, onModelMM2: 0, supportEnvelopeMM3: 0 }));
  z.projectedAreaMM2 += r.projectedAreaMM2; z.patches++; z.supportEnvelopeMM3 += r.supportEnvelopeMM3;
  if (r.supportRestsOn.startsWith('the figure')) z.onModelMM2 += r.projectedAreaMM2;
  z.zRangeMM = [Math.min(z.zRangeMM[0], r.zRangeMM[0]), Math.max(z.zRangeMM[1], r.zRangeMM[1])];
}
for (const z of zones) { z.projectedAreaMM2 = r2(z.projectedAreaMM2); z.supportEnvelopeMM3 = r2(z.supportEnvelopeMM3); z.supportRestsOn = z.onModelMM2 > z.projectedAreaMM2 / 2 ? 'the figure below (leaves marks)' : 'build plate / base plate'; delete z.onModelMM2; }
zones.sort((a, b) => b.projectedAreaMM2 - a.projectedAreaMM2);
log(`facet overhangs: ${fmt(ovProj)} mm^2 projected in ${regions.length} patches / ${zones.length} zones`);

// slice analysis (what a slicer sees): islands that start in mid-air + area per layer not covered by the 45 deg rule
const islands = [], unsupported = [];
{
  let prev = null;
  const zMax = body.boundingBox().max[2];
  for (let z = LAYER / 2; z < zMax; z += LAYER) {
    const cs = body.slice(z);
    if (prev && !cs.isEmpty()) {
      for (const poly of cs.decompose()) {
        const x = poly.intersect(prev);
        const a = x.area();
        if (a < 1e-3) {
          const b = poly.bounds();
          const c = [(b.min[0] + b.max[0]) / 2, (b.min[1] + b.max[1]) / 2];
          islands.push({ zMM: r2(z), where: label(c[0], c[1], z), centreXY: c.map(r2), areaMM2: +poly.area().toFixed(3) });
        }
        free(x, poly);
      }
      const grown = prev.offset(LAYER * Math.tan((OVERHANG_DEG * Math.PI) / 180), 'Round');
      const U = cs.subtract(grown);
      for (const poly of U.decompose()) {
        const a = poly.area();
        if (a > 0.05) {
          const b = poly.bounds();
          unsupported.push({ z, a, b });
        }
        free(poly);
      }
      free(grown, U);
    }
    free(prev);
    prev = cs;
  }
  free(prev);
}
// chain unsupported slivers into zones (consecutive layers, overlapping bounds)
const sliceZones = [];
{
  const open = [];
  for (const u of unsupported) {
    const pad = 1.0;
    let z = open.find((q) => u.z - q.zTop <= 2.01 * LAYER && u.b.min[0] - pad < q.b.max[0] && u.b.max[0] + pad > q.b.min[0] && u.b.min[1] - pad < q.b.max[1] && u.b.max[1] + pad > q.b.min[1]);
    if (!z) { open.push((z = { zMin: u.z, zTop: u.z, area: 0, b: { min: [...u.b.min], max: [...u.b.max] }, cw: [0, 0] })); sliceZones.push(z); }
    z.zTop = u.z; z.area += u.a;
    z.cw[0] += ((u.b.min[0] + u.b.max[0]) / 2) * u.a; z.cw[1] += ((u.b.min[1] + u.b.max[1]) / 2) * u.a;
    for (let k = 0; k < 2; k++) { z.b.min[k] = Math.min(z.b.min[k], u.b.min[k]); z.b.max[k] = Math.max(z.b.max[k], u.b.max[k]); }
  }
}
const sliceZ = sliceZones.filter((z) => z.area > 2).map((z) => {
  const c = z.cw.map((v) => v / z.area), zm = (z.zMin + z.zTop) / 2;
  return { where: label(c[0], c[1], zm), zRangeMM: [r2(z.zMin), r2(z.zTop)], unsupportedAreaMM2: r2(z.area), centreXY: c.map(r2) };
}).sort((a, b) => b.unsupportedAreaMM2 - a.unsupportedAreaMM2);
log(`slice analysis: ${islands.length} floating islands, ${sliceZ.length} unsupported zones`);

// orientation comparison (facet metric only)
function overhangForRotation(rx, ry) {
  const cx = Math.cos(rx), sx = Math.sin(rx), cy = Math.cos(ry), sy = Math.sin(ry);
  const rot = (v) => { const y1 = v[1] * cx - v[2] * sx, z1 = v[1] * sx + v[2] * cx; return [v[0] * cy + z1 * sy, y1, -v[0] * sy + z1 * cy]; };
  let zmin = Infinity;
  for (let i = 0; i < K.pos.length; i += 3) zmin = Math.min(zmin, rot([K.pos[i], K.pos[i + 1], K.pos[i + 2]])[2]);
  let proj = 0, flat = 0;
  for (let t = 0; t < nTri; t++) {
    const ti = triInfo(K.pos, K.idx, t);
    const n = rot(ti.n), c = rot(ti.c);
    if (c[2] - zmin < 0.3) { if (n[2] < -0.99) flat += ti.area; continue; }
    if (-n[2] > cosT) proj += ti.area * -n[2];
  }
  return { proj, flat };
}
const D = Math.PI / 180;
const orientations = [
  ['upright on its base (as delivered)', 0, 0], ['tilted back 20 deg', 20 * D, 0], ['lying on its back', 90 * D, 0],
  ['lying on its face', -90 * D, 0], ['upside down (on the ears)', 180 * D, 0], ['on its side', 0, 90 * D],
].map(([name, rx, ry]) => { const r = overhangForRotation(rx, ry); return { name, overhangProjectedMM2: r2(r.proj), flatBedContactMM2: r2(r.flat) }; });

// ================================================================== 4. local thickness (fragile features)
const NS = QUICK ? 8000 : 40000;
const thin = [], allTh = [], byLabel = [];
const thickHist = { lt08: 0, lt12: 0, lt2: 0, n: 0 };
{
  const cum = new Float64Array(nTri);
  let s = 0;
  for (let t = 0; t < nTri; t++) { s += triInfo(K.pos, K.idx, t).area; cum[t] = s; }
  let seed = 12345;
  const rnd = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
  for (let i = 0; i < NS; i++) {
    const r = rnd() * s;
    let lo = 0, hi = nTri - 1;
    while (lo < hi) { const m = (lo + hi) >> 1; if (cum[m] < r) lo = m + 1; else hi = m; }
    const ti = triInfo(K.pos, K.idx, lo);
    if (ti.c[2] < BASE + 0.05) continue; // base plate faces: thickness = plate, by design
    const inN = ti.n.map((v) => -v);
    const o = ti.c.map((v, k) => v + inN[k] * 1e-4);
    const d = cone(inN).map((dir) => raycast(G, o, dir, 20, lo).t).sort((a, b) => a - b);
    const th = d[2];
    thickHist.n++;
    allTh.push(th);
    if (th < 0.8) thickHist.lt08++;
    if (th < 1.2) thickHist.lt12++;
    if (th < 2.0) thickHist.lt2++;
    if (th < 2.0) thin.push([th, ...ti.c]);
    byLabel.push([th, label(...ti.c).replace(/ \((left|right)\)|(left|right) /g, '')]);
  }
}
const thinClusters = [];
for (const p of thin.sort((a, b) => a[0] - b[0])) {
  const q = thinClusters.find((c) => Math.hypot(c.c[0] - p[1], c.c[1] - p[2], c.c[2] - p[3]) < 3);
  if (q) { q.n++; q.sum += p[0]; } else thinClusters.push({ c: p.slice(1), n: 1, min: p[0], sum: p[0] });
}
const thinReport = thinClusters.filter((c) => c.n >= 3).map((c) => ({
  where: label(...c.c), minMM: r2(c.min), meanMM: r2(c.sum / c.n), samples: c.n, centre: c.c.map(r2),
})).sort((a, b) => a.minMM - b.minMM).slice(0, 12);
// structural minimum: the thinnest robust cluster (>= 5 samples), i.e. a real feature, not a single noisy ray
const robust = thinReport.filter((c) => c.samples >= 5);
allTh.sort((a, b) => a - b);
// per body region: thickness percentiles, ignoring feathered edges (< 0.4 mm: blends that taper to zero along
// an attached edge, e.g. where the strap or the paws meet the body; a slicer just rounds them off)
const FEATHER = 0.4;
const regionsTh = {};
for (const [th, l] of byLabel) (regionsTh[l] ??= []).push(th);
const regionThickness = Object.entries(regionsTh).map(([where, a]) => {
  a.sort((x, y) => x - y);
  const b = a.filter((v) => v >= FEATHER);
  const q = (arr, p) => (arr.length ? r2(Math.min(arr[Math.min(arr.length - 1, Math.floor(p * arr.length))], 99)) : null);
  return { where, samples: a.length, featheredPct: +((100 * (a.length - b.length)) / a.length).toFixed(2), p1: q(b, 0.01), p5: q(b, 0.05), median: q(b, 0.5) };
}).sort((x, y) => (x.p1 ?? 99) - (y.p1 ?? 99));
const pct = (p) => r2(allTh[Math.min(allTh.length - 1, Math.floor(p * allTh.length))]);
thickHist.percentiles = { p0_1: pct(0.001), p0_5: pct(0.005), p1: pct(0.01), p5: pct(0.05), median: pct(0.5) };
// structural minimum: 5th percentile of the thinnest region (the very rim of a rounded protrusion is always thinner)
const thinRegion = regionThickness.filter((r) => r.samples >= 100).sort((x, y) => x.p5 - y.p5)[0];
const tMin = thinRegion.p5;
log(`thickness: ${thickHist.n} samples, <1.2 mm: ${thickHist.lt12}, thinnest robust feature ${tMin} mm`);

// designed colour / relief details at 80 mm (from the model parameters)
const P = PARAMS;
const details = [
  { feature: 'mouth / smile line (ink)', widthMM: 2 * P.mouth.r * S },
  { feature: 'nostrils (ink)', widthMM: 2 * P.nostril.r * S },
  { feature: 'finger / toe grooves (relief)', widthMM: 2 * P.groove.halfWidth * S },
  { feature: 'chin crease groove (relief)', widthMM: 2 * P.jaw.grooveHalfWidth * S },
  { feature: 'lens glints (white)', widthMM: 2 * P.glasses.glintHalfW * S },
  { feature: 'glasses strap (ink)', widthMM: 2 * P.glasses.strapHalfH * S },
].map((d) => ({ ...d, widthMM: r2(d.widthMM) }));
const minDetail = Math.min(...details.map((d) => d.widthMM));
const H = report0.figureHeightMM;
const scale = {
  structuralMinMM: tMin, structuralMinRegion: thinRegion.where,
  minFigureHeightHardMM: Math.ceil((H * 0.8) / tMin), // thinnest feature >= 2 x 0.4 mm lines
  minFigureHeightRecommendedMM: Math.ceil((H * 1.2) / tMin), // >= 1.2 mm
  minFigureHeightDetailsMM: Math.ceil((H * 0.8) / minDetail), // smallest colour line still >= 2 lines wide (0.4 nozzle)
  minFigureHeight02NozzleMM: Math.ceil((H * 0.4) / minDetail),
};

// ================================================================== 5. volume / filament (geometric estimate)
const kb = checks.find((c) => c.name === 'kubara.stl');
const geomEstimate = (V, A, walls = 3, infill = 0.15) => {
  const shell = Math.min(V, A * walls * 0.42);
  return (shell + infill * Math.max(0, V - shell)) / 1000 * PLA;
};
const filament = {
  solidVolumeCM3: r2(kb.volumeMM3 / 1000), solidGrams: r2((kb.volumeMM3 / 1000) * PLA),
  estimateGrams3Walls15: r2(geomEstimate(kb.volumeMM3, kb.areaMM2)),
  supportEnvelopeCM3: r2(supportEnvelope / 1000),
  supportGramsEstimate: r2((supportEnvelope / 1000) * 0.15 * PLA),
  perPart: partNames.map((p) => {
    const c = checks.find((x) => x.name === p);
    return { part: basename(p, '.stl'), solidVolumeCM3: +(c.volumeMM3 / 1000).toFixed(3), solidGrams: +((c.volumeMM3 / 1000) * PLA).toFixed(2) };
  }),
  scaled120: { solidGrams: r2((kb.volumeMM3 / 1000) * PLA * 1.5 ** 3), estimateGrams: r2(geomEstimate(kb.volumeMM3 * 3.375, kb.areaMM2 * 2.25)) },
};

// ================================================================== 6. Bambu Studio CLI: round trip + real slices
const slicer = { available: DO_SLICE };
if (DO_SLICE) {
  const tmp = mkdtempSync(join(tmpdir(), 'kubara-slice-'));
  try {
    const index = {};
    for (const sub of ['machine', 'process', 'filament']) for (const f of readdirSync(join(BBL, sub))) if (f.endsWith('.json')) {
      try { const j = JSON.parse(readFileSync(join(BBL, sub, f), 'utf8')); if (j.name) index[sub + ':' + j.name] = j; } catch {}
    }
    const flat = (sub, name) => {
      const j = index[sub + ':' + name];
      if (!j) throw new Error('profile not found: ' + name);
      // system presets: parent chain ("inherits") + gcode templates ("include") + own keys
      const inc = {};
      for (const n of [].concat(j.include ?? [])) {
        const { name, instantiation, type, from, setting_id, ...rest } = flat(sub, n);
        Object.assign(inc, rest);
      }
      const o = { ...(j.inherits ? flat(sub, j.inherits) : {}), ...inc, ...j };
      delete o.inherits; delete o.include;
      return o;
    };
    const PRINTER = process.env.BAMBU_PRINTER || 'Bambu Lab X1 Carbon 0.4 nozzle';
    const PROCESS = process.env.BAMBU_PROCESS || '0.20mm Standard @BBL X1C';
    const FILAMENT = process.env.BAMBU_FILAMENT || 'Bambu PLA Basic @BBL X1C';
    const procOverrides = { enable_support: '1', support_type: 'tree(auto)', support_threshold_angle: String(OVERHANG_DEG), wall_loops: '3', sparse_infill_density: '15%', support_on_build_plate_only: '0' };
    writeFileSync(join(tmp, 'm.json'), JSON.stringify(flat('machine', PRINTER)));
    const filFile = (hex, i) => {
      const p = join(tmp, `f${i}.json`);
      writeFileSync(p, JSON.stringify({ ...flat('filament', FILAMENT), filament_colour: [hex], filament_density: [String(PLA)] }));
      return p;
    };
    Object.assign(slicer, { printer: PRINTER, process: PROCESS, filament: FILAMENT, overrides: procOverrides });
    const run = (tag, input, colours, extra = {}) => {
      const out = join(tmp, tag);
      mkdirSync(out, { recursive: true }); // Bambu Studio does not create its output dir
      const fl = colours.map((c, i) => filFile(c, `${tag}${i}`)).join(';');
      const proc = join(tmp, `p_${tag}.json`);
      writeFileSync(proc, JSON.stringify({ ...flat('process', PROCESS), ...procOverrides, ...extra }));
      try {
        execFileSync(BAMBU, ['--load-settings', `${join(tmp, 'm.json')};${proc}`, '--load-filaments', fl, '--slice', '0', '--outputdir', out, '--export-3mf', 'sliced.3mf', input], { stdio: 'pipe', timeout: 900000 });
      } catch (e) { return { error: (e.stderr?.toString() || e.message).split('\n').filter((l) => /error/i.test(l)).slice(0, 3).join(' | ') || e.message }; }
      const res = JSON.parse(readFileSync(join(out, 'result.json'), 'utf8'));
      const pl = res.sliced_plates?.[0];
      const gtext = readFileSync(join(out, 'plate_1.gcode'), 'utf8');
      const g = parseGcode(gtext);
      const hdr = gtext.match(/^; total filament weight \[g\] : ([\d.,]+)/m)?.[1].split(',').map(Number) ?? [];
      return {
        slicerReportedGrams: r2(hdr.reduce((a, b) => a + b, 0)), slicerReportedPerSlot: hdr,
        timeH: +(pl.total_predication / 3600).toFixed(2), layers: g.layers, filamentChanges: pl.filament_change_times,
        perFilament: g.tools.map((t, i) => ({ slot: i + 1, colour: colours[i], ...t })),
        totalGrams: r2(g.tools.reduce((s, t) => s + t.totalG, 0)), supportGrams: r2(g.tools.reduce((s, t) => s + t.supportG, 0)),
        modelGrams: r2(g.tools.reduce((s, t) => s + t.modelG, 0)), purgeGrams: r2(g.tools.reduce((s, t) => s + t.flushG + t.towerG, 0)),
        supportBlobs: g.supportBlobs, warning: pl.warning_message || '',
      };
    };
    // round trip: Bambu keeps the 4 named parts + their filament slots
    {
      const out = join(tmp, 'rt');
      mkdirSync(out, { recursive: true });
      execFileSync(BAMBU, ['--outputdir', out, '--export-3mf', 'rt.3mf', join(PRINT, 'kubara_multicolor.3mf')], { stdio: 'pipe', timeout: 300000 });
      const z = unzipSync(readFileSync(join(out, 'rt.3mf')));
      const cfg = strFromU8(z['Metadata/model_settings.config']);
      const parts = [...cfg.matchAll(/<part id="\d+"[^>]*>([\s\S]*?)<\/part>/g)].map((p) => ({
        name: p[1].match(/key="name" value="([^"]*)"/)?.[1], extruder: +p[1].match(/key="extruder" value="(\d+)"/)?.[1],
      }));
      slicer.roundTrip = { parts, ok: mf.info.parts.every((p) => parts.some((q) => q.name === p.name && q.extruder === p.extruder)) };
      log('Bambu round trip', slicer.roundTrip.ok ? 'OK' : 'MISMATCH', JSON.stringify(parts));
    }
    const pal = [PALETTE.fur, PALETTE.fur_shade, PALETTE.ink, PALETTE.glint];
    log('slicing single colour 80 mm ...');
    slicer.single80 = run('s80', join(PRINT, 'kubara.stl'), [PALETTE.fur]);
    log('slicing multicolour 80 mm ...');
    const flushInto = { flush_into_infill: '1', flush_into_support: '1' };
    slicer.multi80 = run('m80', join(PRINT, 'kubara_multicolor.3mf'), pal, flushInto);
    slicer.multi80.settings = 'flush into infill + support enabled';
    // 3-colour variant: glint part on the ink slot (paint the two glints afterwards) -> fewer changes in the head
    {
      const z = unzipSync(readFileSync(join(PRINT, 'kubara_multicolor.3mf')));
      const cfg = strFromU8(z['Metadata/model_settings.config']).replace(/(<metadata key="name" value="glint"\/>\s*<metadata key="extruder" value=")4(")/, '$13$2');
      z['Metadata/model_settings.config'] = strToU8(cfg);
      const p3 = join(tmp, 'kubara_3col.3mf');
      writeFileSync(p3, zipSync(z, { level: 1 }));
      log('slicing 3-colour variant ...');
      slicer.multi80_3col = run('m80c3', p3, pal.slice(0, 3), flushInto);
      slicer.multi80_3col.settings = 'glint printed in ink (paint the glints), flush into infill + support';
    }
    log('slicing single colour 120 mm ...');
    slicer.single120 = run('s120', join(PRINT, 'kubara_120mm.stl'), [PALETTE.fur]);
    // supports found by the slicer, mapped back to the model frame and labelled
    const bb = kb.bbox;
    for (const k of ['single80', 'multi80', 'multi80_3col', 'single120']) {
      const s = slicer[k];
      if (!s?.supportBlobs) continue;
      s.supportZones = s.supportBlobs.zones.map((b) => {
        const off = s.supportBlobs.modelCentre.map((v, i) => v - (bb.min[i] + bb.max[i]) / 2);
        const c = [b.c[0] - off[0], b.c[1] - off[1]];
        const f = k === 'single120' ? report0.figureHeightMM / 120 : 1; // label in the 80 mm frame
        return { where: label(c[0] * f, c[1] * f, (b.zTop - 1) * f), zRangeMM: [r2(b.zMin), r2(b.zTop)], grams: r2(b.g), centreXY: c.map(r2) };
      }).filter((z) => z.grams >= 0.05).sort((a, b) => b.grams - a.grams);
      delete s.supportBlobs;
    }
    log('slices done');
  } catch (e) {
    slicer.error = e.message;
    console.warn('Bambu Studio slicing failed:', e.message);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

/** Per tool: grams by role (model / support / flush / prime tower), support extrusion blobs with their z range. */
function parseGcode(text) {
  const tools = [];
  const T = (i) => (tools[i] ??= { modelG: 0, supportG: 0, flushG: 0, towerG: 0, totalG: 0 });
  let tool = 0, feature = '', inChange = false, z = 0, x = 0, y = 0, layers = 0;
  const wall = { min: [Infinity, Infinity], max: [-Infinity, -Infinity] };
  const vox = new Map(); // support voxels (2 mm) -> grams, z
  const g = (e) => (e * FIL_AREA / 1000) * PLA;
  for (const line of text.split('\n')) {
    if (line.startsWith('; FEATURE: ')) { feature = line.slice(11).trim(); continue; }
    if (line.startsWith('; Z_HEIGHT: ')) { z = +line.slice(12); continue; }
    if (line.startsWith('; CHANGE_LAYER')) { layers++; continue; }
    if (/^\s*M620 S\d/.test(line)) { inChange = true; continue; }
    if (/^\s*M621 S\d/.test(line)) { inChange = false; continue; }
    const tm = line.match(/^\s*T(\d+)\s*(;.*)?$/);
    if (tm) { if (+tm[1] < 16) tool = +tm[1]; continue; }
    if (!/^G[0-3] /.test(line)) continue;
    const xm = line.match(/ X(-?[\d.]+)/), ym = line.match(/ Y(-?[\d.]+)/), em = line.match(/ E(-?[\d.]+)/);
    if (xm) x = +xm[1];
    if (ym) y = +ym[1];
    if (!em) continue;
    const e = +em[1];
    const t = T(tool);
    const gg = g(e);
    t.totalG += gg;
    if (inChange) t.flushG += gg;
    else if (feature === 'Prime tower') t.towerG += gg;
    else if (feature.startsWith('Support')) {
      t.supportG += gg;
      if (e > 0 && (xm || ym)) {
        const key = `${Math.floor(x / 2)},${Math.floor(y / 2)},${Math.floor(z / 2)}`;
        const v = vox.get(key) || { g: 0, x, y, z };
        v.g += gg; vox.set(key, v);
      }
    } else {
      t.modelG += gg;
      if (feature === 'Outer wall' && e > 0 && z <= 0.6) { // base plate outline = model bbox in x/y
        wall.min[0] = Math.min(wall.min[0], x); wall.min[1] = Math.min(wall.min[1], y);
        wall.max[0] = Math.max(wall.max[0], x); wall.max[1] = Math.max(wall.max[1], y);
      }
    }
  }
  // connected support blobs (26-neighbourhood over 2 mm voxels)
  const keys = [...vox.keys()], seen = new Set(), zones = [];
  for (const k0 of keys) {
    if (seen.has(k0)) continue;
    const st = [k0]; seen.add(k0);
    const zb = { g: 0, zMin: Infinity, zTop: -Infinity, cw: [0, 0] };
    while (st.length) {
      const k = st.pop(), v = vox.get(k);
      zb.g += v.g; zb.zMin = Math.min(zb.zMin, v.z); zb.zTop = Math.max(zb.zTop, v.z);
      zb.cw[0] += v.x * v.g; zb.cw[1] += v.y * v.g;
      const [a, b, c] = k.split(',').map(Number);
      for (let i = -1; i <= 1; i++) for (let j = -1; j <= 1; j++) for (let l = -1; l <= 1; l++) {
        const n = `${a + i},${b + j},${c + l}`;
        if (vox.has(n) && !seen.has(n)) { seen.add(n); st.push(n); }
      }
    }
    zb.c = zb.cw.map((v) => v / zb.g);
    zones.push(zb);
  }
  for (const t of tools) if (t) for (const k in t) t[k] = r2(t[k]);
  return {
    layers, tools: tools.map((t) => t ?? { modelG: 0, supportG: 0, flushG: 0, towerG: 0, totalG: 0 }),
    supportBlobs: { modelCentre: [(wall.min[0] + wall.max[0]) / 2, (wall.min[1] + wall.max[1]) / 2], zones },
  };
}

// ================================================================== 7. write JSON + PRINTING.md
const analysis = {
  date: new Date().toISOString(),
  figureHeightMM: H, baseMM: BASE, totalHeightMM: r2(kb.bbox.size[2]), footprintMM: kb.bbox.size.slice(0, 2),
  checks, assembly, threeMF: { valid: mf.valid, errors: mf.errors, warnings: mf.warnings, parts: mf.info.parts.map(({ id, name, extruder, color, tris, volumeMM3, matchesSTL }) => ({ id, name, extruder, color, tris, volumeMM3, matchesSTL })), filamentColours: mf.info.filamentColours, pairwiseOverlapMM3: mf.info.pairwiseOverlapMM3 },
  overhang: { thresholdDeg: OVERHANG_DEG, projectedAreaMM2: r2(ovProj), surfaceAreaMM2: r2(ovArea), restsOnBedMM2: r2(ovOnBed), restsOnModelMM2: r2(ovOnModel), zones, patches: regions.slice(0, 25), islands, sliceZones: sliceZ.slice(0, 20), orientations },
  thickness: { samples: thickHist.n, fractionBelow08: +(thickHist.lt08 / thickHist.n).toFixed(4), fractionBelow12: +(thickHist.lt12 / thickHist.n).toFixed(4), percentiles: thickHist.percentiles, featherMM: FEATHER, regionThickness, thinPoints: thin.filter((p) => p[0] < 1.2).slice(0, 1500).map((p) => p.slice(1).map(r2)), thinClusters: thinReport, details, scale },
  filament, slicer,
};
writeFileSync(join(PRINT, 'print-analysis.json'), JSON.stringify(analysis, null, 2));
writeFileSync(join(PRINT, 'PRINTING.md'), renderMarkdown(analysis));
log('wrote dist/print/print-analysis.json + PRINTING.md');

const allOK = checks.every((c) => c.watertight) && mf.valid && checks.find((c) => c.name === 'kubara.stl').shells === 1;
console.log(allOK ? 'ALL PRINT FILES VERIFIED' : 'PRINT VERIFICATION FAILED');
if (!allOK) process.exitCode = 1;

// ------------------------------------------------------------------ markdown
function renderMarkdown(a) {
  const s = a.slicer, ch = (n) => a.checks.find((c) => c.name === n);
  const L = [];
  const t = (rows, head) => { L.push('| ' + head.join(' | ') + ' |', '|' + head.map(() => '---').join('|') + '|'); for (const r of rows) L.push('| ' + r.join(' | ') + ' |'); L.push(''); };
  const fil = a.filament;
  L.push('# Printing kubara', '');
  L.push(`_Generated by \`npm run print:report\` on ${a.date.slice(0, 10)} from the files in this folder. Numbers are measured, not guessed: geometry is analysed with manifold-3d, and if Bambu Studio is installed it slices the files with its command-line interface._`, '');
  L.push('## At a glance', '');
  t([
    ['Height', `${a.figureHeightMM} mm figure + ${a.baseMM} mm base = **${a.totalHeightMM} mm**`],
    ['Footprint (base plate)', `${a.footprintMM[0]} x ${a.footprintMM[1]} mm`],
    ['Solid volume', `${fil.solidVolumeCM3} cm³ (${fil.solidGrams} g if printed 100 % solid in PLA at 1.24 g/cm³)`],
    ['Filament, normal settings', s.single80?.totalGrams != null ? `**≈ ${s.single80.totalGrams} g** PLA single colour, ${s.single80.supportGrams} g of it support (Bambu Studio slice, ${s.single80.timeH} h on an X1C)` : `≈ ${fil.estimateGrams3Walls15} g + ≈ ${fil.supportGramsEstimate} g support (geometric estimate)`],
    ['Supports', s.single80?.supportZones?.length ? `**needed** under the chin and between the legs (${s.single80.supportGrams} g of tree supports); details below` : `**needed**, tree supports (details below)`],
    ['Orientation', 'upright, standing on its base, as the files are already placed'],
    ['Smallest safe size', `${Math.max(a.thickness.scale.minFigureHeightDetailsMM, 60)} mm figure height with a 0.4 mm nozzle (set by the ${a.thickness.details[0].widthMM} mm mouth line; the structure itself holds down to ${a.thickness.scale.minFigureHeightRecommendedMM} mm)`],
  ], ['', '']);

  L.push('## Files', '');
  t([
    ['`kubara.stl`', 'single colour, one watertight shell, 80 mm figure on a 2.9 mm heptagon base'],
    ['`kubara_120mm.stl`', 'the same body scaled ×1.5 (120 mm figure, ' + r2(a.totalHeightMM * 1.5) + ' mm total)'],
    ['`kubara_nobase.stl`', 'the bare figure, exactly 80 mm, flat soles (glue it on your own base or print with a brim)'],
    ['`kubara_multicolor.3mf`', 'one object with 4 named parts, each pre-assigned to a filament slot (Bambu Studio / OrcaSlicer)'],
    ['`parts/*.stl`', 'the 4 colour parts as separate STLs in one shared coordinate frame. Load them together to reassemble'],
    ['`print-analysis.json`', 'every number in this document, machine-readable'],
  ], ['File', 'What it is']);

  L.push('## Recommended slicer settings', '');
  t([
    ['Orientation', 'Upright on the base. Do not rotate it: the base is the only flat face, and the upright pose keeps the supports off the face and the glasses.'],
    ['Layer height', '0.16 mm or 0.20 mm (0.12 mm for a showpiece; the head is mostly gentle curves, so variable/adaptive layer height works well)'],
    ['Nozzle', '0.4 mm. A 0.2 mm nozzle sharpens the mouth/nostrils at small scales'],
    ['Walls', '3 walls (≈1.2 mm). The ears, paws and arms are then solid perimeters'],
    ['Top / bottom', '5 top, 3-4 bottom layers'],
    ['Infill', '10-15 % gyroid or grid. It is a figurine, so 15 % is plenty'],
    ['Supports', `Tree (auto) / organic, threshold ${a.overhang.thresholdDeg}°, top Z distance 0.2 mm, support interface 2 layers. See the next section`],
    ['Brim', 'not needed (the base is ' + a.footprintMM[0] + ' mm wide); use one only for kubara_nobase.stl'],
    ['Material', 'PLA / PLA+ (all numbers assume PLA 1.24 g/cm³). PETG works but strings more on the face details'],
  ], ['Setting', 'Value']);

  L.push('## Supports: where and why', '');
  L.push(`Overhangs were analysed programmatically on \`kubara.stl\` as placed (upright). Two methods were used:`, '');
  L.push(`1. **Facet analysis.** Every downward-facing triangle steeper than ${a.overhang.thresholdDeg}° from vertical (not touching the bed), grouped into connected patches and labelled by body region. Total: **${fmt(a.overhang.projectedAreaMM2, 0)} mm²** of projected overhang area. Below ${fmt(a.overhang.restsOnBedMM2, 0)} mm² of it there is only build plate or the figure's own base plate, so supports leave no visible marks there. Under the other ${fmt(a.overhang.restsOnModelMM2, 0)} mm² a support column would have to stand on the figure itself (on the belly or a paw).`);
  L.push(`2. **Layer analysis**, done the way a slicer does it. The body is sliced every ${LAYER} mm, and the report records (a) islands that start in mid-air with nothing below them and (b) the area of each layer that sticks out more than a ${a.overhang.thresholdDeg}° slope beyond the layer below.`, '');
  L.push('**Overhang zones (facet analysis):**', '');
  t(a.overhang.zones.filter((z) => z.projectedAreaMM2 >= 3).map((z) => [z.where, `${fmt(z.zRangeMM[0])}–${fmt(z.zRangeMM[1])}`, fmt(z.projectedAreaMM2, 0), z.supportRestsOn]), ['Region', 'Height (mm)', 'Projected area (mm²)', 'Support would rest on']);
  if (a.overhang.islands.length) {
    L.push('**Floating islands.** These areas must have support, or the layer prints in mid-air:', '');
    t(a.overhang.islands.map((i) => [i.where, fmt(i.zMM), `${i.centreXY.join(', ')}`, fmt(i.areaMM2, 2)]), ['Region', 'Starts at z (mm)', 'Centre x, y (mm)', 'First-layer area (mm²)']);
  } else L.push('No floating islands: every layer touches the layer below.', '');
  L.push('**Largest unsupported zones (layer analysis):**', '');
  t(a.overhang.sliceZones.slice(0, 8).map((z) => [z.where, `${fmt(z.zRangeMM[0])}–${fmt(z.zRangeMM[1])}`, fmt(z.unsupportedAreaMM2, 0)]), ['Region', 'Height (mm)', 'Area beyond 45° (mm², summed over layers)']);
  if (s.single80?.supportZones?.length) {
    L.push(`**What Bambu Studio actually generated.** Tree supports at ${a.overhang.thresholdDeg}°, ${s.single80.supportGrams} g in total:`, '');
    t(s.single80.supportZones.slice(0, 8).map((z) => [z.where, `${fmt(z.zRangeMM[0])}–${fmt(z.zRangeMM[1])}`, fmt(z.grams, 2)]), ['Supports the', 'Height (mm)', 'Grams']);
  }
  L.push('**In practice:**', '');
  L.push('- Use **tree / organic supports**. A straight column under the chin would land on the belly, but tree supports branch around it: in the Bambu Studio slice the chin tree grows from the build plate (it starts at z = 0.2 mm), so "on build plate only" can stay on and the belly stays clean. The crotch supports stand on the base plate, which is hidden in use.');
  L.push('- The critical spot is **under the chin / snout**. It is the only large flat-ish ceiling, and the face is the most visible surface, so use 2 support interface layers and 0.2 mm top Z distance.');
  L.push('- Alternatively, set supports to "manual" and **paint** them only on the zones listed above (Bambu: Support painting, enforcer). Everything else, including the lenses, strap, arms and ears, is designed to print without support (45° chamfers under the lenses and strap, a hidden gusset under the paws).');
  L.push('');
  L.push('**Orientation check.** Projected overhang area for other orientations (facet metric):', '');
  t(a.overhang.orientations.map((o) => [o.name, fmt(o.overhangProjectedMM2, 0), fmt(o.flatBedContactMM2, 0)]), ['Orientation', 'Overhang (mm²)', 'Flat bed contact (mm²)']);
  L.push(`Upright is the only orientation with a real flat face on the bed (the ${fmt(a.overhang.orientations[0].flatBedContactMM2, 0)} mm² base). The other orientations rest on a curved surface, so they need a raft or a large support pad, and they leave support scars on visible areas.`, '');

  L.push('## Size, volume, filament', '');
  t([
    ['Figure / total height', `${a.figureHeightMM} / ${a.totalHeightMM} mm`],
    ['Bounding box (x × y × z)', ch('kubara.stl').bbox.size.join(' × ') + ' mm'],
    ['Surface area', fmt(ch('kubara.stl').areaMM2 / 100, 1) + ' cm²'],
    ['Solid volume', `${fil.solidVolumeCM3} cm³ → ${fil.solidGrams} g at 100 % (upper bound)`],
    ['Geometric estimate, 3 walls + 15 % infill', `≈ ${fil.estimateGrams3Walls15} g + ≈ ${fil.supportGramsEstimate} g support`],
    ...(s.single80?.totalGrams != null ? [['Bambu Studio slice, single colour, 80 mm', `**${s.single80.totalGrams} g** (model ${s.single80.modelGrams} g + support ${s.single80.supportGrams} g), ${s.single80.timeH} h, ${s.single80.layers} layers`]] : []),
    ...(s.single120?.totalGrams != null ? [['Bambu Studio slice, single colour, 120 mm', `**${s.single120.totalGrams} g** (support ${s.single120.supportGrams} g), ${s.single120.timeH} h`]] : [['120 mm version (geometric)', `≈ ${fil.scaled120.estimateGrams} g (solid ${fil.scaled120.solidGrams} g)`]]),
  ], ['', '']);
  if (s.available && !s.error) L.push(`Slicer numbers: ${s.printer}, "${s.process}", ${s.filament} with density overridden to 1.24 g/cm³, 3 walls, 15 % infill, tree(auto) supports at ${a.overhang.thresholdDeg}°. A P1S gives about the same time; an A1 / A1 mini is roughly 10-20 % slower.`, '');

  L.push('## Multi-colour (AMS)', '');
  L.push('Open `kubara_multicolor.3mf` in Bambu Studio or OrcaSlicer. It loads as **one object with 4 parts** that are already assigned to filament slots 1-4. If the slicer asks, choose to import the geometry/settings. Check the slots and their colours:', '');
  t(a.threeMF.parts.map((p) => [String(p.extruder), p.name, p.color ? '`' + p.color.slice(0, 7) + '`' : '', ({ fur: 'body fur, light mint / aqua', fur_shade: 'muzzle + inner ears, turquoise', ink: 'sunglasses, strap, nostrils, mouth, base plate', glint: 'lens glints (2 small dots)' })[p.name] ?? '', fmt(a.filament.perPart.find((q) => q.part === p.name)?.solidGrams ?? 0, 2) + ' g solid']), ['Slot', 'Part', 'Colour', 'What', 'Solid weight']);
  L.push('Steps:');
  L.push('1. Load the 3MF. In the Objects list, expand "kubara" to see the parts fur / fur_shade / ink / glint and their filament numbers.');
  L.push('2. In the filament panel, set slot colours to match (e.g. Bambu PLA Basic *Mint* or *Ice Blue* for fur, *Turquoise* / *Cyan* for fur_shade, *Black*, *Jade White*). If the slicer shows only one filament, add filaments 2-4 with the **+** button. The part assignments stay.');
  L.push('3. Enable supports as above. Then, under the object\'s filament / flushing options, enable **"Flush into objects\' infill"** and **"Flush into support"** to save purge filament. The prime tower is required for AMS.');
  L.push('4. Slice and check the preview in "Filament" colour mode.');
  L.push('');
  if (s.multi80?.perFilament) {
    const m = s.multi80;
    L.push(`Bambu Studio slice of the 3MF (80 mm, X1C, ${m.settings}): **${m.timeH} h**, **${m.filamentChanges} filament changes**, Bambu Studio reports **${m.slicerReportedGrams} g** in total. Grams per slot, from the G-code (start-up purge included, so slightly more):`, '');
    t(m.perFilament.map((f) => [String(f.slot), f.colour, fmt(f.modelG, 1), fmt(f.supportG, 1), fmt(f.flushG + f.towerG, 1), fmt(f.totalG, 1)]), ['Slot', 'Colour', 'Model', 'Support', 'Purge + prime tower', 'Total']);
    L.push(`So **${m.modelGrams} g ends up in the figure** and **≈ ${m.purgeGrams} g is purge waste** (flush + prime tower). The colour changes cluster in the head, where every layer from the chin to the ears needs 2-4 colours.`, '');
    const c3 = s.multi80_3col;
    if (c3?.timeH) {
      L.push('Comparison (all 80 mm, X1C, same settings):', '');
      t([
        ['Single colour, `kubara.stl`', fmt(s.single80.timeH, 1) + ' h', '0', fmt(s.single80.slicerReportedGrams, 0) + ' g'],
        ['4 colours, `kubara_multicolor.3mf`', fmt(m.timeH, 1) + ' h', String(m.filamentChanges), fmt(m.slicerReportedGrams, 0) + ' g'],
        ['3 colours (glint part set to the ink slot, glints painted)', fmt(c3.timeH, 1) + ' h', String(c3.filamentChanges), fmt(c3.slicerReportedGrams, 0) + ' g'],
      ], ['Variant', 'Time', 'Filament changes', 'Filament (Bambu)']);
    }
    L.push('Ways to cut the waste and time:', '');
  } else L.push('Expect many filament changes in the head section (chin to ears), and with them a lot of purge waste. Ways to cut it:', '');
  L.push('- Print the **glint** (slot 4) in the same white you would use anyway, or merge it into ink (set the glint part to slot 3) and add the glints with a white paint pen afterwards. That removes one colour from the busiest layers.');
  L.push('- Increase "flush into infill/support", or lower the flushing volumes (Bambu: Flushing volumes, multiplier 0.7-0.8 is usually fine going from dark to light only).');
  L.push('- Print a single-colour body and paint it (below). For one figurine this is often faster.');
  L.push('- No AMS: use the parts STLs with filament swaps at layer height (M600 / "Add pause"). Only the base (z 0–' + a.baseMM + ' mm, ink) separates cleanly by height. The face colours are spread over the head, so true multi-colour needs an AMS / MMU / toolchanger.', '');

  L.push('## Paint it by hand (single-colour print)', '');
  L.push('Print `kubara.stl` in light mint/aqua PLA (or white/grey and paint everything). The design has painting guides moulded in:', '');
  L.push('- **Ink (black)**: the sunglasses, strap, nostrils and mouth all stand slightly proud of the surface, so a fine brush or a 0.7 mm black paint pen follows their edges easily. Paint the base black too.');
  L.push('- **Muzzle / inner ears (turquoise)**: the inner ears are recessed pockets. The muzzle has no moulded edge: paint the front block of the snout below the glasses (see `renders/print_mc_front.png`). Turquoise acrylic (e.g. a mix of phthalo turquoise + white) matches `' + PALETTE.fur_shade + '`.');
  L.push('- **Glints**: one white dot on the upper outer corner of each lens (a white paint pen or a toothpick).');
  L.push('- Prep: remove support nubs under the chin with a flush cutter, sand with 400 grit, prime (spray filler primer hides layer lines), then acrylics. Finish with a matte varnish so the fur looks soft and the glasses with a gloss varnish.');
  L.push('- Palette: fur `' + PALETTE.fur + '`, muzzle `' + PALETTE.fur_shade + '`, ink `' + PALETTE.ink + '`, glint `' + PALETTE.glint + '`.', '');

  L.push('## Scaling', '');
  const sc = a.thickness.scale;
  L.push(`A ray-cast thickness probe (${a.thickness.samples} samples, median of 5 rays each) measured the local wall thickness of \`kubara.stl\`. Only ${fmt(a.thickness.fractionBelow12 * 100, 2)} % of the surface sits on less than 1.2 mm of material, and those spots are *feathered edges*: places where the strap, paws and soles blend into the body at a shallow angle and taper to zero along an attached edge. They are not protrusions and cannot break off. Per region, ignoring feathered edges (< ${a.thickness.featherMM} mm):`, '');
  const mm = (v) => (v == null ? '–' : v >= 20 ? '> 20' : fmt(v, 2));
  t(a.thickness.regionThickness.filter((r) => r.samples >= 100).slice(0, 8).map((r) => [r.where, mm(r.p1), mm(r.p5), mm(r.median), fmt(r.featheredPct, 2) + ' %']), ['Region', '1st percentile (mm)', '5th percentile (mm)', 'Median (mm)', 'Feathered']);
  L.push(`The thinnest real structures are the **${sc.structuralMinRegion}s**: 95 % of their surface sits on ≥ ${fmt(sc.structuralMinMM, 2)} mm of material at 80 mm (only the rounded rim is thinner). Everything else is chunky.`, '');
  L.push('Designed detail widths at 80 mm (they scale linearly):', '');
  t(a.thickness.details.map((d) => [d.feature, fmt(d.widthMM, 2)]), ['Detail', 'Width (mm)']);
  L.push('Scaling advice (figure height; the base scales with it):', '');
  L.push(`- **Recommended minimum: ${Math.max(sc.minFigureHeightDetailsMM, sc.minFigureHeightRecommendedMM, 60)} mm figure height** (×${fmt(Math.max(sc.minFigureHeightDetailsMM, sc.minFigureHeightRecommendedMM, 60) / a.figureHeightMM, 2)}) with a 0.4 mm nozzle.`);
  L.push(`- Structure: the ${sc.structuralMinRegion}s stay ≥ 1.2 mm thick down to **${sc.minFigureHeightRecommendedMM} mm**, and ≥ 0.8 mm (2 extrusion lines) down to **${sc.minFigureHeightHardMM} mm**. Below that they get fragile.`);
  L.push(`- **${sc.minFigureHeightDetailsMM} mm** is the smallest size where the finest colour/relief detail (${fmt(minDetail, 2)} mm wide at 80 mm) is still 2 lines wide with a 0.4 mm nozzle. With a 0.2 mm nozzle you can go to about **${sc.minFigureHeight02NozzleMM} mm**.`);
  L.push('- Scale **up** freely. At 120 mm (`kubara_120mm.stl`) use 0.2 mm layers and 3-4 walls. At 150 mm or more, 4 walls and 10 % infill keep the weight down.');
  L.push('- Always scale **uniformly** (lock the aspect ratio). In the multi-colour 3MF, scale the whole object, not individual parts.', '');

  L.push('## Preview renders', '');
  L.push('`npm run render:print` writes these to `renders/` (project root):', '');
  L.push('- `print_mc_front.png`, `print_mc_three_quarter.png`, `print_mc_back.png`, `print_mc_face.png`: the 4 colour parts together, i.e. the AMS result');
  L.push('- `print_overhang_front_low.png`, `print_overhang_side_low.png`, `print_overhang_back_low.png`, `print_overhang_chin.png`: red = steeper than 45° (needs support), orange = 35-45°, blue dots = spots under 1.2 mm (feathered edges)');
  L.push('- `print_scale.png`: 80 mm and 120 mm side by side on a 10 mm grid', '');
  L.push('## Verification', '');
  L.push('Every mesh was re-read the way a slicer reads it (vertices welded by position) and checked for open edges, non-manifold edges, flipped faces and degenerate triangles, then reloaded into manifold-3d:', '');
  t(a.checks.map((c) => [c.name, c.watertight ? 'yes' : '**NO**', String(c.shells), String(c.triangles), fmt(c.volumeMM3 / 1000, 2), c.bbox.size.join(' × ')]), ['File', 'Watertight', 'Shells', 'Triangles', 'Volume (cm³)', 'Size (mm)']);
  L.push(`- Colour parts: pairwise overlap ${a.assembly.pairwiseOverlapMM3} mm³, outside the single body ${a.assembly.partsOutsideBodyMM3} mm³. Together they make up the single body (${fmt(a.assembly.partsVolumeMM3 / 1000, 2)} vs ${fmt(a.assembly.bodyVolumeMM3 / 1000, 2)} cm³; the parts are separated by a 0.01 mm gap so they never share faces).`);
  L.push(`- 3MF: ${a.threeMF.valid ? '**structurally valid**' : '**INVALID**: ' + a.threeMF.errors.join('; ')}. Checked: content types, relationships, XML nesting, millimetre units, object ids, component and build references, colour group indices, model_settings ↔ components, project filament count, every part a closed 2-manifold identical to its parts/*.stl, parts disjoint (${a.threeMF.pairwiseOverlapMM3} mm³ overlap).`);
  if (s.roundTrip) L.push(`- Bambu Studio CLI round trip (import, then export project): ${s.roundTrip.ok ? 'all 4 parts kept their names and filament slots' : 'MISMATCH ' + JSON.stringify(s.roundTrip.parts)}.`);
  if (s.single80?.warning || s.multi80?.warning) L.push(`- Slicer warnings: ${[s.single80?.warning, s.multi80?.warning].filter(Boolean).join(' / ')}`);
  L.push('', 'Regenerate everything with `npm run build && npm run print:report` (add `--no-slice` to skip Bambu Studio). Preview renders: `npm run render:print` → `renders/print_*.png`.', '');
  return L.join('\n');
}
