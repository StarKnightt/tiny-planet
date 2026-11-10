// Building blocks for the village. Everything is authored in a local frame: +Y up, origin on the
// ground, +Z = the "front" (door side / facing the square). Units are metres.
import * as THREE from 'three';
import { col, gablePrism, lathe, M, MeshBuilder, mixc, NO_GLOW, shade, type ColorSrc, type Glow, type V3 } from './builder';

export const PAL = {
  walls: [0xf4e4c4, 0xf3c6a4, 0xbfd5e2, 0xf4dd98, 0xf0cbc2, 0xd4e0bc].map(col),
  roofs: [0xc0573a, 0x3f8c88, 0x6c6190, 0xa9493a, 0x4c7d9e, 0xb8653c].map(col),
  frame: col(0xf7f1e6),
  wood: col(0x7a5236),
  woodLight: col(0xa77b52),
  timber: col(0x4f3627),
  shutters: [0x6f9a6a, 0x4f7fa6, 0xb5503f, 0xd2a23d, 0x7d6aa0].map(col),
  doors: [0x6b4429, 0x3f6f8a, 0x9a3b2f, 0x4d7a52, 0x5a4a7a].map(col),
  stone: col(0xa79f92),
  stoneDark: col(0x857d72),
  brick: col(0xa0563f),
  glass: col(0x2a3644),
  iron: col(0x2c302e),
  soil: col(0x5b4030),
  leaf: col(0x5f9440),
  leafDark: col(0x3f6e33),
  flowers: [0xe8577a, 0xf2c94c, 0xf7f3f0, 0xd9434b, 0xb87ad9, 0xf39a4a].map(col),
  canvas: col(0xf1e8d4),
  red: col(0xc9443a),
  white: col(0xf5f1ea),
};

export type Rand = () => number;
export const pick = <T>(r: Rand, a: T[]): T => a[Math.floor(r() * a.length) % a.length];
const ss = (a: number, b: number, x: number) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

/** Warm window light: rgb * intensity, switch-on threshold on local sun height. ~12% stay dark. */
export function windowGlow(r: Rand, darkChance = 0.12): Glow {
  if (r() < darkChance) return NO_GLOW;
  const t = r();
  const c = new THREE.Color(1.0, 0.36 + 0.16 * t, 0.07 + 0.08 * t);
  const k = 2.0 + r() * 1.3;
  const thr = -0.13 + r() * 0.17;
  return [c.r * k, c.g * k, c.b * k, thr];
}
export function lampGlow(r: Rand, k = 4.2): Glow {
  return [1.0 * k, 0.55 * k, 0.2 * k, 0.03 + r() * 0.03];
}

/** Fake AO for a building whose walls run from y0 to y1. */
export function houseAO(y0: number, y1: number) {
  return (p: THREE.Vector3, n: THREE.Vector3) => {
    let k = 0.58 + 0.42 * ss(y0 - 0.6, y0 + 1.3, p.y);
    if (Math.abs(n.y) < 0.6) k *= 1 - 0.3 * ss(y1 - 0.75, y1 + 0.05, p.y) * ss(y1 + 0.6, y1 + 0.1, p.y);
    if (n.y < -0.5) k *= 0.62;
    return k;
  };
}
/** Fake AO for small props on the ground. */
export const propAO = (p: THREE.Vector3, n: THREE.Vector3) => (0.62 + 0.38 * ss(-0.05, 0.6, p.y)) * (n.y < -0.5 ? 0.7 : 1);

// ------------------------------------------------------------------------------------------ window
export interface WindowOpts {
  w?: number;
  h?: number;
  frame?: THREE.Color;
  shutter?: THREE.Color | null;
  flowers?: boolean;
  glow: Glow;
  r: Rand;
}
/** Window centred at the local origin on a wall surface facing +Z. */
export function addWindow(b: MeshBuilder, o: WindowOpts) {
  const w = o.w ?? 0.8, h = o.h ?? 0.95;
  const fr = o.frame ?? PAL.frame;
  // glass (recessed) — the glowing part
  b.glow = o.glow;
  b.box([w, h, 0.08], [0, 0, 0.0], (p) => mixc(PAL.glass, col(0x5d7690), 0.25 + 0.5 * ss(-h / 2, h / 2, p.y)));
  b.glow = NO_GLOW;
  // frame
  const t = 0.11, dz = 0.07;
  b.box([w + 2 * t, t, 0.14], [0, h / 2 + t / 2, dz], fr);
  b.box([w + 2 * t, t, 0.14], [0, -h / 2 - t / 2, dz], fr);
  b.box([t, h, 0.14], [-w / 2 - t / 2, 0, dz], fr);
  b.box([t, h, 0.14], [w / 2 + t / 2, 0, dz], fr);
  // muntins
  b.box([0.05, h, 0.06], [0, 0, 0.06], fr);
  b.box([w, 0.05, 0.06], [0, h * 0.08, 0.06], fr);
  // sill
  b.box([w + 0.42, 0.08, 0.26], [0, -h / 2 - t - 0.03, 0.12], shade(fr, 0.92));
  // shutters
  if (o.shutter) {
    const sw = w * 0.5;
    for (const s of [-1, 1]) {
      const x = s * (w / 2 + t + sw / 2 + 0.02);
      b.box([sw, h + 0.12, 0.06], [x, 0, 0.04], o.shutter);
      // two slats lines
      for (const y of [-h * 0.22, h * 0.22]) b.box([sw * 0.8, 0.05, 0.03], [x, y, 0.08], shade(o.shutter, 0.8));
    }
  }
  if (o.flowers) flowerBox(b, w + 0.25, [0, -h / 2 - t - 0.25, 0.2], o.r);
}

export function flowerBox(b: MeshBuilder, w: number, pos: V3, r: Rand) {
  const [x, y, z] = pos;
  b.box([w, 0.22, 0.26], [x, y, z], PAL.wood);
  b.box([w - 0.06, 0.04, 0.2], [x, y + 0.11, z], PAL.soil);
  const n = Math.round(w / 0.17);
  const fc = pick(r, PAL.flowers);
  const fc2 = pick(r, PAL.flowers);
  for (let i = 0; i < n; i++) {
    const fx = x - w / 2 + 0.1 + (i / (n - 1)) * (w - 0.2);
    b.blob([0.11, 0.09, 0.1], [fx, y + 0.17, z + (r() - 0.5) * 0.08], shade(PAL.leaf, 0.85 + r() * 0.3), 0);
    if (r() < 0.75) b.blob([0.07, 0.06, 0.07], [fx + (r() - 0.5) * 0.06, y + 0.25 + r() * 0.06, z + 0.03], r() < 0.6 ? fc : fc2, 0);
  }
}

// ------------------------------------------------------------------------------------------ roof
/** Gable roof with ridge along local X, tile courses, ridge cap. Origin = middle of the wall tops. */
function roof(b: MeshBuilder, length: number, span: number, pitchDeg: number, roofCol: THREE.Color, gableCol: ColorSrc, r: Rand) {
  const p = THREE.MathUtils.degToRad(pitchDeg);
  const half = span / 2;
  const rise = half * Math.tan(p);
  const ov = 0.42, ovG = 0.32, t = 0.17;
  b.add(gablePrism(length, span, rise), M(), gableCol);
  const slopeLen = (half + ov) / Math.cos(p) + 0.06;
  const rows = 5;
  for (const s of [-1, 1]) {
    const dz = s * Math.cos(p), dy = -Math.sin(p);
    const nz = s * Math.sin(p), ny = Math.cos(p);
    for (let i = 0; i < rows; i++) {
      const a = (i / rows) * slopeLen, c = ((i + 1) / rows) * slopeLen;
      const mid = (a + c) / 2 - 0.03;
      const lift = t / 2 + 0.01 + 0.032 * (rows - 1 - i);
      const k = (i % 2 ? 0.93 : 1.03) * (0.97 + r() * 0.06);
      const cc = shade(roofCol, k);
      // eave row slightly darker underneath via AO; colour gradient toward the ridge
      b.box(
        [length + 2 * ovG, t, (c - a) * 1.12],
        [0, rise + dy * mid + ny * lift, dz * mid + nz * lift],
        (pp, n) => (n.y < -0.3 ? shade(cc, 0.55) : cc),
        [s * p, 0, 0],
      );
    }
  }
  // ridge cap
  b.box([length + 2 * ovG + 0.08, 0.26, 0.26], [0, rise + 0.2, 0], shade(roofCol, 0.72), [Math.PI / 4, 0, 0]);
  return rise;
}

// ------------------------------------------------------------------------------------------ cottage
export interface CottageSpec {
  kind: 0 | 1 | 2 | 3;
  seed: number;
  wall: THREE.Color;
  roof: THREE.Color;
}
export interface CottageInfo {
  /** local chimney top */
  chimney: THREE.Vector3;
  radius: number;
  w: number;
  d: number;
}

/**
 * kind 0: one-storey cottage, ridge along the front, shutters
 * kind 1: tall two-storey timbered house, gable to the front
 * kind 2: long cottage with porch hood, three windows
 * kind 3: gable-front cottage with a round attic window
 */
export function cottage(b: MeshBuilder, spec: CottageSpec, r: Rand): CottageInfo {
  const k = spec.kind;
  const w = [4.3, 3.7, 6.0, 3.9][k] * (0.95 + r() * 0.1);
  const d = [3.5, 3.5, 3.4, 4.3][k] * (0.95 + r() * 0.1);
  const h = [2.5, 4.5, 2.55, 2.7][k];
  const pitch = [50, 56, 46, 53][k] + (r() - 0.5) * 4;
  const base = 0.32;
  const top = base + h;
  const gableFront = k === 1 || k === 3;
  const trim = r() < 0.5 ? PAL.frame : shade(PAL.wood, 1.15);
  const shutter = k === 0 || k === 1 ? pick(r, PAL.shutters) : null;
  const doorCol = pick(r, PAL.doors);
  const wall = spec.wall;
  const timber = k === 1 || (k === 0 && r() < 0.4);

  // plinth & walls
  b.box([w + 0.34, 1.6, d + 0.34], [0, base - 0.8 + 0.02, 0], PAL.stone, [0, 0, 0], 2);
  b.box([w, h, d], [0, base + h / 2, 0], wall, [0, 0, 0], 5);
  if (timber) {
    const tc = PAL.timber;
    for (const sx of [-1, 1])
      for (const sz of [-1, 1]) b.box([0.2, h, 0.2], [sx * (w / 2 - 0.07), base + h / 2, sz * (d / 2 - 0.07)], tc, [0, 0, 0], 4);
    const ys = k === 1 ? [base + 0.08, base + h * 0.5, top - 0.1] : [base + 0.08, top - 0.1];
    for (const y of ys) {
      b.box([w + 0.04, 0.16, 0.16], [0, y, d / 2 + 0.0], tc);
      b.box([w + 0.04, 0.16, 0.16], [0, y, -d / 2 - 0.0], tc);
      b.box([0.16, 0.16, d + 0.04], [w / 2, y, 0], tc);
      b.box([0.16, 0.16, d + 0.04], [-w / 2, y, 0], tc);
    }
    // braces on the side walls
    const y0 = k === 1 ? base + h * 0.5 : base + 0.1;
    for (const sx of [-1, 1])
      for (const sz of [-1, 1]) {
        const x = sx * (w / 2 + 0.03);
        b.beam(new THREE.Vector3(x, y0 + 0.05, sz * (d / 2 - 0.15)), new THREE.Vector3(x, top - 0.15, sz * (d / 2 - 1.0)), 0.13, 0.13, tc, new THREE.Vector3(1, 0, 0));
      }
  }

  // roof
  const gableCol: ColorSrc = timber ? shade(wall, 1.02) : wall;
  b.push(M([0, top, 0], [0, gableFront ? Math.PI / 2 : 0, 0]));
  const rise = roof(b, gableFront ? d : w, gableFront ? w : d, pitch, spec.roof, gableCol, r);
  b.pop();
  if (timber && gableFront) {
    // king post + collar on the front gable
    b.box([0.16, rise * 0.85, 0.12], [0, top + rise * 0.42, d / 2 + 0.03], PAL.timber);
    b.box([w * 0.62, 0.14, 0.12], [0, top + rise * 0.3, d / 2 + 0.03], PAL.timber);
  }

  // chimney (back slope)
  const side = r() < 0.5 ? -1 : 1;
  let cx: number, cz: number;
  if (gableFront) {
    cx = side * w * 0.22;
    cz = -d / 2 + 0.9;
  } else {
    cx = side * (w / 2 - 0.8);
    cz = -d * 0.2;
  }
  const chTop = top + rise + 0.55;
  const chCol = r() < 0.5 ? PAL.brick : PAL.stoneDark;
  b.box([0.62, chTop - top + 0.4, 0.62], [cx, (chTop + top - 0.4) / 2, cz], chCol, [0, 0, 0], 3);
  b.box([0.8, 0.16, 0.8], [cx, chTop + 0.05, cz], shade(chCol, 0.8));
  b.box([0.34, 0.2, 0.34], [cx, chTop + 0.2, cz], shade(PAL.brick, 0.75));

  // faces: [centre, rotY, width]
  const faces: { m: THREE.Matrix4; width: number }[] = [
    { m: M([0, 0, d / 2], [0, 0, 0]), width: w },
    { m: M([w / 2, 0, 0], [0, Math.PI / 2, 0]), width: d },
    { m: M([0, 0, -d / 2], [0, Math.PI, 0]), width: w },
    { m: M([-w / 2, 0, 0], [0, -Math.PI / 2, 0]), width: d },
  ];
  const y1 = base + 1.45;
  const y2 = base + h * 0.5 + 1.25;
  const win = (face: number, u: number, y: number, opts: Partial<WindowOpts> = {}) => {
    b.push(faces[face].m);
    b.push(M([u, y, 0.01]));
    addWindow(b, { frame: trim, shutter, r, glow: windowGlow(r), flowers: face === 0 && r() < 0.55, ...opts });
    b.pop();
    b.pop();
  };

  // door
  const doorU = [-0.85, 0.75 * (side > 0 ? -1 : 1), 0.55, 0][k];
  b.push(faces[0].m);
  {
    const u = doorU;
    b.box([0.9, 1.72, 0.12], [u, base + 0.86, 0.04], (p) => shade(doorCol, 0.9 + 0.1 * Math.sin(p.x * 40)));
    b.glow = windowGlow(r, 0.3);
    b.box([0.32, 0.26, 0.04], [u, base + 1.38, 0.11], PAL.glass);
    b.glow = NO_GLOW;
    b.box([1.14, 0.13, 0.16], [u, base + 1.78, 0.06], trim);
    b.box([0.13, 1.78, 0.16], [u - 0.51, base + 0.89, 0.06], trim);
    b.box([0.13, 1.78, 0.16], [u + 0.51, base + 0.89, 0.06], trim);
    b.blob([0.05, 0.05, 0.05], [u + 0.3, base + 0.85, 0.13], col(0xc9a24a), 0);
    b.box([1.25, 0.32, 0.62], [u, 0.12, 0.3], PAL.stone);
    if (k === 2 || (k === 0 && r() < 0.6)) {
      // little porch hood on brackets
      b.box([1.5, 0.1, 0.75], [u, base + 2.08, 0.34], spec.roof, [0.38, 0, 0]);
      for (const s of [-1, 1]) b.box([0.08, 0.38, 0.08], [u + s * 0.62, base + 1.86, 0.18], PAL.timber, [0.6, 0, 0]);
    }
  }
  b.pop();

  // windows
  if (k === 0) {
    win(0, 0.95, y1);
    win(1, 0, y1);
    win(3, 0, y1);
    win(2, -0.9, y1);
    win(2, 1.1, y1);
  } else if (k === 1) {
    win(0, -doorU * 1.25, y1);
    win(0, -0.85, y2, { flowers: true });
    win(0, 0.85, y2, { flowers: r() < 0.5 });
    win(1, 0, y1);
    win(1, 0, y2);
    win(3, 0.6, y2);
    win(3, -0.6, y1);
    win(2, 0, y2);
  } else if (k === 2) {
    win(0, -1.9, y1);
    win(0, -0.65, y1, { w: 0.65 });
    win(0, 1.8, y1);
    win(1, 0, y1);
    win(3, 0, y1);
    win(2, -1.5, y1);
    win(2, 1.5, y1);
  } else {
    win(0, -1.2, y1, { w: 0.68 });
    win(0, 1.2, y1, { w: 0.68 });
    win(1, -0.9, y1);
    win(1, 0.9, y1);
    win(3, 0, y1);
    win(2, 0, y1);
  }
  // round attic window in the front gable
  if (gableFront) {
    b.push(M([0, top + rise * (k === 1 ? 0.52 : 0.42), d / 2 + 0.02], [Math.PI / 2, 0, 0]));
    b.glow = windowGlow(r, 0.35);
    b.cyl(0.3, 0.3, 0.06, [0, 0.0, 0], PAL.glass, 14);
    b.glow = NO_GLOW;
    b.add(lathe([[0.42, -0.06], [0.42, 0.06], [0.3, 0.06], [0.3, -0.06]], 14, false), M([0, 0.02, 0]), trim);
    b.box([0.6, 0.05, 0.04], [0, 0.07, 0], trim);
    b.box([0.04, 0.05, 0.6], [0, 0.07, 0], trim);
    b.pop();
  }

  return { chimney: new THREE.Vector3(cx, chTop + 0.25, cz), radius: Math.hypot(w, d) * 0.5, w, d };
}

// ------------------------------------------------------------------------------------------ props
/** Street lamp; returns the local position of the lamp head. */
export function streetLamp(b: MeshBuilder, r: Rand): THREE.Vector3 {
  const ir = PAL.iron;
  b.cyl(0.17, 0.22, 0.32, [0, 0.12, 0], PAL.stoneDark, 8);
  b.cyl(0.06, 0.08, 2.5, [0, 1.45, 0], ir, 8);
  b.cyl(0.1, 0.1, 0.1, [0, 0.5, 0], ir, 8);
  b.cyl(0.18, 0.08, 0.12, [0, 2.72, 0], ir, 8);
  // lantern: glowing glass with iron corner posts
  b.glow = lampGlow(r);
  b.box([0.26, 0.36, 0.26], [0, 2.98, 0], col(0xe9d6a0));
  b.glow = NO_GLOW;
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) b.box([0.04, 0.4, 0.04], [sx * 0.14, 2.98, sz * 0.14], ir);
  b.cyl(0.0, 0.27, 0.24, [0, 3.29, 0], ir, 4, [0, Math.PI / 4, 0]);
  b.blob([0.05, 0.05, 0.05], [0, 3.43, 0], ir, 0);
  return new THREE.Vector3(0, 2.98, 0);
}

export function well(b: MeshBuilder, r: Rand) {
  // stone ring
  const prof: [number, number][] = [[1.0, -0.4], [1.02, 0.55], [1.08, 0.62], [1.06, 0.76], [0.74, 0.76], [0.74, 0.6], [0.72, -0.1]];
  b.add(lathe(prof, 18, false), M(), (p, n) => {
    const row = Math.floor((p.y + 0.4) / 0.24);
    const ang = Math.atan2(p.x, p.z) * 18 / Math.PI + row * 1.7;
    const k = 0.92 + 0.12 * Math.sin(ang * 3.1) * Math.sin(row * 2.3 + 1.0);
    return shade(n.y > 0.6 ? col(0xb8b0a2) : PAL.stone, k);
  });
  b.cyl(0.74, 0.74, 0.04, [0, 0.12, 0], col(0x24465a), 18);
  // posts, roof, winch
  for (const s of [-1, 1]) b.box([0.14, 2.0, 0.14], [s * 0.86, 1.4, 0], PAL.wood, [0, 0, 0], 2);
  b.cyl(0.07, 0.07, 1.86, [0, 1.75, 0], PAL.woodLight, 8, [0, 0, Math.PI / 2]);
  b.cyl(0.1, 0.1, 0.4, [0, 1.75, 0], col(0x8a7a5a), 8, [0, 0, Math.PI / 2]);
  b.box([0.04, 0.55, 0.04], [0, 1.45, 0], col(0x8a7a5a));
  b.add(lathe([[0.0, -0.13], [0.14, -0.13], [0.16, 0.13], [0.13, 0.13], [0.12, -0.08], [0, -0.08]], 10, false), M([0, 1.05, 0]), PAL.wood);
  b.push(M([0, 2.4, 0]));
  b.add(gablePrism(1.9, 0.3, 0.05), M(), PAL.wood);
  const p = THREE.MathUtils.degToRad(40);
  for (const s of [-1, 1]) b.box([2.2, 0.09, 1.0], [0, 0.3, s * 0.36], col(0xb75a3c), [s * p, 0, 0]);
  b.box([2.3, 0.14, 0.14], [0, 0.62, 0], shade(col(0xb75a3c), 0.7), [Math.PI / 4, 0, 0]);
  b.pop();
}

export function bench(b: MeshBuilder) {
  const wd = PAL.woodLight;
  b.box([1.5, 0.08, 0.42], [0, 0.46, 0], wd);
  for (const s of [-1, 1]) {
    b.box([0.08, 0.46, 0.38], [s * 0.6, 0.23, 0], PAL.iron);
    b.box([0.08, 0.5, 0.06], [s * 0.6, 0.72, -0.2], PAL.iron, [-0.15, 0, 0]);
  }
  b.box([1.5, 0.08, 0.04], [0, 0.78, -0.22], wd, [-0.15, 0, 0]);
  b.box([1.5, 0.08, 0.04], [0, 0.62, -0.21], wd, [-0.15, 0, 0]);
}

export function barrel(b: MeshBuilder, pos: V3, r: Rand, s = 1) {
  const prof: [number, number][] = [];
  for (let i = 0; i <= 8; i++) {
    const t = i / 8;
    prof.push([(0.3 + 0.06 * Math.sin(t * Math.PI)) * s, t * 0.85 * s]);
  }
  prof.push([0.26 * s, 0.85 * s], [0, 0.85 * s]);
  const wc = shade(PAL.wood, 0.9 + r() * 0.25);
  b.add(lathe(prof, 12, true, r()), M(pos), (p, n) => {
    const y = (p.y - pos[1]) / s;
    if (n.y > 0.7) return shade(wc, 0.85);
    if (Math.abs(y - 0.15) < 0.04 || Math.abs(y - 0.7) < 0.04) return PAL.iron;
    return shade(wc, 0.92 + 0.08 * Math.sin(Math.atan2(p.x - pos[0], p.z - pos[2]) * 12));
  });
  for (const y of [0.15, 0.7]) {
    const rr = (0.3 + 0.06 * Math.sin(y / 0.85 * Math.PI)) * s + 0.012;
    b.cyl(rr, rr, 0.06 * s, [pos[0], pos[1] + y * s, pos[2]], PAL.iron, 12);
  }
}

export function crate(b: MeshBuilder, pos: V3, r: Rand, s = 0.55, rotY = 0) {
  const c = shade(PAL.woodLight, 0.85 + r() * 0.25);
  b.push(M(pos, [0, rotY, 0]));
  b.box([s, s, s], [0, s / 2, 0], c);
  const e = 0.07;
  for (const y of [e / 2, s - e / 2]) {
    b.box([s + 0.02, e, e], [0, y, s / 2], shade(c, 0.75));
    b.box([s + 0.02, e, e], [0, y, -s / 2], shade(c, 0.75));
    b.box([e, e, s + 0.02], [s / 2, y, 0], shade(c, 0.75));
    b.box([e, e, s + 0.02], [-s / 2, y, 0], shade(c, 0.75));
  }
  b.pop();
}

/** Market stall with a striped awning; front = +Z. */
export function marketStall(b: MeshBuilder, r: Rand, stripe: THREE.Color) {
  const w = 2.4, d = 1.2;
  const wd = PAL.woodLight;
  for (const sx of [-1, 1])
    for (const sz of [-1, 1]) b.box([0.1, sz > 0 ? 2.15 : 2.5, 0.1], [sx * (w / 2 - 0.05), (sz > 0 ? 2.15 : 2.5) / 2, sz * (d / 2 - 0.05)], PAL.wood);
  b.box([w, 0.1, d], [0, 0.85, 0], wd);
  b.box([w, 0.75, 0.06], [0, 0.45, d / 2 - 0.08], shade(wd, 0.85), [0, 0, 0], 2);
  // awning stripes, sloping down toward the front
  const n = 8;
  const slope = Math.atan2(0.5, d + 0.6);
  for (let i = 0; i < n; i++) {
    const x = -w / 2 - 0.15 + (i + 0.5) * ((w + 0.3) / n);
    const c = i % 2 ? PAL.canvas : stripe;
    b.box([(w + 0.3) / n + 0.005, 0.05, d + 0.7], [x, 2.38, 0.1], c, [slope, 0, 0]);
    // scalloped valance
    b.box([(w + 0.3) / n - 0.02, 0.22, 0.03], [x, 2.08, d / 2 + 0.44], c);
    b.blob([(w + 0.3) / n / 2 - 0.01, 0.07, 0.02], [x, 1.97, d / 2 + 0.44], c, 0);
  }
  // produce
  const fruit = [0xd23b2f, 0xf09a2a, 0x8bbf3c, 0xe8c64a, 0x7a3a8c].map(col);
  for (let i = 0; i < 3; i++) {
    const x = -0.75 + i * 0.75;
    b.box([0.6, 0.18, 0.45], [x, 0.99, 0.1], shade(PAL.wood, 1.1));
    const fc = fruit[(i + Math.floor(r() * 5)) % 5];
    for (let j = 0; j < 7; j++) b.blob([0.09, 0.09, 0.09], [x - 0.2 + (j % 4) * 0.13 + (r() - 0.5) * 0.03, 1.12 + (j >= 4 ? 0.06 : 0), 0.0 + (j >= 4 ? 0.12 : 0.22) + (r() - 0.5) * 0.04], shade(fc, 0.9 + r() * 0.2), 0);
  }
}

export function signpost(b: MeshBuilder, arrows: { yaw: number; c: THREE.Color }[]) {
  b.box([0.14, 2.3, 0.14], [0, 1.1, 0], PAL.wood, [0, 0, 0], 2);
  b.cyl(0.0, 0.12, 0.16, [0, 2.32, 0], PAL.timber, 4, [0, Math.PI / 4, 0]);
  arrows.forEach((a, i) => {
    b.push(M([0, 1.95 - i * 0.32, 0], [0, a.yaw, 0]));
    b.box([0.85, 0.22, 0.05], [0.5, 0, 0.08], a.c);
    b.box([0.155, 0.155, 0.05], [0.925, 0, 0.08], a.c, [0, 0, Math.PI / 4]);
    b.box([0.5, 0.035, 0.02], [0.45, 0.03, 0.115], PAL.white);
    b.box([0.38, 0.035, 0.02], [0.4, -0.04, 0.115], PAL.white);
    b.pop();
  });
}

export function bush(b: MeshBuilder, pos: V3, r: Rand, s = 1, flowers = true) {
  const n = 3 + Math.floor(r() * 3);
  for (let i = 0; i < n; i++) {
    const a = r() * Math.PI * 2, d = r() * 0.35 * s;
    const sz = (0.35 + r() * 0.25) * s;
    b.blob([sz, sz * 0.85, sz], [pos[0] + Math.cos(a) * d, pos[1] + sz * 0.6, pos[2] + Math.sin(a) * d], (p, nn) => shade(mixc(PAL.leafDark, PAL.leaf, 0.3 + 0.7 * Math.max(0, nn.y)), 0.9 + r() * 0.15), 1);
  }
  if (flowers) {
    const fc = pick(r, PAL.flowers);
    for (let i = 0; i < 6; i++) {
      const a = r() * Math.PI * 2;
      b.blob([0.07, 0.06, 0.07], [pos[0] + Math.cos(a) * 0.45 * s, pos[1] + (0.45 + r() * 0.35) * s, pos[2] + Math.sin(a) * 0.45 * s], fc, 0);
    }
  }
}

export function vegPatch(b: MeshBuilder, w: number, d: number, r: Rand) {
  for (const s of [-1, 1]) {
    b.box([w + 0.12, 0.26, 0.1], [0, 0.1, s * d / 2], PAL.wood);
    b.box([0.1, 0.26, d], [s * w / 2, 0.1, 0], PAL.wood);
  }
  b.box([w, 0.2, d], [0, 0.08, 0], PAL.soil);
  const rows = Math.max(2, Math.round(d / 0.55));
  for (let i = 0; i < rows; i++) {
    const z = -d / 2 + (i + 0.5) * (d / rows);
    const kind = i % 3;
    const n = Math.round(w / 0.42);
    for (let j = 0; j < n; j++) {
      const x = -w / 2 + (j + 0.5) * (w / n);
      if (kind === 0) b.blob([0.17, 0.13, 0.17], [x, 0.24, z], shade(col(0x7fb35a), 0.9 + r() * 0.2), 1);
      else if (kind === 1) {
        b.blob([0.05, 0.05, 0.05], [x, 0.2, z], col(0xe9862e), 0);
        b.blob([0.07, 0.15, 0.07], [x, 0.3, z], PAL.leaf, 0);
      } else b.blob([0.12, 0.2, 0.12], [x, 0.3, z], shade(col(0x4f8a3a), 0.9 + r() * 0.2), 0);
    }
  }
}
