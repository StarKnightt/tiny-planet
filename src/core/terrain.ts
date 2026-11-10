// The single source of truth for the shape of the planet.
// Every system (terrain mesh, ocean, grass, trees, village, player) samples this.
import * as THREE from 'three';
import { fbm3, simplex3 } from './noise';

/** Sea-level radius of the planet, in world units (1 unit ~ 1 metre, the player is ~1.7 tall). */
export const R = 60;
/** Terrain heights are relative to sea level: h < 0 is under water. Range is about [-7, +10]. */
export const MAX_HEIGHT = 10.5;
export const MIN_HEIGHT = -7;

const v = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z).normalize();

/** Unit directions from the planet centre to each landmark. */
export const LANDMARKS = {
  /** Centre of the flat village green (plateau radius ~13 units flat, blends out by ~20). */
  village: v(0, -0.12, 1),
  /** Rocky cape on the south coast; flat top of radius ~4.5 units at height 5. */
  lighthouse: v(0.13, -0.5, 0.86),
  /** Round hill west of the village; flat top of radius ~2.2 units at height 8.5. */
  windmill: v(-0.36, 0.08, 0.93),
  /** Centre of the pine forest (east of the village), radius ~28 units. */
  forest: v(0.78, 0.32, 0.54),
  /** Centre of the open rolling grass hills (west). */
  hills: v(-0.82, 0.22, 0.52),
  /** Where the player starts: on the village green edge, facing the village. */
  spawn: v(-0.06, -0.26, 0.96),
} as const;

export const VILLAGE_HEIGHT = 2.2;
export const WINDMILL_HEIGHT = 8.5;
export const LIGHTHOUSE_HEIGHT = 5.0;

interface Blob { d: THREE.Vector3; r: number }
const BLOBS: Blob[] = [
  { d: v(0, 0.15, 1), r: 0.66 }, // village continent
  { d: LANDMARKS.forest, r: 0.62 },
  { d: LANDMARKS.hills, r: 0.68 },
  { d: v(-0.1, 0.95, 0.3), r: 0.5 }, // northern highlands
  { d: LANDMARKS.lighthouse, r: 0.2 }, // the cape
  { d: v(0.2, -0.25, -1), r: 0.3 }, // far-side islands
  { d: v(-0.75, -0.5, -0.45), r: 0.22 },
  { d: v(0.9, -0.35, -0.35), r: 0.2 },
  { d: v(0.3, 0.6, -0.75), r: 0.16 },
];

const clamp01 = (x: number) => (x < 0 ? 0 : x > 1 ? 1 : x);
export const smoothstep = (a: number, b: number, x: number) => {
  const t = clamp01((x - a) / (b - a));
  return t * t * (3 - 2 * t);
};
const angle = (x: number, y: number, z: number, d: THREE.Vector3) =>
  Math.acos(Math.max(-1, Math.min(1, x * d.x + y * d.y + z * d.z)));

/** > 0 on land, < 0 in the sea, ~0 at the coastline. Roughly "fraction of the way inland". */
function landMask(x: number, y: number, z: number): number {
  const k = 7;
  let sum = 0;
  for (const b of BLOBS) sum += Math.exp(k * (1 - angle(x, y, z, b.d) / b.r));
  let c = Math.log(sum) / k;
  c += 0.16 * fbm3(x * 2.1, y * 2.1, z * 2.1, 3) + 0.05 * simplex3(x * 6.5, y * 6.5, z * 6.5);
  return c;
}

/**
 * Terrain height above sea level along unit direction (x, y, z).
 * Smooth and continuous. Negative = seabed.
 */
export function heightAtXYZ(x: number, y: number, z: number): number {
  const c = landMask(x, y, z);
  let h: number;
  if (c < 0) {
    h = -7 * (1 - Math.exp(c * 1.9));
  } else {
    const inland = smoothstep(0.1, 0.45, c);
    const roll = fbm3(x * 3.3 + 5, y * 3.3, z * 3.3, 4) * 0.5 + 0.5;
    const hillBoost = 1 + 0.7 * smoothstep(0.75, 0.2, angle(x, y, z, LANDMARKS.hills));
    h = 0.85 * smoothstep(0, 0.13, c) + 2.6 * smoothstep(0.08, 0.5, c) + roll * roll * 6.2 * inland * hillBoost * 0.75;
    h += 0.25 * simplex3(x * 11, y * 11, z * 11) * inland;
  }

  // Village green: flatten.
  const av = angle(x, y, z, LANDMARKS.village);
  if (av < 0.36) {
    const w = smoothstep(0.36, 0.2, av);
    h = h + (VILLAGE_HEIGHT + 0.25 * simplex3(x * 5, y * 5, z * 5) - h) * w;
  }
  // Windmill hill: a round knoll with a flat top.
  const aw = angle(x, y, z, LANDMARKS.windmill);
  if (aw < 0.3) {
    h += 4.5 * Math.exp(-(aw * aw) / (0.1 * 0.1)) * smoothstep(0.3, 0.2, aw);
    const w = smoothstep(0.075, 0.035, aw);
    h = h + (WINDMILL_HEIGHT - h) * w;
  }
  // Lighthouse cape: a small rocky table.
  const al = angle(x, y, z, LANDMARKS.lighthouse);
  if (al < 0.135) {
    const w = smoothstep(0.135, 0.075, al);
    h = h + (LIGHTHOUSE_HEIGHT - h) * w;
  }
  return h;
}

/** Terrain height above sea level along a unit direction. */
export function heightAt(dir: THREE.Vector3): number {
  return heightAtXYZ(dir.x, dir.y, dir.z);
}

/** World position of the ground (or seabed) along `dir` (need not be normalised). `lift` raises it. */
export function surfacePoint(dir: THREE.Vector3, out = new THREE.Vector3(), lift = 0): THREE.Vector3 {
  out.copy(dir).normalize();
  return out.multiplyScalar(R + heightAt(out) + lift);
}

const _t1 = new THREE.Vector3();
const _t2 = new THREE.Vector3();
const _p0 = new THREE.Vector3();
const _p1 = new THREE.Vector3();
const _p2 = new THREE.Vector3();

/** Any stable tangent frame at `dir`: `east` and `north` are unit, perpendicular to dir. north points toward +Y. */
export function tangentFrame(dir: THREE.Vector3, east = new THREE.Vector3(), north = new THREE.Vector3()) {
  const up = Math.abs(dir.y) > 0.999 ? _t1.set(1, 0, 0) : _t1.set(0, 1, 0);
  east.crossVectors(up, dir).normalize();
  north.crossVectors(dir, east).normalize();
  return { east, north };
}

/** Geometric terrain normal at unit direction `dir` (finite differences, eps in world units). */
export function normalAt(dir: THREE.Vector3, out = new THREE.Vector3(), eps = 0.35): THREE.Vector3 {
  const e = new THREE.Vector3();
  const n = new THREE.Vector3();
  tangentFrame(dir, e, n);
  const a = eps / R;
  surfacePoint(dir, _p0);
  surfacePoint(_t2.copy(dir).addScaledVector(e, a), _p1);
  surfacePoint(_t2.copy(dir).addScaledVector(n, a), _p2);
  _p1.sub(_p0);
  _p2.sub(_p0);
  return out.crossVectors(_p1, _p2).normalize();
}

/** 0 = flat, 1 = vertical. */
export function slopeAt(dir: THREE.Vector3): number {
  const n = normalAt(dir, _t2.clone());
  return 1 - Math.max(0, n.dot(dir));
}

export interface Biome {
  /** height above sea level */
  h: number;
  /** 0..1 dry sand beach */
  sand: number;
  /** 0..1 pine forest density */
  forest: number;
  /** 0..1 inside the village green (1 in the flat core) */
  village: number;
  /** 0..1 how much tall swaying grass belongs here (0 on sand, in the village core, under dense forest, on rock) */
  grass: number;
  /** 0..1 bare rock (lighthouse cape, steep slopes) */
  rock: number;
}

/** Biome weights at a unit direction. Use this to decide what to place / how to colour. */
export function biomeAt(dir: THREE.Vector3): Biome {
  const { x, y, z } = dir;
  const h = heightAt(dir);
  const av = angle(x, y, z, LANDMARKS.village);
  const village = smoothstep(0.34, 0.22, av);
  const al = angle(x, y, z, LANDMARKS.lighthouse);
  const af = angle(x, y, z, LANDMARKS.forest);
  const fn = fbm3(x * 4 + 9, y * 4, z * 4, 2);
  let forest = smoothstep(0.52, 0.3, af + fn * 0.12) * smoothstep(1.3, 2.2, h) * (1 - village);
  // a few stray copses elsewhere
  forest = Math.max(forest, smoothstep(0.45, 0.7, fbm3(x * 2.6 - 3, y * 2.6 + 7, z * 2.6, 2)) * smoothstep(2, 3.5, h) * (1 - village) * 0.7);
  const aw = angle(x, y, z, LANDMARKS.windmill);
  forest *= smoothstep(0.1, 0.2, aw);
  const sand = 1 - smoothstep(0.75, 1.25, h + 0.25 * simplex3(x * 9, y * 9, z * 9));
  const slope = slopeAt(dir);
  const rock = Math.max(smoothstep(0.13, 0.06, al) * smoothstep(0.5, 1.5, h), smoothstep(0.22, 0.38, slope));
  let grass = (1 - sand) * (1 - rock) * (1 - 0.75 * forest) * (1 - 0.85 * village) * (h > 0.9 ? 1 : 0);
  grass *= smoothstep(0.05, 0.085, aw); // keep the windmill's flat top clear
  return { h, sand: h > 0 ? sand : 0, forest, village, grass: clamp01(grass), rock };
}

/**
 * Walk from `from` toward `toward` along the great circle and return the first unit direction
 * where the terrain height crosses `level` (default: the waterline). Handy for piers / boats.
 */
export function findCoast(from: THREE.Vector3, toward: THREE.Vector3, level = 0, out = new THREE.Vector3()): THREE.Vector3 {
  const a = from.clone().normalize();
  const b = toward.clone().normalize();
  const total = a.angleTo(b);
  const axis = new THREE.Vector3().crossVectors(a, b).normalize();
  const start = heightAt(a) > level;
  for (let t = 0; t <= total; t += 0.004) {
    out.copy(a).applyAxisAngle(axis, t);
    if (heightAt(out) > level !== start) return out;
  }
  return out.copy(b);
}

const _m = new THREE.Matrix4();
const _e = new THREE.Vector3();
const _n = new THREE.Vector3();
const _f = new THREE.Vector3();
const _r = new THREE.Vector3();

/**
 * Quaternion that stands an object upright on the planet at `dir`: local +Y = away from the centre,
 * local -Z (three's "forward") = heading `yaw` radians clockwise from north when seen from above.
 */
export function uprightQuaternion(dir: THREE.Vector3, yaw = 0, out = new THREE.Quaternion()): THREE.Quaternion {
  const up = _t2.copy(dir).normalize();
  tangentFrame(up, _e, _n);
  _f.copy(_n).multiplyScalar(Math.cos(yaw)).addScaledVector(_e, Math.sin(yaw)); // forward
  _r.crossVectors(_f, up).normalize(); // right (+X)
  _m.makeBasis(_r, up, _f.clone().negate());
  return out.setFromRotationMatrix(_m);
}

/** Place `obj` on the ground at `dir`, upright, facing `yaw`. `sink` pushes it into the ground a little. */
export function placeOnSurface(obj: THREE.Object3D, dir: THREE.Vector3, yaw = 0, sink = 0): void {
  surfacePoint(dir, obj.position, -sink);
  uprightQuaternion(dir, yaw, obj.quaternion);
}

/** Unit direction reached by walking `east`/`north` world units from `dir` (small offsets; exact enough < 30 units). */
export function offsetDir(dir: THREE.Vector3, east: number, north: number, out = new THREE.Vector3()): THREE.Vector3 {
  const e = new THREE.Vector3();
  const n = new THREE.Vector3();
  tangentFrame(dir, e, n);
  return out.copy(dir).multiplyScalar(R).addScaledVector(e, east).addScaledVector(n, north).normalize();
}
