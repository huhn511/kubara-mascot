// Mesh utilities for the build: decimation that keeps meshes closed, creased
// normals, STL read-back with position welding and topology checks.
import { readFileSync } from 'node:fs';
import { MeshoptSimplifier } from 'meshoptimizer';

/** Compact an indexed mesh (drop unused vertices). pos: Float32Array xyz. */
export function compact(pos, idx) {
  const remap = new Int32Array(pos.length / 3).fill(-1);
  const out = [];
  let nv = 0;
  const nidx = new Uint32Array(idx.length);
  for (let i = 0; i < idx.length; i++) {
    const v = idx[i];
    if (remap[v] < 0) { remap[v] = nv++; out.push(pos[3 * v], pos[3 * v + 1], pos[3 * v + 2]); }
    nidx[i] = remap[v];
  }
  return { pos: new Float32Array(out), idx: nidx };
}

/**
 * Split pinched (non-manifold) vertices: a vertex whose incident triangles form more than one edge-connected
 * fan gets one copy per extra fan. Decimation of thin parts (strap, bridge) often produces such pinches.
 */
export function splitPinchedVertices(pos, idx) {
  const nV = pos.length / 3;
  const inc = Array.from({ length: nV }, () => []);
  for (let c = 0; c < idx.length; c++) inc[idx[c]].push(c);
  const out = Array.from(pos);
  const nidx = new Uint32Array(idx);
  for (let v = 0; v < nV; v++) {
    const cs = inc[v];
    if (cs.length < 2) continue;
    // union-find over the incident corners: two triangles join if they share another vertex (an edge through v)
    const par = cs.map((_, i) => i);
    const find = (x) => { while (par[x] !== x) { par[x] = par[par[x]]; x = par[x]; } return x; };
    const others = cs.map((c) => { const t = c - (c % 3); return [idx[t], idx[t + 1], idx[t + 2]].filter((w) => w !== v); });
    const byOther = new Map();
    others.forEach((os, i) => os.forEach((w) => { if (byOther.has(w)) par[find(i)] = find(byOther.get(w)); else byOther.set(w, i); }));
    const roots = [...new Set(cs.map((_, i) => find(i)))];
    if (roots.length < 2) continue;
    for (let r = 1; r < roots.length; r++) {
      const nv = out.length / 3;
      out.push(pos[3 * v], pos[3 * v + 1], pos[3 * v + 2]);
      cs.forEach((c, i) => { if (find(i) === roots[r]) nidx[c] = nv; });
    }
  }
  return { pos: new Float32Array(out), idx: nidx };
}

/** Drop zero-area / repeated-index triangles. */
export function dropDegenerate(pos, idx, minArea2 = 1e-20) {
  const keep = [];
  for (let t = 0; t < idx.length; t += 3) {
    const a = idx[t], b = idx[t + 1], c = idx[t + 2];
    if (a === b || b === c || a === c) continue;
    const ux = pos[3 * b] - pos[3 * a], uy = pos[3 * b + 1] - pos[3 * a + 1], uz = pos[3 * b + 2] - pos[3 * a + 2];
    const wx = pos[3 * c] - pos[3 * a], wy = pos[3 * c + 1] - pos[3 * a + 1], wz = pos[3 * c + 2] - pos[3 * a + 2];
    const nx = uy * wz - uz * wy, ny = uz * wx - ux * wz, nz = ux * wy - uy * wx;
    if (nx * nx + ny * ny + nz * nz <= minArea2) continue;
    keep.push(a, b, c);
  }
  return new Uint32Array(keep);
}

/** Edge topology of an indexed triangle mesh (indices must already be welded by position). */
export function topology(idx, nVert) {
  const und = new Map();
  const dir = new Set();
  let misoriented = 0;
  for (let t = 0; t < idx.length; t += 3) {
    for (let k = 0; k < 3; k++) {
      const u = idx[t + k], v = idx[t + ((k + 1) % 3)];
      const key = u < v ? u * 4294967296 + v : v * 4294967296 + u;
      und.set(key, (und.get(key) || 0) + 1);
      const dk = u * 4294967296 + v;
      if (dir.has(dk)) misoriented++; else dir.add(dk);
    }
  }
  let boundary = 0, nonManifold = 0;
  for (const c of und.values()) { if (c === 1) boundary++; else if (c > 2) nonManifold++; }
  // connected components over shared vertices
  const par = new Int32Array(nVert).map((_, i) => i);
  const find = (x) => { while (par[x] !== x) { par[x] = par[par[x]]; x = par[x]; } return x; };
  for (let t = 0; t < idx.length; t += 3) {
    const a = find(idx[t]);
    par[find(idx[t + 1])] = a; par[find(idx[t + 2])] = a;
  }
  const roots = new Set();
  for (let t = 0; t < idx.length; t += 3) roots.add(find(idx[t]));
  return { boundary, nonManifold, misoriented, components: roots.size };
}

/** Read a binary STL and weld vertices by exact float position (what slicers do). */
export function readSTLWelded(path) {
  const b = readFileSync(path);
  const n = b.readUInt32LE(80);
  const vmap = new Map();
  const verts = [];
  const idx = new Uint32Array(n * 3);
  let o = 84, degenerate = 0;
  for (let t = 0; t < n; t++) {
    o += 12;
    for (let k = 0; k < 3; k++) {
      const x = b.readFloatLE(o), y = b.readFloatLE(o + 4), z = b.readFloatLE(o + 8);
      o += 12;
      const key = `${x},${y},${z}`;
      let id = vmap.get(key);
      if (id === undefined) { id = verts.length / 3; vmap.set(key, id); verts.push(x, y, z); }
      idx[3 * t + k] = id;
    }
    o += 2;
    if (idx[3 * t] === idx[3 * t + 1] || idx[3 * t + 1] === idx[3 * t + 2] || idx[3 * t] === idx[3 * t + 2]) degenerate++;
  }
  return { pos: new Float32Array(verts), idx, nTri: n, degenerate };
}

/**
 * Decimate to <= budget triangles with meshoptimizer while keeping the mesh closed and 2-manifold.
 * `isValid(pos, idx)` must return true for an acceptable result. Retries with a gentler target.
 */
export function decimate(pos, idx, budget, isValid, lock = null, update = true, factors = [1, 1.015, 1.03, 1.05, 1.08, 1.12, 1.18, 1.3, 1.5], attrs = null) {
  // attrs: optional {data: Float32Array (stride per vertex), stride, weights} e.g. SDF normals so small grooves survive
  if (idx.length / 3 <= budget) return { pos, idx, ok: true };
  for (const factor of factors) {
    for (const flags of [['Regularize'], []]) {
      const p = new Float32Array(pos);
      const i = new Uint32Array(idx);
      let tri;
      if (update) {
        const A = attrs ? new Float32Array(attrs.data) : new Float32Array(0);
        const [count] = MeshoptSimplifier.simplifyWithUpdate(i, p, 3, A, attrs ? attrs.stride : 0, attrs ? attrs.weights : [], lock, Math.floor(budget / factor) * 3, 0.05, flags);
        tri = i.subarray(0, count);
      } else {
        // vertices stay exactly on the level set: crisp rims on hard-edged parts (lenses, strap)
        [tri] = MeshoptSimplifier.simplifyWithAttributes(i, p, 3, new Float32Array(0), 0, [], lock, Math.floor(budget / factor) * 3, 0.05, flags);
      }
      // zero-area triangles: dropping them usually removes folded fins (non-manifold edges) but can open a hole,
      // so try both variants; pinched vertices are split in either case
      for (const minArea2 of [1e-20, -1]) {
        const c0 = compact(p, dropDegenerate(p, tri, minArea2));
        const c = splitPinchedVertices(c0.pos, c0.idx);
        if (c.idx.length / 3 <= budget && isValid(c.pos, c.idx)) return { ...c, ok: true };
      }
    }
  }
  // last resort: plain simplify (never moves vertices); caller may retry with a coarser input mesh
  const [s] = MeshoptSimplifier.simplify(idx, pos, 3, budget * 3, 0.05, []);
  return { ...compact(pos, s), ok: false };
}

/**
 * Angle-weighted vertex normals with crease splitting (corners whose face normals differ by more than
 * creaseDeg get their own vertex). `smooth(x,y,z)` (optional) supplies an analytic normal (SDF gradient)
 * that replaces the averaged one where both agree within 35 deg - keeps organic parts perfectly smooth.
 * Returns non-shared {pos, nrm, idx}.
 */
export function creasedNormals(pos, idx, creaseDeg = 60, smooth = null, smoothMaxDeg = 35) {
  const nT = idx.length / 3, nV = pos.length / 3;
  const fn = new Float64Array(nT * 3);
  const ang = new Float64Array(nT * 3);
  for (let t = 0; t < nT; t++) {
    const v = [idx[3 * t], idx[3 * t + 1], idx[3 * t + 2]];
    const P = v.map((i) => [pos[3 * i], pos[3 * i + 1], pos[3 * i + 2]]);
    const e = (a, b) => [P[b][0] - P[a][0], P[b][1] - P[a][1], P[b][2] - P[a][2]];
    const u = e(0, 1), w = e(0, 2);
    let n = [u[1] * w[2] - u[2] * w[1], u[2] * w[0] - u[0] * w[2], u[0] * w[1] - u[1] * w[0]];
    const l = Math.hypot(...n) || 1;
    fn[3 * t] = n[0] / l; fn[3 * t + 1] = n[1] / l; fn[3 * t + 2] = n[2] / l;
    for (let k = 0; k < 3; k++) {
      const a = e(k, (k + 1) % 3), b = e(k, (k + 2) % 3);
      const la = Math.hypot(...a) || 1, lb = Math.hypot(...b) || 1;
      ang[3 * t + k] = Math.acos(Math.max(-1, Math.min(1, (a[0] * b[0] + a[1] * b[1] + a[2] * b[2]) / (la * lb))));
    }
  }
  // vertex -> incident corners
  const start = new Uint32Array(nV + 1);
  for (let i = 0; i < idx.length; i++) start[idx[i] + 1]++;
  for (let v = 0; v < nV; v++) start[v + 1] += start[v];
  const fill = start.slice(0, nV);
  const corners = new Uint32Array(idx.length);
  for (let i = 0; i < idx.length; i++) corners[fill[idx[i]]++] = i;

  const cosC = Math.cos(creaseDeg * Math.PI / 180), cosS = Math.cos(smoothMaxDeg * Math.PI / 180);
  const outPos = [], outNrm = [], outIdx = new Uint32Array(idx.length);
  const key = new Map();
  const grad = new Map();
  for (let c = 0; c < idx.length; c++) {
    const v = idx[c], t = (c / 3) | 0;
    let nx = 0, ny = 0, nz = 0;
    for (let j = start[v]; j < start[v + 1]; j++) {
      const c2 = corners[j], t2 = (c2 / 3) | 0;
      const d = fn[3 * t] * fn[3 * t2] + fn[3 * t + 1] * fn[3 * t2 + 1] + fn[3 * t + 2] * fn[3 * t2 + 2];
      if (d >= cosC) { const a = ang[c2]; nx += fn[3 * t2] * a; ny += fn[3 * t2 + 1] * a; nz += fn[3 * t2 + 2] * a; }
    }
    let l = Math.hypot(nx, ny, nz) || 1;
    nx /= l; ny /= l; nz /= l;
    if (smooth) {
      let gv = grad.get(v);
      if (!gv) { gv = smooth(pos[3 * v], pos[3 * v + 1], pos[3 * v + 2]); grad.set(v, gv); }
      if (gv[0] * nx + gv[1] * ny + gv[2] * nz > cosS) { nx = gv[0]; ny = gv[1]; nz = gv[2]; }
    }
    const k = `${v}|${Math.round(nx * 1000)},${Math.round(ny * 1000)},${Math.round(nz * 1000)}`;
    let id = key.get(k);
    if (id === undefined) {
      id = outPos.length / 3;
      key.set(k, id);
      outPos.push(pos[3 * v], pos[3 * v + 1], pos[3 * v + 2]);
      outNrm.push(nx, ny, nz);
    }
    outIdx[c] = id;
  }
  return { pos: new Float32Array(outPos), nrm: new Float32Array(outNrm), idx: outIdx };
}

/**
 * Taubin (lambda|mu) smoothing of an indexed closed mesh, in place. Removes level-set "crumpled foil" faceting
 * without shrinking. `fixedY(y)` (optional) returns true for vertices whose Y must not move (flat sole).
 */
export function taubin(pos, idx, passes = 2, lambda = 0.5, mu = -0.53, fixedY = null) {
  const nV = pos.length / 3;
  const nb = Array.from({ length: nV }, () => new Set());
  for (let t = 0; t < idx.length; t += 3) {
    const a = idx[t], b = idx[t + 1], c = idx[t + 2];
    nb[a].add(b); nb[a].add(c); nb[b].add(a); nb[b].add(c); nb[c].add(a); nb[c].add(b);
  }
  const lists = nb.map((s) => Int32Array.from(s));
  const tmp = new Float64Array(pos.length);
  const step = (f) => {
    for (let v = 0; v < nV; v++) {
      const L = lists[v];
      if (!L.length) { tmp[3 * v] = pos[3 * v]; tmp[3 * v + 1] = pos[3 * v + 1]; tmp[3 * v + 2] = pos[3 * v + 2]; continue; }
      let x = 0, y = 0, z = 0;
      for (let k = 0; k < L.length; k++) { const w = L[k] * 3; x += pos[w]; y += pos[w + 1]; z += pos[w + 2]; }
      const n = L.length;
      tmp[3 * v] = pos[3 * v] + f * (x / n - pos[3 * v]);
      tmp[3 * v + 1] = fixedY && fixedY(pos[3 * v + 1]) ? pos[3 * v + 1] : pos[3 * v + 1] + f * (y / n - pos[3 * v + 1]);
      tmp[3 * v + 2] = pos[3 * v + 2] + f * (z / n - pos[3 * v + 2]);
    }
    pos.set(tmp);
  };
  for (let p = 0; p < passes; p++) { step(lambda); step(mu); }
  return pos;
}
