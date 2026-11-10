// The 20-second fly-in used for the video (tools/capture.mjs) and for `?cinematic=1`.
//
// One continuous move: space -> through the clouds -> low over the south-west sea -> up the beach and
// across the rolling hills -> past the windmill -> a slow near-hover just north of the village, looking
// south across the roofs to the lighthouse while the sun sets behind it (sun azimuth ~168 deg).
//
// Everything is a pure function of t. Every channel is a C2 cubic spline in TIME through the keyframes
// below (so the camera passes each keyframe exactly at its time, with continuous velocity AND
// acceleration). The start is clamped to zero velocity (ease in from rest) and the end to a small drift.
//
// TUNING: edit the two tables. Positions are given on a flat "village map": east/north in world units
// (metres along the surface) from the village centre - the same frame as `offsetDir(LANDMARKS.village, e, n)`.
// Handy map coordinates (east, north):
//   village (0, 0)   spawn (-4, -9)   lighthouse (8, -24)   windmill (-22, 12)   hills (-60, 20)
//   forest (57, 28)  south coast y ~ -28 for x in -70..-20   west coast x ~ -96
// After editing, run `node tools/capture.mjs --check` (numeric smoothness/clearance report) and
// `node tools/shot.mjs --name cine --cine 0 --cine 4 ...` to look at frames.
import * as THREE from 'three';
import type { Ctx } from './core/context';
import { LANDMARKS, R, heightAtXYZ, tangentFrame } from './core/terrain';

export const DURATION = 20;

/** Look target: a map point `lift` units above the ground (or the sea), or the planet centre. */
type Look = readonly [east: number, north: number, lift: number] | 'centre';

/**
 * Camera keyframes.
 *   t      seconds
 *   e, n   camera ground position on the village map (world units east / north of the village centre)
 *   alt    altitude above the ground (or the sea surface) at that point. Space: ~R+alt = distance from centre.
 *   look   what the camera looks at
 *   fov    vertical field of view, degrees
 */
const CAMERA_KEYS: { t: number; e: number; n: number; alt: number; look: Look; fov: number }[] = [
  // 1. space: the whole planet, day side + terminator, drifting slowly in
  { t: 0.0, e: -32, n: -38, alt: 190, look: 'centre', fov: 40 },
  { t: 3.8, e: -37, n: -44, alt: 150, look: [-40, -20, 0], fov: 43 },
  // 2. dive through the cloud layer (clouds orbit at R+20..R+30)
  //    It threads between two clouds (map (-46, -46) base R+25 and (-35, -47) base R+22.4), close enough
  //    that they rush past both sides of the frame. Flying straight through one is a white-out of ~0.6 s:
  //    too long. `node tools/lib/clouds-near.mjs --t 6.9 --e -40 --n -52` lists the clouds near a point.
  { t: 6.2, e: -40, n: -58, alt: 31, look: [-41, -12, 2], fov: 54 },
  { t: 7.2, e: -40.5, n: -56, alt: 14, look: [-41, -16, 2], fov: 57 },
  // 3. low over the sea, the beach, the rolling hills, past the windmill
  { t: 8.4, e: -42, n: -46, alt: 6.5, look: [-41, -16, 2], fov: 58 },
  { t: 9.6, e: -45, n: -30, alt: 6.5, look: [-36, 0, 3], fov: 58 },
  { t: 11.2, e: -42, n: -9, alt: 8, look: [-20.5, 5.3, 8], fov: 57 },
  { t: 12.8, e: -37, n: 1, alt: 10, look: [-21, 12, 8], fov: 55 },
  { t: 14.4, e: -25, n: 3, alt: 13, look: [-6, 7, 4], fov: 53 },
  // 4. swing round north of the village and look south across the roofs at the lighthouse, with the sun
  //    setting right behind it (the ring of houses sits ~6-16 units from the centre: stay above roof height)
  { t: 16.2, e: -12.5, n: 12, alt: 13, look: [0, 0, 3], fov: 51 },
  { t: 18.2, e: -3.5, n: 12.5, alt: 11.5, look: [3, -7, 3], fov: 49 },
  { t: 20.0, e: -0.5, n: 10.5, alt: 10.8, look: [4, -10, 3.5], fov: 48.2 },
];

/**
 * Sun keyframes, as seen from the village centre.
 *   elev  sun elevation in degrees at the village (sin(elev) = dot(villageDir, sunDir)).
 *         Village window lights ramp on as sin(elev) falls from +0.06 (3.4 deg) to -0.20 (-11.5 deg).
 *   az    sun azimuth at the village, degrees clockwise from north (90 = east, 180 = south).
 */
const SUN_KEYS: { t: number; elev: number; az: number }[] = [
  { t: 0, elev: 26, az: 166 },
  { t: 9, elev: 26, az: 167 },
  { t: 14, elev: 25, az: 168 },
  { t: 16, elev: 15, az: 168 },
  { t: 18, elev: 3, az: 168 },
  { t: 20, elev: -6, az: 168 },
];

/** Minimum height of the camera above the ground / sea (world units). Enforced smoothly along the whole path. */
export const MIN_CLEARANCE = 3;
/** Altitude band over which "up" blends from SPACE_UP (above) to the local planet up (below). */
const UP_BLEND = [130, 30] as const;
/** Banking into turns: degrees of roll per unit/s^2 of sideways acceleration, and the cap. */
const BANK_GAIN = 0.9;
const BANK_MAX = 5;
/** End velocity as a fraction of the last segment's average velocity (0 = stop dead, 1 = no slow-down). */
const END_DRIFT = 0.22;
/** Gaussian sigma (seconds) of the speed smoothing (see `warp`). Larger = more even, weightier motion. */
const SPEED_SMOOTHING = 0.6;
/** Gaussian sigma (seconds) applied to the interpolated keyframe channels: rounds off the keys (C2+). */
const SHAPE_SMOOTHING = 0.3;
/** Seconds over which the camera eases in from rest at the start. */
const EASE_IN = 1.5;

// ---------------------------------------------------------------------------------------------
// C2 cubic spline in time (multi-channel). Slopes solved so the 2nd derivative is continuous.
// ---------------------------------------------------------------------------------------------
type End = 'natural' | { slope: number[] };

class Spline {
  readonly t: number[];
  readonly y: number[][];
  readonly m: number[][];
  constructor(t: number[], y: number[][], start: End, end: End, slopes?: number[][]) {
    const n = t.length;
    const dims = y[0].length;
    this.t = t;
    this.y = y;
    this.m = slopes ?? [];
    for (let d = 0; d < dims && !slopes; d++) {
      const a = new Float64Array(n), b = new Float64Array(n), c = new Float64Array(n), r = new Float64Array(n);
      for (let i = 0; i < n; i++) {
        if (i === 0) {
          if (start === 'natural') {
            const h = t[1] - t[0];
            b[0] = 2 / h; c[0] = 1 / h; r[0] = (3 * (y[1][d] - y[0][d])) / (h * h);
          } else { b[0] = 1; r[0] = start.slope[d]; }
        } else if (i === n - 1) {
          if (end === 'natural') {
            const h = t[i] - t[i - 1];
            a[i] = 1 / h; b[i] = 2 / h; r[i] = (3 * (y[i][d] - y[i - 1][d])) / (h * h);
          } else { b[i] = 1; r[i] = end.slope[d]; }
        } else {
          const h0 = t[i] - t[i - 1], h1 = t[i + 1] - t[i];
          a[i] = 1 / h0; b[i] = 2 / h0 + 2 / h1; c[i] = 1 / h1;
          r[i] = 3 * ((y[i][d] - y[i - 1][d]) / (h0 * h0) + (y[i + 1][d] - y[i][d]) / (h1 * h1));
        }
      }
      // Thomas algorithm
      for (let i = 1; i < n; i++) {
        const w = a[i] / b[i - 1];
        b[i] -= w * c[i - 1];
        r[i] -= w * r[i - 1];
      }
      const m = new Array<number>(n);
      m[n - 1] = r[n - 1] / b[n - 1];
      for (let i = n - 2; i >= 0; i--) m[i] = (r[i] - c[i] * m[i + 1]) / b[i];
      for (let i = 0; i < n; i++) (this.m[i] ??= [])[d] = m[i];
    }
  }
  /** Value at time t (clamped to the key range) into out[]. */
  at(time: number, out: number[]): number[] {
    const { t, y, m } = this;
    const n = t.length;
    const tt = Math.min(Math.max(time, t[0]), t[n - 1]);
    let i = 0;
    while (i < n - 2 && tt > t[i + 1]) i++;
    const h = t[i + 1] - t[i];
    const s = (tt - t[i]) / h, s2 = s * s, s3 = s2 * s;
    const h00 = 2 * s3 - 3 * s2 + 1, h10 = s3 - 2 * s2 + s, h01 = -2 * s3 + 3 * s2, h11 = s3 - s2;
    for (let d = 0; d < y[0].length; d++) out[d] = h00 * y[i][d] + h10 * h * m[i][d] + h01 * y[i + 1][d] + h11 * h * m[i + 1][d];
    return out;
  }
}

/**
 * Monotone (Steffen) cubic Hermite through the keys: never overshoots a key in any channel (so the camera
 * never climbs before a dive or swings past a look target). Zero slope at the start, `drift` x the last
 * secant slope at the end (the slow final drift). It is C1; the table smoothing below makes it C2+.
 */
function monotoneSpline(t: number[], y: number[][], drift: number): Spline {
  const n = t.length;
  const m: number[][] = [];
  for (let i = 0; i < n; i++) {
    m[i] = y[i].map((v, d) => {
      if (i === 0) return 0;
      const h0 = t[i] - t[i - 1];
      const s0 = (v - y[i - 1][d]) / h0;
      if (i === n - 1) return drift * s0;
      const h1 = t[i + 1] - t[i];
      const s1 = (y[i + 1][d] - v) / h1;
      const p = (s0 * h1 + s1 * h0) / (h0 + h1);
      return (Math.sign(s0) + Math.sign(s1)) * Math.min(Math.abs(s0), Math.abs(s1), 0.5 * Math.abs(p));
    });
  }
  return new Spline(t, y, 'natural', 'natural', m);
}

// ---------------------------------------------------------------------------------------------
// Map helpers
// ---------------------------------------------------------------------------------------------
const VILLAGE = LANDMARKS.village.clone();
const { east: V_EAST, north: V_NORTH } = tangentFrame(VILLAGE, new THREE.Vector3(), new THREE.Vector3());

/** Unit direction of the map point (east, north): walk that far along the great circle from the village. */
function mapDir(e: number, n: number, out = new THREE.Vector3()): THREE.Vector3 {
  const dist = Math.hypot(e, n);
  if (dist < 1e-9) return out.copy(VILLAGE);
  const a = dist / R;
  out.copy(V_EAST).multiplyScalar(e / dist).addScaledVector(V_NORTH, n / dist); // heading
  return out.multiplyScalar(Math.sin(a)).addScaledVector(VILLAGE, Math.cos(a)).normalize();
}
const groundAt = (d: THREE.Vector3) => Math.max(heightAtXYZ(d.x, d.y, d.z), 0);

/** "Up" used in space: map-north at the starting point, so the planet is framed with the village continent at
 *  the top. As the camera comes down and pitches up to the horizon it blends into the local planet up. */
const SPACE_UP = (() => {
  const k = CAMERA_KEYS[0];
  const a = mapDir(k.e, k.n);
  return mapDir(k.e, k.n + 1).sub(a).normalize();
})();

// ---------------------------------------------------------------------------------------------
// Build the splines
// ---------------------------------------------------------------------------------------------
/**
 * Camera channels, keyed in table time:
 *   0..2  direction xyz (normalised after evaluation)
 *   3     ln(altitude above sea level). Direction and radius are interpolated separately, so the path arcs
 *         around the planet instead of cutting through it; log-altitude makes the dive decelerate in
 *         proportion to height (constant "felt" speed).
 *   4..6  look target xyz
 *   7     fov
 * Interpolated with the monotone spline, tabulated at TAB_DT and gaussian-smoothed (sigma SHAPE_SMOOTHING)
 * so every channel is C2+ with no corners at the keys; evaluated with Catmull-Rom on the table.
 */
const CH = 8;
const TAB_DT = 1 / 120;
const TAB_N = Math.round(DURATION / TAB_DT) + 1;
const camTable = (() => {
  const times = CAMERA_KEYS.map((k) => k.t);
  const sp = monotoneSpline(
    times,
    CAMERA_KEYS.map((k) => {
      const d = mapDir(k.e, k.n);
      let look = [0, 0, 0];
      if (k.look !== 'centre') {
        const ld = mapDir(k.look[0], k.look[1]);
        const r = R + groundAt(ld) + k.look[2];
        look = [ld.x * r, ld.y * r, ld.z * r];
      }
      return [d.x, d.y, d.z, Math.log(groundAt(d) + k.alt), look[0], look[1], look[2], k.fov];
    }),
    END_DRIFT,
  );
  const raw: Float64Array[] = Array.from({ length: CH }, () => new Float64Array(TAB_N));
  const v = new Array<number>(CH);
  for (let i = 0; i < TAB_N; i++) {
    sp.at(i * TAB_DT, v);
    for (let c = 0; c < CH; c++) raw[c][i] = v[c];
  }
  return raw.map((ch) => gaussianSmooth(ch, SHAPE_SMOOTHING / TAB_DT));
})();
/** All camera channels at table time tau. */
function channelsAt(tau: number, out: number[]): number[] {
  const x = Math.min(Math.max(tau / TAB_DT, 0), TAB_N - 1);
  const i = Math.min(Math.floor(x), TAB_N - 2);
  for (let c = 0; c < CH; c++) out[c] = catmullRom(camTable[c], i, x - i);
  return out;
}
const sunSpline = new Spline(
  SUN_KEYS.map((k) => k.t),
  SUN_KEYS.map((k) => [k.elev, k.az]),
  'natural',
  'natural',
);

// Ground clearance: the highest ground/sea within a few units of the path, widened over +/-0.5 s and smoothed,
// precomputed on a table so the floor is a smooth function of t. The camera radius is then a smooth max of
// the spline radius and that floor, so it can never dip into a hill but never bumps either.
const FLOOR_DT = 1 / 30;
const FLOOR_N = Math.round(DURATION / FLOOR_DT) + 1;
const floorTable = (() => {
  const raw = new Float64Array(FLOOR_N);
  const tmp = new Array<number>(CH);
  const d = new THREE.Vector3(), e = new THREE.Vector3(), n = new THREE.Vector3(), p = new THREE.Vector3();
  for (let i = 0; i < FLOOR_N; i++) {
    channelsAt(i * FLOOR_DT, tmp);
    d.set(tmp[0], tmp[1], tmp[2]).normalize();
    tangentFrame(d, e, n);
    let g = 0.6; // sea + wave crests
    for (let k = 0; k < 9; k++) {
      const a = (k / 8) * Math.PI * 2;
      const rr = k === 8 ? 0 : 4 / R;
      p.copy(d).addScaledVector(e, Math.cos(a) * rr).addScaledVector(n, Math.sin(a) * rr).normalize();
      g = Math.max(g, heightAtXYZ(p.x, p.y, p.z));
    }
    raw[i] = g;
  }
  const W = Math.round(0.5 / FLOOR_DT);
  const out = new Float64Array(FLOOR_N);
  for (let i = 0; i < FLOOR_N; i++) {
    let m = -Infinity;
    for (let j = Math.max(0, i - W); j <= Math.min(FLOOR_N - 1, i + W); j++) m = Math.max(m, raw[j]);
    out[i] = m;
  }
  return gaussianSmooth(out, 0.25 / FLOOR_DT, false);
})();
/**
 * Gaussian blur of a table (sigma in samples). `pointReflect` mirrors through the end values, which keeps the
 * end values and end slopes; otherwise the ends are clamped.
 */
function gaussianSmooth(x: Float64Array, sigma: number, pointReflect = true): Float64Array {
  const n = x.length;
  const K = Math.ceil(3 * sigma);
  const kern = Array.from({ length: 2 * K + 1 }, (_, j) => Math.exp(-((j - K) ** 2) / (2 * sigma * sigma)));
  const ksum = kern.reduce((a, b) => a + b, 0);
  const at = (k: number) => {
    if (k >= 0 && k < n) return x[k];
    if (!pointReflect) return x[k < 0 ? 0 : n - 1];
    return k < 0 ? 2 * x[0] - x[Math.min(-k, n - 1)] : 2 * x[n - 1] - x[Math.max(2 * (n - 1) - k, 0)];
  };
  const out = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    let s = 0;
    for (let j = -K; j <= K; j++) s += kern[j + K] * at(i + j);
    out[i] = s / ksum;
  }
  return out;
}
/** Smoothed ground height under the path at time t (Catmull-Rom on the table, C1). */
function floorAt(t: number): number {
  const x = Math.min(Math.max(t / FLOOR_DT, 0), FLOOR_N - 1);
  const i = Math.min(Math.floor(x), FLOOR_N - 2);
  return catmullRom(floorTable, i, x - i);
}
/** Uniform Catmull-Rom between T[i] and T[i+1]; linear extrapolation past the ends (no end kinks). */
function catmullRom(T: Float64Array, i: number, s: number): number {
  const n = T.length;
  const p1 = T[i], p2 = T[i + 1];
  const p0 = i > 0 ? T[i - 1] : 2 * p1 - p2;
  const p3 = i + 2 < n ? T[i + 2] : 2 * p2 - p1;
  return 0.5 * (2 * p1 + (-p0 + p2) * s + (2 * p0 - 5 * p1 + 4 * p2 - p3) * s * s + (-p0 + 3 * p1 - 3 * p2 + p3) * s * s * s);
}
const smoothMax = (a: number, b: number, k: number) => 0.5 * (a + b + Math.sqrt((a - b) * (a - b) + k * k));
const smooth01 = (a: number, b: number, x: number) => {
  const s = Math.min(Math.max((x - a) / (b - a), 0), 1);
  return s * s * s * (s * (s * 6 - 15) + 10); // smootherstep: C2
};

// ---------------------------------------------------------------------------------------------
// Evaluation
// ---------------------------------------------------------------------------------------------
const _c = new Array<number>(CH).fill(0);
const _d = new THREE.Vector3();

/** Position on the keyframed path at raw (key) time tau, before speed smoothing. */
function rawPosition(tau: number, out: THREE.Vector3): THREE.Vector3 {
  channelsAt(tau, _c);
  _d.set(_c[0], _c[1], _c[2]).normalize();
  const alt = smoothMax(Math.exp(_c[3]), floorAt(tau) + MIN_CLEARANCE, 1.5);
  return out.copy(_d).multiplyScalar(R + alt);
}

// Speed smoothing. An interpolating spline through hand-placed keys always has some surge in its speed
// (it speeds up and slows down between keys whose spacing is not perfectly even). So the path is re-timed:
// the raw speed |dp/dtau| is gaussian-smoothed in time, eased in from rest over the first EASE_IN seconds,
// integrated, scaled back to the same total length, and the camera then follows the SAME path (and the same
// look/fov channels) through the warped time tau = warp(t). Keys are therefore reached within a few tenths
// of a second of their table time (the check reports how far off each one is).
const WARP_DT = 1 / 120;
const WARP_N = Math.round(DURATION / WARP_DT) + 1;
const warpTable = (() => {
  const p0 = new THREE.Vector3(), p1 = new THREE.Vector3();
  const S = new Float64Array(WARP_N); // raw arc length at tau_i
  rawPosition(0, p0);
  for (let i = 1; i < WARP_N; i++) {
    rawPosition(i * WARP_DT, p1);
    S[i] = S[i - 1] + p1.distanceTo(p0);
    p0.copy(p1);
  }
  const v = new Float64Array(WARP_N);
  for (let i = 0; i < WARP_N; i++) v[i] = (S[Math.min(i + 1, WARP_N - 1)] - S[Math.max(i - 1, 0)]) / (WARP_DT * (i === 0 || i === WARP_N - 1 ? 1 : 2));
  // point reflection at the ends keeps the slow final drift instead of averaging it up; the start is then
  // eased in from rest
  const vs = gaussianSmooth(v, SPEED_SMOOTHING / WARP_DT);
  for (let i = 0; i < WARP_N; i++) vs[i] = Math.max(vs[i], 0) * smooth01(0, EASE_IN, i * WARP_DT);
  const Ss = new Float64Array(WARP_N);
  for (let i = 1; i < WARP_N; i++) Ss[i] = Ss[i - 1] + 0.5 * (vs[i] + vs[i - 1]) * WARP_DT;
  const scale = S[WARP_N - 1] / Ss[WARP_N - 1];
  // invert: tau such that S(tau) = scale * Ss(t)
  const W = new Float64Array(WARP_N);
  let j = 0;
  for (let i = 0; i < WARP_N; i++) {
    const target = Ss[i] * scale;
    while (j < WARP_N - 2 && S[j + 1] < target) j++;
    const span = S[j + 1] - S[j];
    const f = span > 1e-12 ? Math.min(Math.max((target - S[j]) / span, 0), 1) : 0;
    W[i] = (j + f) * WARP_DT;
  }
  W[WARP_N - 1] = DURATION;
  // the piecewise-linear inverse has tiny slope kinks at the table nodes: blur them away (point reflection at
  // the ends keeps W(0) = 0, W(T) = T and the end slopes)
  return gaussianSmooth(W, 3);
})();

/** Warped key time for film time t (Catmull-Rom on the table: C1, monotone in practice). */
export function warp(t: number): number {
  const x = Math.min(Math.max(t / WARP_DT, 0), WARP_N - 1);
  const i = Math.min(Math.floor(x), WARP_N - 2);
  const s = x - i;
  return catmullRom(warpTable, i, x - i);
}

/** Camera position at film time t (world). */
export function cameraPosition(t: number, out = new THREE.Vector3()): THREE.Vector3 {
  return rawPosition(warp(t), out);
}

/** Sun direction at time t. */
export function sunDirection(t: number, out = new THREE.Vector3()): THREE.Vector3 {
  sunSpline.at(t, _c);
  const el = THREE.MathUtils.degToRad(_c[0]);
  const az = THREE.MathUtils.degToRad(_c[1]);
  const h = Math.cos(el);
  return out
    .copy(VILLAGE)
    .multiplyScalar(Math.sin(el))
    .addScaledVector(V_NORTH, h * Math.cos(az))
    .addScaledVector(V_EAST, h * Math.sin(az))
    .normalize();
}


const _p = new THREE.Vector3(), _q = new THREE.Vector3(), _r = new THREE.Vector3();
const _acc = new THREE.Vector3();
const _look = new THREE.Vector3(), _up = new THREE.Vector3(), _f = new THREE.Vector3(), _x = new THREE.Vector3(), _y = new THREE.Vector3();
const _nf = new THREE.Vector3();
const _m = new THREE.Matrix4();
const _rollQ = new THREE.Quaternion();
const _zAxis = new THREE.Vector3(0, 0, 1);
const _ch = new Array<number>(CH).fill(0);

/** Low-pass filtered acceleration at t (central differences, gaussian window +/-0.45 s). Pure in t. */
function smoothAccel(t: number, out: THREE.Vector3): THREE.Vector3 {
  const h = 0.15;
  out.set(0, 0, 0);
  let wsum = 0;
  for (let k = -3; k <= 3; k++) {
    const tc = Math.min(Math.max(t + k * 0.15, h), DURATION - h);
    const w = Math.exp(-(k * k) / 4.5);
    cameraPosition(tc - h, _p);
    cameraPosition(tc + h, _q);
    cameraPosition(tc, _r);
    out.addScaledVector(_p.add(_q).addScaledVector(_r, -2), w / (h * h));
    wsum += w;
  }
  return out.multiplyScalar(1 / wsum);
}

export interface CameraState {
  position: THREE.Vector3;
  quaternion: THREE.Quaternion;
  fov: number;
  /** blended up vector before banking */
  up: THREE.Vector3;
  /** |forward x up| - near 0 would mean a look-at singularity */
  upMargin: number;
  bankDeg: number;
  /** altitude above the ground/sea directly below */
  clearance: number;
}

/** Full camera state at time t. Pure. */
export function cameraState(t: number, s: CameraState): CameraState {
  const tau = warp(t);
  rawPosition(tau, s.position);
  channelsAt(tau, _ch);
  _look.set(_ch[4], _ch[5], _ch[6]);
  s.fov = _ch[7];

  const radial = _q.copy(s.position).normalize();
  const altSea = s.position.length() - R;
  const w = smooth01(UP_BLEND[0], UP_BLEND[1], altSea);
  _up.copy(SPACE_UP).multiplyScalar(1 - w).addScaledVector(radial, w).normalize();
  s.up.copy(_up);

  _f.subVectors(_look, s.position).normalize();
  _x.crossVectors(_f, _up);
  s.upMargin = _x.length();
  _x.normalize();
  _y.crossVectors(_x, _f);
  _m.makeBasis(_x, _y, _nf.copy(_f).negate());
  s.quaternion.setFromRotationMatrix(_m);

  // bank into turns (only when low, where there is a horizon to bank against)
  smoothAccel(t, _acc);
  const lateral = _acc.dot(_x);
  const bank = BANK_MAX * Math.tanh((lateral * BANK_GAIN) / BANK_MAX) * w; // soft cap: no kink in roll rate
  s.bankDeg = bank;
  _rollQ.setFromAxisAngle(_zAxis, THREE.MathUtils.degToRad(-bank));
  s.quaternion.multiply(_rollQ);

  _d.copy(s.position).normalize();
  s.clearance = altSea - groundAt(_d);
  return s;
}

const _state: CameraState = {
  position: new THREE.Vector3(),
  quaternion: new THREE.Quaternion(),
  fov: 50,
  up: new THREE.Vector3(),
  upMargin: 1,
  bankDeg: 0,
  clearance: 0,
};

/** Set ctx.camera and ctx.sunDir for cinematic time t (0..DURATION). Pure function of t. */
export function applyCinematic(t: number, ctx: Ctx): void {
  const s = cameraState(t, _state);
  const cam = ctx.camera;
  cam.position.copy(s.position);
  cam.quaternion.copy(s.quaternion);
  cam.up.copy(s.up);
  if (cam.fov !== s.fov) {
    cam.fov = s.fov;
    cam.updateProjectionMatrix();
  }
  cam.updateMatrixWorld();
  sunDirection(t, ctx.sunDir);
}

// ---------------------------------------------------------------------------------------------
// Self-check: sample the path and report clearance, speed, acceleration, jerk, angular velocity.
// Used by `node tools/capture.mjs --check` and before every capture.
// ---------------------------------------------------------------------------------------------
export interface CinematicReport {
  ok: boolean;
  problems: string[];
  minClearance: { value: number; t: number };
  liftEngaged: [number, number][];
  maxSpeed: { value: number; t: number };
  maxAccel: { value: number; t: number };
  maxJerk: { value: number; t: number };
  maxAngVelDeg: { value: number; t: number };
  maxAngAccelDeg: { value: number; t: number };
  maxFovRate: { value: number; t: number };
  minUpMargin: { value: number; t: number };
  maxBankDeg: number;
  startSpeed: number;
  endSpeed: number;
  endAngVelDeg: number;
  /** per whole second: [t, speed u/s, angular velocity deg/s, altitude above sea, clearance] */
  profile: number[][];
  sun: { t: number; villageSunH: number; elevDeg: number }[];
  startDistance: number;
  /** [key time in the table, film time at which the camera actually reaches it after speed smoothing] */
  keyArrival: [number, number][];
}

export function checkCinematic(step = 1 / 240): CinematicReport {
  const N = Math.round(DURATION / step);
  const mk = (): CameraState => ({ position: new THREE.Vector3(), quaternion: new THREE.Quaternion(), fov: 0, up: new THREE.Vector3(), upMargin: 1, bankDeg: 0, clearance: 0 });
  const pos: THREE.Vector3[] = [];
  const quat: THREE.Quaternion[] = [];
  const fov: number[] = [];
  const st = mk();
  const rep: CinematicReport = {
    ok: true,
    problems: [],
    minClearance: { value: Infinity, t: 0 },
    liftEngaged: [],
    maxSpeed: { value: 0, t: 0 },
    maxAccel: { value: 0, t: 0 },
    maxJerk: { value: 0, t: 0 },
    maxAngVelDeg: { value: 0, t: 0 },
    maxAngAccelDeg: { value: 0, t: 0 },
    maxFovRate: { value: 0, t: 0 },
    minUpMargin: { value: Infinity, t: 0 },
    maxBankDeg: 0,
    startSpeed: 0,
    endSpeed: 0,
    endAngVelDeg: 0,
    profile: [],
    sun: [],
    startDistance: 0,
    keyArrival: [],
  };
  const bump = (o: { value: number; t: number }, v: number, t: number) => {
    if (v > o.value) { o.value = v; o.t = t; }
  };
  let liftStart = -1;
  const tmp = new Array<number>(CH).fill(0);
  for (let i = 0; i <= N; i++) {
    const t = i * step;
    cameraState(t, st);
    pos.push(st.position.clone());
    quat.push(st.quaternion.clone());
    fov.push(st.fov);
    if (st.clearance < rep.minClearance.value) rep.minClearance = { value: st.clearance, t };
    if (st.upMargin < rep.minUpMargin.value) rep.minUpMargin = { value: st.upMargin, t };
    rep.maxBankDeg = Math.max(rep.maxBankDeg, Math.abs(st.bankDeg));
    channelsAt(warp(t), tmp);
    const lifted = st.position.length() - R - Math.exp(tmp[3]) > 0.25;
    if (lifted && liftStart < 0) liftStart = t;
    if (!lifted && liftStart >= 0) { rep.liftEngaged.push([+liftStart.toFixed(2), +t.toFixed(2)]); liftStart = -1; }
  }
  if (liftStart >= 0) rep.liftEngaged.push([+liftStart.toFixed(2), DURATION]);
  rep.startDistance = pos[0].length();
  for (const k of CAMERA_KEYS) {
    let i = 0;
    while (i < N && warp(i * step) < k.t) i++;
    rep.keyArrival.push([k.t, +(i * step).toFixed(2)]);
  }

  const vel: THREE.Vector3[] = [];
  const angVel: number[] = [];
  for (let i = 0; i < N; i++) {
    vel.push(pos[i + 1].clone().sub(pos[i]).divideScalar(step));
    const dq = Math.min(1, Math.abs(quat[i].dot(quat[i + 1])));
    angVel.push(THREE.MathUtils.radToDeg(2 * Math.acos(dq)) / step);
  }
  const acc: THREE.Vector3[] = [];
  for (let i = 0; i < vel.length - 1; i++) acc.push(vel[i + 1].clone().sub(vel[i]).divideScalar(step));
  for (let i = 0; i < vel.length; i++) {
    const t = (i + 0.5) * step;
    bump(rep.maxSpeed, vel[i].length(), t);
    bump(rep.maxFovRate, Math.abs(fov[i + 1] - fov[i]) / step, t);
    bump(rep.maxAngVelDeg, angVel[i], t);
    if (i > 0) bump(rep.maxAngAccelDeg, Math.abs(angVel[i] - angVel[i - 1]) / step, t);
  }
  for (let i = 0; i < acc.length; i++) {
    bump(rep.maxAccel, acc[i].length(), (i + 1) * step);
    if (i > 0) bump(rep.maxJerk, acc[i].clone().sub(acc[i - 1]).length() / step, (i + 1) * step);
  }
  rep.startSpeed = vel[0].length();
  rep.endSpeed = vel[vel.length - 1].length();
  rep.endAngVelDeg = angVel[angVel.length - 1];
  for (let s = 0; s <= DURATION; s += 0.5) {
    const i = Math.min(Math.round(s / step), N - 1);
    const d = pos[i].clone().normalize();
    rep.profile.push([s, +vel[i].length().toFixed(2), +angVel[i].toFixed(1), +(pos[i].length() - R).toFixed(1), +(pos[i].length() - R - groundAt(d)).toFixed(1)]);
  }
  for (let s = 0; s <= DURATION; s += 2) {
    const sd = sunDirection(s, new THREE.Vector3());
    const h = sd.dot(VILLAGE);
    rep.sun.push({ t: s, villageSunH: +h.toFixed(3), elevDeg: +THREE.MathUtils.radToDeg(Math.asin(h)).toFixed(1) });
  }

  // Thresholds. Tuned so a visible jerk / pop / snap trips them; a smooth sweeping path does not.
  const P = rep.problems;
  if (rep.minClearance.value < MIN_CLEARANCE - 0.05) P.push(`clearance ${rep.minClearance.value.toFixed(2)} < ${MIN_CLEARANCE} at t=${rep.minClearance.t.toFixed(2)}`);
  if (rep.startDistance < 225 || rep.startDistance > 265) P.push(`start distance ${rep.startDistance.toFixed(1)} not in 230..260`);
  if (rep.startSpeed > 0.5) P.push(`start is not at rest: ${rep.startSpeed.toFixed(2)} u/s`);
  if (rep.endSpeed > 1.5) P.push(`end drift too fast: ${rep.endSpeed.toFixed(2)} u/s`);
  if (rep.endAngVelDeg > 2) P.push(`end still turning: ${rep.endAngVelDeg.toFixed(2)} deg/s`);
  if (rep.maxAngVelDeg.value > 40) P.push(`fast rotation ${rep.maxAngVelDeg.value.toFixed(1)} deg/s at t=${rep.maxAngVelDeg.t.toFixed(2)}`);
  if (rep.maxAngAccelDeg.value > 60) P.push(`rotation jerk: angular accel ${rep.maxAngAccelDeg.value.toFixed(0)} deg/s^2 at t=${rep.maxAngAccelDeg.t.toFixed(2)}`);
  if (rep.maxJerk.value > 400) P.push(`positional jerk ${rep.maxJerk.value.toFixed(0)} u/s^3 at t=${rep.maxJerk.t.toFixed(2)}`);
  if (rep.minUpMargin.value < 0.25) P.push(`look direction nearly parallel to up (${rep.minUpMargin.value.toFixed(3)}) at t=${rep.minUpMargin.t.toFixed(2)}`);
  const endH = rep.sun[rep.sun.length - 1].villageSunH;
  if (endH > -0.08 || endH < -0.16) P.push(`village sun height at the end ${endH} (want about -0.12)`);
  rep.ok = P.length === 0;
  return rep;
}
