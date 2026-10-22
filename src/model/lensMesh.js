// Analytic (non level-set) game meshes for the sunglasses lenses and their glint stripes.
// A level set cannot hold the crisp "D" outline at game budgets, so these are built directly:
// a closed "ring stack" (front cap -> rounded rim -> side wall -> back cap) in the lens frame
// u (toward the snout), v (up), w (along the lens normal, 0 at the head surface).

/** Points of the "D" outline (flat top, elliptical bottom, rounded top corners), CCW in (u, v). */
export function dOutline({ rx, ry, vt, corner }, nEll = 44, nArc = 6, nTop = 10) {
  const pts = [];
  // lower half ellipse offset by `corner`, from the right (+u) end round the bottom to the left end
  for (let k = 0; k <= nEll; k++) {
    const phi = (k / nEll) * Math.PI;
    const ex = rx * Math.cos(phi), ey = -ry * Math.sin(phi);
    let nx = Math.cos(phi) / rx, ny = -Math.sin(phi) / ry;
    const l = Math.hypot(nx, ny);
    nx /= l; ny /= l;
    pts.push([ex + corner * nx, vt + ey + corner * ny, nx, ny]);
  }
  // left top corner arc (normal from -u to +v)
  for (let k = 1; k <= nArc; k++) {
    const a = Math.PI - (k / nArc) * (Math.PI / 2);
    pts.push([-rx + corner * Math.cos(a), vt + corner * Math.sin(a), Math.cos(a), Math.sin(a)]);
  }
  // flat top edge
  for (let k = 1; k < nTop; k++) {
    const u = -rx + (2 * rx * k) / nTop;
    pts.push([u, vt + corner, 0, 1]);
  }
  // right top corner arc (normal from +v to +u), last point == first ellipse point -> skipped
  for (let k = 0; k < nArc; k++) {
    const a = Math.PI / 2 - (k / nArc) * (Math.PI / 2);
    pts.push([rx + corner * Math.cos(a), vt + corner * Math.sin(a), Math.cos(a), Math.sin(a)]);
  }
  // the outline above runs right->bottom->left->top->right, i.e. clockwise in (u,v); reverse to CCW
  return pts.reverse();
}

/** Clip a convex polygon [[u,v],...] with the half-plane a*u + b*v <= c (Sutherland-Hodgman). */
function clipHalf(poly, a, b, c) {
  const out = [];
  for (let i = 0; i < poly.length; i++) {
    const p = poly[i], q = poly[(i + 1) % poly.length];
    const dp = a * p[0] + b * p[1] - c, dq = a * q[0] + b * q[1] - c;
    if (dp <= 0) out.push(p);
    if ((dp < 0 && dq > 0) || (dp > 0 && dq < 0)) {
      const t = dp / (dp - dq);
      out.push([p[0] + (q[0] - p[0]) * t, p[1] + (q[1] - p[1]) * t]);
    }
  }
  return out;
}

/** Resample a closed polygon so no edge is longer than maxLen. */
function densify(poly, maxLen) {
  const out = [];
  for (let i = 0; i < poly.length; i++) {
    const p = poly[i], q = poly[(i + 1) % poly.length];
    const n = Math.max(1, Math.ceil(Math.hypot(q[0] - p[0], q[1] - p[1]) / maxLen));
    for (let k = 0; k < n; k++) out.push([p[0] + ((q[0] - p[0]) * k) / n, p[1] + ((q[1] - p[1]) * k) / n]);
  }
  return out;
}

/**
 * Closed mesh from a stack of rings (each ring: N points [x,y,z], same N) capped by two apex points.
 * stack = [apexFront, ring0, ring1, ..., ringM, apexBack]. Orientation is fixed afterwards (positive volume).
 */
function ringStack(apexA, rings, apexB) {
  const N = rings[0].length;
  const pos = [...apexA];
  for (const r of rings) for (const p of r) pos.push(p[0], p[1], p[2]);
  pos.push(...apexB);
  const idx = [];
  const at = (ri, k) => 1 + ri * N + (k % N);
  for (let k = 0; k < N; k++) idx.push(0, at(0, k), at(0, k + 1));
  for (let r = 0; r < rings.length - 1; r++)
    for (let k = 0; k < N; k++) {
      const a = at(r, k), b = at(r, k + 1), c = at(r + 1, k + 1), d = at(r + 1, k);
      idx.push(a, d, b, b, d, c);
    }
  const last = 1 + rings.length * N;
  const lr = rings.length - 1;
  for (let k = 0; k < N; k++) idx.push(last, at(lr, k + 1), at(lr, k));
  // orientation: signed volume must be positive (outward normals)
  let vol = 0;
  for (let t = 0; t < idx.length; t += 3) {
    const a = idx[t] * 3, b = idx[t + 1] * 3, c = idx[t + 2] * 3;
    vol += pos[a] * (pos[b + 1] * pos[c + 2] - pos[b + 2] * pos[c + 1])
      - pos[a + 1] * (pos[b] * pos[c + 2] - pos[b + 2] * pos[c])
      + pos[a + 2] * (pos[b] * pos[c + 1] - pos[b + 1] * pos[c]);
  }
  if (vol < 0) for (let t = 0; t < idx.length; t += 3) { const s = idx[t + 1]; idx[t + 1] = idx[t + 2]; idx[t + 2] = s; }
  return { pos: new Float32Array(pos), idx: new Uint32Array(idx) };
}

/**
 * Build the lens and glint meshes for one lens.
 * ln: {o, uFront, n} lens frame; G: glasses params; F0: fur envelope SDF (for the embedded back face).
 */
export function buildLensMeshes(ln, G, F0, { rings = 6, bevelSteps = 3, bevel = 0.005 } = {}) {
  const LR = G.lensCorner;
  const shape = { rx: G.lensHalfW - LR, ry: G.lensTop - G.lensBottom - 2 * LR, vt: G.lensTop - LR, corner: LR };
  const wFace = (u) => G.lensProud - G.lensBend * u * u;
  const toW = (u, v, w) => [
    ln.o[0] + u * ln.uFront[0] + w * ln.n[0],
    ln.o[1] + v,
    ln.o[2] + u * ln.uFront[2] + w * ln.n[2],
  ];
  // back face: first point (marching inward along -n from the face) that is lensEmbed inside the fur
  const wBack = (u, v) => {
    const w0 = wFace(u), wMin = w0 - G.lensThick;
    const f = (w) => { const p = toW(u, v, w); return F0(p[0], p[1], p[2]) + G.lensEmbed; };
    let hi = w0;
    for (let w = w0; w >= wMin; w -= 0.002) {
      if (f(w) <= 0) {
        let lo = w;
        for (let it = 0; it < 30; it++) { const m = (lo + hi) / 2; if (f(m) <= 0) lo = m; else hi = m; }
        return Math.max((lo + hi) / 2, wMin);
      }
      hi = w;
    }
    return wMin;
  };

  // ---- lens
  const outline = dOutline(shape);
  const cu = 0, cv = (G.lensTop + G.lensBottom) / 2;
  const inset = (s) => outline.map(([u, v, nx, ny]) => [u - s * nx, v - s * ny]);
  const scaleTo = (ring2, t) => ring2.map(([u, v]) => [cu + (u - cu) * t, cv + (v - cv) * t]);
  const capRing = inset(bevel);
  const front = [], back = [];
  for (let k = 1; k <= rings; k++) {
    const r2 = scaleTo(capRing, k / rings);
    front.push(r2.map(([u, v]) => toW(u, v, wFace(u))));
  }
  // rounded front rim: quarter circle of radius `bevel`
  for (let j = 1; j <= bevelSteps; j++) {
    const a = (j / bevelSteps) * (Math.PI / 2);
    const r2 = inset(bevel * (1 - Math.sin(a)));
    front.push(r2.map(([u, v]) => toW(u, v, wFace(u) - bevel * (1 - Math.cos(a)))));
  }
  // side wall down to the embedded back face, then the back cap (coarse: hidden inside the head)
  const backOutline = outline.map(([u, v]) => toW(u, v, wBack(u, v)));
  back.push(backOutline);
  for (const t of [0.66, 0.33]) back.push(scaleTo(capRing, t).map(([u, v]) => toW(u, v, wBack(u, v))));
  const lens = ringStack(toW(cu, cv, wFace(cu)), [...front, ...back], toW(cu, cv, wBack(cu, cv)));

  // ---- glint: diagonal stripe clipped to the lens outline (inset), a thin plate standing proud of the face
  const gIn = G.glintInset + bevel;
  let poly = inset(gIn).reverse(); // clipHalf works with either orientation for convex polygons
  const s2 = Math.SQRT2 * G.glintHalfW;
  // |(u - off) + v| <= halfW*sqrt2
  poly = clipHalf(poly, 1, 1, G.glintOffset + s2);
  poly = clipHalf(poly, -1, -1, -(G.glintOffset - s2));
  poly = densify(poly, 0.005);
  const gc = poly.reduce((a, p) => [a[0] + p[0] / poly.length, a[1] + p[1] / poly.length], [0, 0]);
  const gScale = (t) => poly.map(([u, v]) => [gc[0] + (u - gc[0]) * t, gc[1] + (v - gc[1]) * t]);
  const top = 0.003, bot = -0.003;
  const gRings = [];
  for (const t of [0.5, 1]) gRings.push(gScale(t).map(([u, v]) => toW(u, v, wFace(u) + top)));
  for (const t of [1, 0.5]) gRings.push(gScale(t).map(([u, v]) => toW(u, v, wFace(u) + bot)));
  const glint = ringStack(toW(gc[0], gc[1], wFace(gc[0]) + top), gRings, toW(gc[0], gc[1], wFace(gc[0]) + bot));
  return { lens, glint };
}
