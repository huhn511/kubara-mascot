// Uniform-grid ray caster for indexed triangle meshes ({pos, idx}); used by the print analysis
// (local wall thickness, support column heights).

export function bboxOf(pos) {
  const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < pos.length; i += 3) for (let k = 0; k < 3; k++) {
    if (pos[i + k] < min[k]) min[k] = pos[i + k];
    if (pos[i + k] > max[k]) max[k] = pos[i + k];
  }
  return { min, max };
}

export function triInfo(pos, idx, t) {
  const a = idx[3 * t] * 3, b = idx[3 * t + 1] * 3, c = idx[3 * t + 2] * 3;
  const e1x = pos[b] - pos[a], e1y = pos[b + 1] - pos[a + 1], e1z = pos[b + 2] - pos[a + 2];
  const e2x = pos[c] - pos[a], e2y = pos[c + 1] - pos[a + 1], e2z = pos[c + 2] - pos[a + 2];
  const nx = e1y * e2z - e1z * e2y, ny = e1z * e2x - e1x * e2z, nz = e1x * e2y - e1y * e2x;
  const l = Math.hypot(nx, ny, nz) || 1;
  return {
    n: [nx / l, ny / l, nz / l], area: l / 2,
    c: [(pos[a] + pos[b] + pos[c]) / 3, (pos[a + 1] + pos[b + 1] + pos[c + 1]) / 3, (pos[a + 2] + pos[b + 2] + pos[c + 2]) / 3],
  };
}

export function buildGrid(pos, idx, cell) {
  const { min, max } = bboxOf(pos);
  const lo = min.map((v) => v - 1e-3);
  const dims = max.map((v, k) => Math.max(1, Math.ceil((v - lo[k] + 1e-3) / cell)));
  const cells = new Map();
  const nTri = idx.length / 3;
  for (let t = 0; t < nTri; t++) {
    const tmin = [Infinity, Infinity, Infinity], tmax = [-Infinity, -Infinity, -Infinity];
    for (let j = 0; j < 3; j++) {
      const v = idx[3 * t + j] * 3;
      for (let k = 0; k < 3; k++) { tmin[k] = Math.min(tmin[k], pos[v + k]); tmax[k] = Math.max(tmax[k], pos[v + k]); }
    }
    const i0 = tmin.map((v, k) => Math.floor((v - lo[k]) / cell)), i1 = tmax.map((v, k) => Math.floor((v - lo[k]) / cell));
    for (let x = i0[0]; x <= i1[0]; x++) for (let y = i0[1]; y <= i1[1]; y++) for (let z = i0[2]; z <= i1[2]; z++) {
      const key = (x * dims[1] + y) * dims[2] + z;
      let a = cells.get(key);
      if (!a) cells.set(key, (a = []));
      a.push(t);
    }
  }
  return { lo, dims, cell, cells, pos, idx };
}

function rayTri(P, T, t, o, d) {
  const a = T[3 * t] * 3, b = T[3 * t + 1] * 3, c = T[3 * t + 2] * 3;
  const e1x = P[b] - P[a], e1y = P[b + 1] - P[a + 1], e1z = P[b + 2] - P[a + 2];
  const e2x = P[c] - P[a], e2y = P[c + 1] - P[a + 1], e2z = P[c + 2] - P[a + 2];
  const px = d[1] * e2z - d[2] * e2y, py = d[2] * e2x - d[0] * e2z, pz = d[0] * e2y - d[1] * e2x;
  const det = e1x * px + e1y * py + e1z * pz;
  if (Math.abs(det) < 1e-14) return Infinity;
  const inv = 1 / det, sx = o[0] - P[a], sy = o[1] - P[a + 1], sz = o[2] - P[a + 2];
  const u = (sx * px + sy * py + sz * pz) * inv;
  if (u < 0 || u > 1) return Infinity;
  const qx = sy * e1z - sz * e1y, qy = sz * e1x - sx * e1z, qz = sx * e1y - sy * e1x;
  const v = (d[0] * qx + d[1] * qy + d[2] * qz) * inv;
  if (v < 0 || u + v > 1) return Infinity;
  const tt = (e2x * qx + e2y * qy + e2z * qz) * inv;
  return tt > 1e-6 ? tt : Infinity;
}

/** First hit along o + t*d (d normalised). Returns {t, tri}; t = Infinity on a miss. */
export function raycast(G, o, d, maxT = Infinity, skip = -1) {
  const { lo, dims, cell, cells, pos, idx } = G;
  const id = [0, 1, 2].map((k) => Math.floor((o[k] - lo[k]) / cell));
  const step = d.map((v) => (v > 0 ? 1 : v < 0 ? -1 : 0));
  const tMax = [0, 1, 2].map((k) => (d[k] === 0 ? Infinity : ((id[k] + (d[k] > 0 ? 1 : 0)) * cell + lo[k] - o[k]) / d[k]));
  const tDelta = d.map((v) => (v === 0 ? Infinity : cell / Math.abs(v)));
  let best = Infinity, bestT = -1;
  const seen = new Set();
  for (;;) {
    if (id[0] < 0 || id[1] < 0 || id[2] < 0 || id[0] >= dims[0] || id[1] >= dims[1] || id[2] >= dims[2]) break;
    const a = cells.get((id[0] * dims[1] + id[1]) * dims[2] + id[2]);
    if (a) for (const t of a) {
      if (t === skip || seen.has(t)) continue;
      seen.add(t);
      const h = rayTri(pos, idx, t, o, d);
      if (h < best) { best = h; bestT = t; }
    }
    const k = tMax[0] < tMax[1] ? (tMax[0] < tMax[2] ? 0 : 2) : (tMax[1] < tMax[2] ? 1 : 2);
    if (best <= tMax[k] || tMax[k] > maxT) break;
    id[k] += step[k];
    tMax[k] += tDelta[k];
  }
  return { t: best, tri: bestT };
}

/** 5 directions: n plus 4 tilted 25 deg around it (robust local-thickness probe = median of the 5 hits). */
export function cone(n, deg = 25) {
  const t = Math.abs(n[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0];
  const u = [n[1] * t[2] - n[2] * t[1], n[2] * t[0] - n[0] * t[2], n[0] * t[1] - n[1] * t[0]];
  const ul = Math.hypot(...u);
  for (let i = 0; i < 3; i++) u[i] /= ul;
  const v = [n[1] * u[2] - n[2] * u[1], n[2] * u[0] - n[0] * u[2], n[0] * u[1] - n[1] * u[0]];
  const a = (deg * Math.PI) / 180, c = Math.cos(a), s = Math.sin(a);
  const dirs = [n];
  for (const [p, q] of [[1, 0], [0, 1], [-1, 0], [0, -1]]) dirs.push([0, 1, 2].map((k) => c * n[k] + s * (p * u[k] + q * v[k])));
  return dirs;
}
