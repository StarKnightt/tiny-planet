// CPU mirror of the terrain's dirt paths (src/systems/terrain.ts: makePaths + tpPaths in GLSL),
// so grass can stay off them. Keep in sync with terrain.ts if the paths change there.
import * as THREE from 'three';
import { LANDMARKS, R } from '../core/terrain';

const fract = (x: number) => x - Math.floor(x);
function tpHash(x: number, y: number, z: number): number {
  x = fract(x * 0.1031); y = fract(y * 0.1031); z = fract(z * 0.1031);
  const d = x * (z + 31.32) + y * (y + 31.32) + z * (x + 31.32);
  x += d; y += d; z += d;
  return fract((x + y) * z);
}
function vnoise(px: number, py: number, pz: number): number {
  const ix = Math.floor(px), iy = Math.floor(py), iz = Math.floor(pz);
  const wx = px - ix, wy = py - iy, wz = pz - iz;
  const ux = wx * wx * (3 - 2 * wx), uy = wy * wy * (3 - 2 * wy), uz = wz * wz * (3 - 2 * wz);
  const L = (a: number, b: number, t: number) => a + (b - a) * t;
  const a = tpHash(ix, iy, iz), b = tpHash(ix + 1, iy, iz), c = tpHash(ix, iy + 1, iz), d = tpHash(ix + 1, iy + 1, iz);
  const e = tpHash(ix, iy, iz + 1), f = tpHash(ix + 1, iy, iz + 1), g = tpHash(ix, iy + 1, iz + 1), h = tpHash(ix + 1, iy + 1, iz + 1);
  return 2 * L(L(L(a, b, ux), L(c, d, ux), uy), L(L(e, f, ux), L(g, h, ux), uy), uz) - 1;
}

function slerpDir(a: THREE.Vector3, b: THREE.Vector3, units: number): THREE.Vector3 {
  const ang = a.angleTo(b);
  const axis = new THREE.Vector3().crossVectors(a, b).normalize();
  return a.clone().applyAxisAngle(axis, Math.min(units / R, ang));
}

interface Path { a: THREE.Vector3; n: THREE.Vector3; c: THREE.Vector3; L: number }
const PATHS: Path[] = (() => {
  const v = LANDMARKS.village;
  const targets = [
    { to: LANDMARKS.lighthouse, endShort: 2.0 },
    { to: LANDMARKS.windmill, endShort: 1.2 },
    { to: LANDMARKS.spawn, endShort: -6 },
  ];
  return targets.map((t) => {
    const a = slerpDir(v, t.to, 4.5);
    const full = v.angleTo(t.to) * R;
    const axis = new THREE.Vector3().crossVectors(v, t.to).normalize();
    const b = v.clone().applyAxisAngle(axis, (full - t.endShort) / R);
    return { a, n: axis.clone(), c: new THREE.Vector3().crossVectors(axis, a), L: a.angleTo(b) };
  });
})();

const ss = (a: number, b: number, x: number) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};
const _pr = new THREE.Vector3();

/** 0..1 dirt-path coverage at unit direction d. `widen` (world units) grows the path's soft edge. */
export function pathAt(d: THREE.Vector3, widen = 0): number {
  let m = 0;
  for (let i = 0; i < PATHS.length; i++) {
    const { a, n, c, L } = PATHS[i];
    const sd = d.dot(n);
    _pr.copy(d).addScaledVector(n, -sd);
    const t = Math.atan2(_pr.dot(c), _pr.dot(a)) / L;
    if (t < -0.05 || t > 1.05) continue;
    const env = ss(0, 0.25, t) * ss(1, 0.8, t);
    const off = (1.5 * Math.sin(t * L * R * 0.17 + i * 2.1) + 1.0 * vnoise(d.x * R * 0.07 + i * 13, d.y * R * 0.07 + i * 13, d.z * R * 0.07 + i * 13)) * env;
    const dist = Math.abs(sd * R - off);
    const tc = Math.min(1, Math.max(0, t));
    const w = 1.25 + (0.8 - 1.25) * tc + 0.22 * vnoise(d.x * R * 0.9 + i * 5, d.y * R * 0.9 + i * 5, d.z * R * 0.9 + i * 5) + widen;
    let e = 1 - ss(w * 0.45, w, dist);
    e *= ss(-0.03, 0.04, t) * ss(1.03, 0.96, t);
    m = Math.max(m, e);
  }
  return m;
}
