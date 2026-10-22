// Small signed-distance-function toolkit used by the kubara model.
// Convention: NEGATIVE inside, POSITIVE outside (classic SDF). The mesher
// (Manifold.levelSet, which wants positive-inside) negates at the call site.
// Everything works on plain numbers to stay allocation-free in hot loops.

export const DEG = Math.PI / 180;

export const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
export const mix = (a, b, t) => a + (b - a) * t;

/** Polynomial smooth minimum (k = blend radius). */
export function smin(a, b, k) {
  if (k <= 0) return a < b ? a : b;
  const h = Math.max(k - Math.abs(a - b), 0) / k;
  return Math.min(a, b) - h * h * k * 0.25;
}
/** Smooth maximum (smooth intersection / subtraction). */
export function smax(a, b, k) {
  return -smin(-a, -b, k);
}

/** Ellipsoid (IQ's bound-improved approximation). Point already local. */
export function sdEllipsoid(x, y, z, rx, ry, rz) {
  const k0 = Math.sqrt((x / rx) ** 2 + (y / ry) ** 2 + (z / rz) ** 2);
  if (k0 < 1e-9) return -Math.min(rx, ry, rz);
  const k1 = Math.sqrt((x / (rx * rx)) ** 2 + (y / (ry * ry)) ** 2 + (z / (rz * rz)) ** 2);
  return (k0 * (k0 - 1)) / k1;
}

/** 2D ellipse (same approximation). */
export function sdEllipse2(x, y, rx, ry) {
  const k0 = Math.sqrt((x / rx) ** 2 + (y / ry) ** 2);
  if (k0 < 1e-9) return -Math.min(rx, ry);
  const k1 = Math.sqrt((x / (rx * rx)) ** 2 + (y / (ry * ry)) ** 2);
  return (k0 * (k0 - 1)) / k1;
}

/** Rounded box, half extents h*, corner radius r. Point already local. */
export function sdRoundBox(x, y, z, hx, hy, hz, r) {
  const qx = Math.abs(x) - hx + r;
  const qy = Math.abs(y) - hy + r;
  const qz = Math.abs(z) - hz + r;
  const ox = Math.max(qx, 0), oy = Math.max(qy, 0), oz = Math.max(qz, 0);
  return Math.sqrt(ox * ox + oy * oy + oz * oz) + Math.min(Math.max(qx, qy, qz), 0) - r;
}

/** Capsule / round cone between a and b with radii ra -> rb (linear taper). */
export function sdCapsule(px, py, pz, a, b, ra, rb = ra) {
  const bax = b[0] - a[0], bay = b[1] - a[1], baz = b[2] - a[2];
  const pax = px - a[0], pay = py - a[1], paz = pz - a[2];
  const h = clamp((pax * bax + pay * bay + paz * baz) / (bax * bax + bay * bay + baz * baz), 0, 1);
  const dx = pax - bax * h, dy = pay - bay * h, dz = paz - baz * h;
  return Math.sqrt(dx * dx + dy * dy + dz * dz) - mix(ra, rb, h);
}

/** Tube along a polyline (array of [x,y,z]) with constant radius. */
export function sdPolyline(px, py, pz, pts, r) {
  let d = Infinity;
  for (let i = 0; i < pts.length - 1; i++) {
    const v = sdCapsule(px, py, pz, pts[i], pts[i + 1], r);
    if (v < d) d = v;
  }
  return d;
}

// ---------------------------------------------------------------- vectors
export const v3 = {
  add: (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]],
  sub: (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]],
  scale: (a, s) => [a[0] * s, a[1] * s, a[2] * s],
  dot: (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2],
  cross: (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]],
  len: (a) => Math.hypot(a[0], a[1], a[2]),
  norm: (a) => {
    const l = Math.hypot(a[0], a[1], a[2]) || 1;
    return [a[0] / l, a[1] / l, a[2] / l];
  },
  lerp: (a, b, t) => [mix(a[0], b[0], t), mix(a[1], b[1], t), mix(a[2], b[2], t)],
  mirrorX: (a) => [-a[0], a[1], a[2]],
};

/**
 * Orthonormal local frame. `toLocal` writes local coords into `out`.
 * Axes given as world vectors (x = right, y = up, z = forward of the frame).
 */
export function makeFrame(origin, xAxis, yAxis, zAxis) {
  const [ox, oy, oz] = origin;
  const [ax, ay, az] = xAxis, [bx, by, bz] = yAxis, [cx, cy, cz] = zAxis;
  return {
    origin, xAxis, yAxis, zAxis,
    toLocal(x, y, z, out) {
      const dx = x - ox, dy = y - oy, dz = z - oz;
      out[0] = dx * ax + dy * ay + dz * az;
      out[1] = dx * bx + dy * by + dz * bz;
      out[2] = dx * cx + dy * cy + dz * cz;
      return out;
    },
    toWorld(l) {
      return [
        ox + l[0] * ax + l[1] * bx + l[2] * cx,
        oy + l[0] * ay + l[1] * by + l[2] * cy,
        oz + l[0] * az + l[1] * bz + l[2] * cz,
      ];
    },
  };
}

/** Frame rotated by yaw (about +Y, positive turns +Z toward +X) then pitch (about local X, positive tips +Z down). */
export function yawPitchFrame(origin, yawDeg, pitchDeg = 0) {
  const cy = Math.cos(yawDeg * DEG), sy = Math.sin(yawDeg * DEG);
  const cp = Math.cos(pitchDeg * DEG), sp = Math.sin(pitchDeg * DEG);
  // forward after yaw: (sy, 0, cy); right: (cy, 0, -sy)
  const right = [cy, 0, -sy];
  const fwd0 = [sy, 0, cy];
  const fwd = [fwd0[0] * cp, -sp, fwd0[2] * cp];
  const up = [fwd0[0] * sp, cp, fwd0[2] * sp];
  return makeFrame(origin, right, up, fwd);
}

/** Central-difference gradient (normalised) of f at p. */
export function gradient(f, x, y, z, e = 5e-4) {
  const gx = f(x + e, y, z) - f(x - e, y, z);
  const gy = f(x, y + e, z) - f(x, y - e, z);
  const gz = f(x, y, z + e) - f(x, y, z - e);
  const l = Math.hypot(gx, gy, gz) || 1;
  return [gx / l, gy / l, gz / l];
}

/**
 * Find the surface of f along the ray origin + t*dir, scanning from tMax down
 * to 0 (first crossing from OUTSIDE). Returns {p, n} or null.
 */
export function raySurface(f, origin, dir, tMax = 0.6, step = 0.004) {
  const at = (t) => f(origin[0] + dir[0] * t, origin[1] + dir[1] * t, origin[2] + dir[2] * t);
  let t1 = tMax, v1 = at(t1);
  if (v1 <= 0) return null;
  for (let t = tMax - step; t >= 0; t -= step) {
    const v = at(t);
    if (v <= 0) {
      let lo = t, hi = t1; // f(lo) <= 0 < f(hi)
      for (let i = 0; i < 40; i++) {
        const m = (lo + hi) / 2;
        if (at(m) <= 0) lo = m; else hi = m;
      }
      const tt = (lo + hi) / 2;
      const p = [origin[0] + dir[0] * tt, origin[1] + dir[1] * tt, origin[2] + dir[2] * tt];
      return { p, n: gradient(f, p[0], p[1], p[2]) };
    }
    t1 = t; v1 = v;
  }
  return null;
}

/** 2D rounded rectangle from signed slab distances a (|u|-hu) and b (|v|-hv), corner radius r. */
export function roundRect(a, b, r) {
  const qa = a + r, qb = b + r;
  const oa = Math.max(qa, 0), ob = Math.max(qb, 0);
  return Math.hypot(oa, ob) + Math.min(Math.max(qa, qb), 0) - r;
}

/** 2D capsule (segment a->b, radius r). */
export function sdSegment2(px, py, ax, ay, bx, by, r) {
  const bax = bx - ax, bay = by - ay, pax = px - ax, pay = py - ay;
  const h = clamp((pax * bax + pay * bay) / (bax * bax + bay * bay), 0, 1);
  return Math.hypot(pax - bax * h, pay - bay * h) - r;
}

/** Centripetal-ish (uniform) Catmull-Rom resampling of a 3D polyline; endpoints kept. */
export function catmullRom(pts, samples = 6) {
  const out = [];
  const P = (i) => pts[Math.max(0, Math.min(pts.length - 1, i))];
  for (let i = 0; i < pts.length - 1; i++) {
    const p0 = P(i - 1), p1 = P(i), p2 = P(i + 1), p3 = P(i + 2);
    for (let k = 0; k < samples; k++) {
      const t = k / samples, t2 = t * t, t3 = t2 * t;
      out.push([0, 1, 2].map((c) => 0.5 * (2 * p1[c] + (-p0[c] + p2[c]) * t + (2 * p0[c] - 5 * p1[c] + 4 * p2[c] - p3[c]) * t2 + (-p0[c] + 3 * p1[c] - 3 * p2[c] + p3[c]) * t3)));
    }
  }
  out.push(pts[pts.length - 1]);
  return out;
}
