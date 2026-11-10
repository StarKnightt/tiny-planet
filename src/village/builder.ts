// Geometry accumulator for the village: every part is transformed into world space, gets a baked
// vertex colour (base colour x fake ambient occlusion x low-frequency noise) and a per-vertex glow
// attribute (rgb = emissive colour * intensity, w = local sun height below which it switches on),
// and is merged into one BufferGeometry so the whole village is a handful of draw calls.
import * as THREE from 'three';
import { simplex3 } from '../core/noise';

const _p = new THREE.Vector3();
const _n = new THREE.Vector3();
const _w = new THREE.Vector3();
const _c = new THREE.Color();
const _m = new THREE.Matrix4();
const _nm = new THREE.Matrix3();
const _wn = new THREE.Matrix3();
const _q = new THREE.Quaternion();
const _e = new THREE.Euler();
const _s = new THREE.Vector3();
const _v = new THREE.Vector3();

export type ColorSrc = THREE.Color | ((p: THREE.Vector3, n: THREE.Vector3) => THREE.Color);
export type V3 = [number, number, number];
export type Glow = [number, number, number, number];
export const NO_GLOW: Glow = [0, 0, 0, 0];

/** sRGB hex -> linear Color (three's colour management converts on set). */
export const col = (hex: number | string) => new THREE.Color(hex);
/** Colour with brightness multiplier. */
export const shade = (c: THREE.Color, k: number) => c.clone().multiplyScalar(k);
export const mixc = (a: THREE.Color, b: THREE.Color, t: number) => a.clone().lerp(b, t);

/** Translation / rotation (XYZ euler, radians) / scale matrix. */
export function M(pos: V3 = [0, 0, 0], rot: V3 = [0, 0, 0], scale: V3 = [1, 1, 1]): THREE.Matrix4 {
  _e.set(rot[0], rot[1], rot[2]);
  _q.setFromEuler(_e);
  return new THREE.Matrix4().compose(_v.set(pos[0], pos[1], pos[2]), _q, _s.set(scale[0], scale[1], scale[2]));
}

export class MeshBuilder {
  pos: number[] = [];
  nor: number[] = [];
  col: number[] = [];
  glw: number[] = [];
  idx: number[] = [];
  /** local -> world */
  world = new THREE.Matrix4();
  private stack: THREE.Matrix4[] = [new THREE.Matrix4()];
  /** Optional deformation in local space (applied after colour/AO is evaluated). */
  deform: ((p: THREE.Vector3) => void) | null = null;
  /** Fake ambient occlusion in local space. */
  ao: ((p: THREE.Vector3, n: THREE.Vector3) => number) | null = null;
  glow: Glow = NO_GLOW;
  /** Amount of low-frequency brightness noise (world space). */
  variation = 0.08;
  noiseScale = 0.9;

  push(m: THREE.Matrix4) {
    this.stack.push(this.top().clone().multiply(m));
  }
  pop() {
    this.stack.pop();
  }
  top() {
    return this.stack[this.stack.length - 1];
  }
  /** Reset per-object state. */
  begin(world: THREE.Matrix4, ao: MeshBuilder['ao'] = null, deform: MeshBuilder['deform'] = null) {
    this.world.copy(world);
    this.stack = [new THREE.Matrix4()];
    this.ao = ao;
    this.deform = deform;
    this.glow = NO_GLOW;
  }

  add(geo: THREE.BufferGeometry, m: THREE.Matrix4, color: ColorSrc) {
    const local = _m.multiplyMatrices(this.top(), m);
    _nm.getNormalMatrix(local);
    _wn.getNormalMatrix(this.world);
    const flip = local.determinant() * this.world.determinant() < 0;
    const P = geo.attributes.position as THREE.BufferAttribute;
    const N = geo.attributes.normal as THREE.BufferAttribute;
    const base = this.pos.length / 3;
    const g = this.glow;
    for (let i = 0; i < P.count; i++) {
      _p.fromBufferAttribute(P, i).applyMatrix4(local);
      _n.fromBufferAttribute(N, i).applyMatrix3(_nm).normalize();
      if (typeof color === 'function') _c.copy(color(_p, _n));
      else _c.copy(color);
      let k = this.ao ? this.ao(_p, _n) : 1;
      if (this.deform) this.deform(_p);
      _w.copy(_p).applyMatrix4(this.world);
      const s = this.noiseScale;
      k *= 1 + this.variation * simplex3(_w.x * s, _w.y * s, _w.z * s);
      this.pos.push(_w.x, _w.y, _w.z);
      _n.applyMatrix3(_wn).normalize();
      this.nor.push(_n.x, _n.y, _n.z);
      this.col.push(_c.r * k, _c.g * k, _c.b * k);
      this.glw.push(g[0], g[1], g[2], g[3]);
    }
    if (geo.index) {
      const I = geo.index.array;
      for (let i = 0; i < I.length; i += 3) {
        if (flip) this.idx.push(base + I[i], base + I[i + 2], base + I[i + 1]);
        else this.idx.push(base + I[i], base + I[i + 1], base + I[i + 2]);
      }
    } else {
      for (let i = 0; i < P.count; i += 3) {
        if (flip) this.idx.push(base + i, base + i + 2, base + i + 1);
        else this.idx.push(base + i, base + i + 1, base + i + 2);
      }
    }
  }

  get triangles() {
    return this.idx.length / 3;
  }

  build(): THREE.BufferGeometry {
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(this.pos, 3));
    geo.setAttribute('normal', new THREE.Float32BufferAttribute(this.nor, 3));
    geo.setAttribute('color', new THREE.Float32BufferAttribute(this.col, 3));
    geo.setAttribute('aGlow', new THREE.Float32BufferAttribute(this.glw, 4));
    geo.setIndex(this.idx);
    geo.computeBoundingSphere();
    geo.computeBoundingBox();
    return geo;
  }

  // ---------------------------------------------------------------- primitives
  box(size: V3, pos: V3, color: ColorSrc, rot: V3 = [0, 0, 0], segY = 1) {
    this.add(unitBox(segY), M(pos, rot, size), color);
  }
  /** Cylinder / frustum along local Y, centred at pos. */
  cyl(rTop: number, rBot: number, h: number, pos: V3, color: ColorSrc, seg = 12, rot: V3 = [0, 0, 0]) {
    const r = Math.max(rTop, rBot);
    this.add(unitCyl(rTop / r, rBot / r, seg), M(pos, rot, [r, h, r]), color);
  }
  blob(size: V3, pos: V3, color: ColorSrc, detail = 1, rot: V3 = [0, 0, 0]) {
    this.add(unitIco(detail), M(pos, rot, size), color);
  }
  /** Box spanning from a to b (local coords), with cross-section w x h; `up` hint picks the h axis. */
  beam(a: THREE.Vector3, b: THREE.Vector3, w: number, h: number, color: ColorSrc, up = new THREE.Vector3(0, 1, 0)) {
    const x = b.clone().sub(a);
    const len = x.length();
    x.divideScalar(len);
    const z = new THREE.Vector3().crossVectors(x, up);
    if (z.lengthSq() < 1e-6) z.set(0, 0, 1);
    z.normalize();
    const y = new THREE.Vector3().crossVectors(z, x).normalize();
    const m = new THREE.Matrix4().makeBasis(x, y, z);
    m.scale(new THREE.Vector3(len, h, w));
    m.setPosition(a.clone().add(b).multiplyScalar(0.5));
    this.add(unitBox(1), m, color);
  }
}

// ---------------------------------------------------------------- cached unit geometries
const boxCache = new Map<number, THREE.BufferGeometry>();
export function unitBox(segY = 1) {
  let g = boxCache.get(segY);
  if (!g) boxCache.set(segY, (g = new THREE.BoxGeometry(1, 1, 1, 1, segY, 1)));
  return g;
}
const cylCache = new Map<string, THREE.BufferGeometry>();
export function unitCyl(rt: number, rb: number, seg: number) {
  const k = `${rt.toFixed(3)}:${rb.toFixed(3)}:${seg}`;
  let g = cylCache.get(k);
  if (!g) cylCache.set(k, (g = new THREE.CylinderGeometry(rt, rb, 1, seg)));
  return g;
}
const icoCache = new Map<number, THREE.BufferGeometry>();
export function unitIco(detail: number) {
  let g = icoCache.get(detail);
  if (!g) {
    g = new THREE.IcosahedronGeometry(1, detail);
    g.computeVertexNormals();
    icoCache.set(detail, g);
  }
  return g;
}

/**
 * Surface of revolution around local Y. profile = [r, y] points; normals point to the right of the
 * direction of travel in the (r, y) plane: go UP the outside, INWARD across tops, DOWN the inside.
 * smooth: average normals at shared profile points (else hard edge between profile segments).
 */
export function lathe(profile: [number, number][], seg = 16, smooth = true, phase = 0): THREE.BufferGeometry {
  const segN: [number, number][] = [];
  for (let i = 0; i < profile.length - 1; i++) {
    const dr = profile[i + 1][0] - profile[i][0];
    const dy = profile[i + 1][1] - profile[i][1];
    const l = Math.hypot(dr, dy) || 1;
    segN.push([dy / l, -dr / l]);
  }
  const pos: number[] = [];
  const nor: number[] = [];
  const ptN = (i: number, s: number): [number, number] => {
    if (!smooth) return segN[s];
    const a = segN[Math.max(0, i - 1)];
    const b = segN[Math.min(segN.length - 1, i)];
    const n: [number, number] = i === 0 ? segN[0] : i === profile.length - 1 ? segN[segN.length - 1] : [a[0] + b[0], a[1] + b[1]];
    // don't smooth across sharp corners
    if (a[0] * b[0] + a[1] * b[1] < 0.5) return segN[s];
    const l = Math.hypot(n[0], n[1]) || 1;
    return [n[0] / l, n[1] / l];
  };
  for (let s = 0; s < profile.length - 1; s++) {
    const [r0, y0] = profile[s];
    const [r1, y1] = profile[s + 1];
    if (Math.abs(r0 - r1) < 1e-6 && Math.abs(y0 - y1) < 1e-6) continue;
    const n0 = ptN(s, s);
    const n1 = ptN(s + 1, s);
    for (let k = 0; k < seg; k++) {
      const a0 = (k / seg) * Math.PI * 2 + phase;
      const a1 = ((k + 1) / seg) * Math.PI * 2 + phase;
      const P = (r: number, y: number, a: number) => [r * Math.sin(a), y, r * Math.cos(a)];
      const N = (n: [number, number], a: number) => [n[0] * Math.sin(a), n[1], n[0] * Math.cos(a)];
      const v = [P(r0, y0, a0), P(r0, y0, a1), P(r1, y1, a1), P(r1, y1, a0)];
      const nn = [N(n0, a0), N(n0, a1), N(n1, a1), N(n1, a0)];
      // orient: triangle normal must agree with the intended normal
      const am = (a0 + a1) / 2;
      const want = [segN[s][0] * Math.sin(am), segN[s][1], segN[s][0] * Math.cos(am)];
      const tri = (i: number, j: number, l: number) => {
        const ux = v[j][0] - v[i][0], uy = v[j][1] - v[i][1], uz = v[j][2] - v[i][2];
        const wx = v[l][0] - v[i][0], wy = v[l][1] - v[i][1], wz = v[l][2] - v[i][2];
        const cx = uy * wz - uz * wy, cy = uz * wx - ux * wz, cz = ux * wy - uy * wx;
        if (cx * cx + cy * cy + cz * cz < 1e-12) return;
        const order = cx * want[0] + cy * want[1] + cz * want[2] >= 0 ? [i, j, l] : [i, l, j];
        for (const o of order) {
          pos.push(...v[o]);
          nor.push(...nn[o]);
        }
      };
      tri(0, 1, 2);
      tri(0, 2, 3);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
  return g;
}

/** Non-indexed geometry with flat normals from a flat list of triangle vertices. */
export function flatTris(v: number[]): THREE.BufferGeometry {
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(v, 3));
  g.computeVertexNormals();
  return g;
}

/** Triangular prism along X (length), triangle in the ZY plane with base `span` at y=0 and apex `rise`. */
export function gablePrism(length: number, span: number, rise: number): THREE.BufferGeometry {
  const x0 = -length / 2, x1 = length / 2, z = span / 2;
  const A = (x: number) => [x, 0, -z];
  const B = (x: number) => [x, 0, z];
  const C = (x: number) => [x, rise, 0];
  const t: number[] = [];
  const q = (a: number[], b: number[], c: number[], d: number[]) => t.push(...a, ...b, ...c, ...a, ...c, ...d);
  t.push(...A(x1), ...C(x1), ...B(x1)); // +X gable  (CCW seen from +X)
  t.push(...A(x0), ...B(x0), ...C(x0)); // -X gable
  q(B(x0), B(x1), C(x1), C(x0)); // +Z slope
  q(A(x1), A(x0), C(x0), C(x1)); // -Z slope
  return flatTris(t);
}
