// Lighthouse, windmill (tower + rotating sails) and rowing boats. Local frames: +Y up, origin on the
// ground, +Z = front.
import * as THREE from 'three';
import { col, lathe, M, MeshBuilder, NO_GLOW, shade, type Glow } from './builder';
import { addWindow, houseAO, lampGlow, PAL, windowGlow, type Rand } from './parts';

// ------------------------------------------------------------------------------------------ lighthouse
export interface LighthouseInfo {
  lamp: THREE.Vector3; // local
  height: number;
  radius: number;
}

export function lighthouse(b: MeshBuilder, r: Rand): LighthouseInfo {
  const red = col(0xc8473b);
  const white = col(0xf6f2ea);
  const y0 = 0.35;
  const yTop = 13.4;
  const rad = (y: number) => {
    const t = (y - y0) / (yTop - y0);
    return 1.78 - 0.62 * t + 0.1 * t * (1 - t);
  };
  // rock plinth
  b.add(lathe([[2.5, -1.6], [2.45, -0.2], [2.25, 0.3], [2.1, 0.42], [0, 0.42]], 20, false, 0.1), M(), (p, n) => shade(n.y > 0.7 ? col(0xb0a898) : PAL.stoneDark, 0.95 + 0.1 * Math.sin(p.x * 3 + p.z * 5)));
  // banded tower: separate lathes per band so the colour edges are crisp
  const bands = 6;
  for (let i = 0; i < bands; i++) {
    const a = y0 + ((yTop - y0) * i) / bands, c = y0 + ((yTop - y0) * (i + 1)) / bands;
    const prof: [number, number][] = [];
    for (let j = 0; j <= 3; j++) {
      const y = a + ((c - a) * j) / 3;
      prof.push([rad(y), y]);
    }
    b.add(lathe(prof, 24, true), M(), i % 2 ? red : white);
  }
  // door (front, +Z)
  const rz = rad(1.2);
  b.box([0.95, 1.85, 0.4], [0, y0 + 0.92, rz - 0.08], PAL.doors[1]);
  b.box([1.2, 0.14, 0.45], [0, y0 + 1.9, rz - 0.06], PAL.frame);
  for (const s of [-1, 1]) b.box([0.14, 1.95, 0.45], [s * 0.53, y0 + 0.97, rz - 0.06], PAL.frame);
  b.box([1.5, 0.3, 0.7], [0, 0.4, rz + 0.25], PAL.stone);
  // a wall lantern beside the door
  b.glow = lampGlow(r, 3.5);
  b.box([0.2, 0.28, 0.2], [0.85, y0 + 2.1, rz + 0.05], col(0xe9d6a0));
  b.glow = NO_GLOW;
  b.box([0.28, 0.06, 0.28], [0.85, y0 + 2.27, rz + 0.05], PAL.iron);
  // little windows spiralling up
  const wins: [number, number][] = [[4.0, 0.6], [6.4, -0.9], [8.8, 0.35], [11.1, -0.4]];
  for (const [y, a] of wins) {
    b.push(M([0, 0, 0], [0, a, 0]));
    b.push(M([0, y, rad(y) - 0.02], [-0.05, 0, 0]));
    addWindow(b, { w: 0.42, h: 0.62, r, glow: windowGlow(r, 0.0), shutter: null });
    b.pop();
    b.pop();
  }
  // corbel + gallery deck
  b.add(lathe([[rad(yTop) - 0.05, yTop - 0.7], [1.95, yTop], [1.95, yTop + 0.22], [0, yTop + 0.22]], 24, false), M(), col(0x3e4448));
  // railing
  const rr = 1.82;
  for (let i = 0; i < 20; i++) {
    const a = (i / 20) * Math.PI * 2;
    b.box([0.05, 0.78, 0.05], [Math.sin(a) * rr, yTop + 0.6, Math.cos(a) * rr], PAL.iron);
  }
  for (const y of [yTop + 0.98, yTop + 0.6]) {
    const tor = new THREE.TorusGeometry(rr, y > yTop + 0.9 ? 0.045 : 0.025, 6, 40);
    b.add(tor, M([0, y, 0], [Math.PI / 2, 0, 0]), PAL.iron);
  }
  // lantern room
  const yl = yTop + 0.22;
  b.add(lathe([[1.08, yl], [1.08, yl + 0.55], [0.98, yl + 0.6], [0, yl + 0.6]], 16, false), M(), white);
  const glassH = 1.35;
  b.glow = [3.2, 2.5, 1.5, 0.05];
  b.cyl(0.96, 0.96, glassH, [0, yl + 0.6 + glassH / 2, 0], (p) => shade(col(0x9fc6d8), 0.8 + 0.3 * ((p.y - yl - 0.6) / glassH)), 8, [0, Math.PI / 8, 0]);
  b.glow = NO_GLOW;
  for (let i = 0; i < 8; i++) {
    const a = (i / 8) * Math.PI * 2;
    b.box([0.07, glassH, 0.07], [Math.sin(a) * 0.98, yl + 0.6 + glassH / 2, Math.cos(a) * 0.98], col(0x2d3236), [0, a, 0]);
  }
  const yc = yl + 0.6 + glassH;
  b.add(
    lathe([[1.22, yc - 0.02], [1.22, yc + 0.1], [1.05, yc + 0.32], [0.75, yc + 0.68], [0.35, yc + 0.9], [0, yc + 0.96]], 24, true),
    M(),
    (p, n) => (n.y < -0.3 ? col(0x5a2a26) : red),
  );
  b.cyl(0.07, 0.1, 0.35, [0, yc + 1.1, 0], col(0x2d3236), 8);
  b.blob([0.16, 0.16, 0.16], [0, yc + 1.33, 0], col(0x2d3236), 1);
  b.cyl(0.0, 0.03, 0.5, [0, yc + 1.65, 0], col(0x2d3236), 6);
  return { lamp: new THREE.Vector3(0, yl + 0.6 + glassH / 2, 0), height: yc + 1.9, radius: 2.1 };
}

// ------------------------------------------------------------------------------------------ windmill
export interface WindmillInfo {
  hub: THREE.Vector3; // local
  tilt: number;
  doorLamp: THREE.Vector3;
}

export function windmill(b: MeshBuilder, r: Rand): WindmillInfo {
  const plaster = col(0xf1e6cf);
  const y0 = 0.4, yTop = 7.2;
  const rad = (y: number) => {
    const t = (y - y0) / (yTop - y0);
    return 1.92 - 0.55 * t - 0.06 * Math.sin(t * Math.PI);
  };
  b.ao = houseAO(y0, yTop);
  b.add(lathe([[2.2, -1.4], [2.15, 0.25], [2.02, 0.48], [0, 0.48]], 22, false), M(), (p, n) => shade(n.y > 0.7 ? col(0xa89f90) : PAL.stone, 1));
  // stone foot band then plaster
  const prof = (a: number, c: number, n: number) => {
    const out: [number, number][] = [];
    for (let j = 0; j <= n; j++) {
      const y = a + ((c - a) * j) / n;
      out.push([rad(y), y]);
    }
    return out;
  };
  b.add(lathe(prof(y0, 1.3, 2), 24, true), M(), (p) => shade(PAL.stone, 0.9 + 0.12 * Math.sin(Math.atan2(p.x, p.z) * 9 + Math.floor(p.y * 4) * 2)));
  b.add(lathe(prof(1.3, yTop, 10), 24, true), M(), plaster);
  // stage (reefing gallery)
  const ys = 3.35;
  b.add(lathe([[2.5, ys - 0.12], [2.5, ys], [rad(ys) - 0.05, ys], [rad(ys) - 0.05, ys - 0.12], [2.5, ys - 0.12]], 24, false), M(), PAL.wood);
  for (let i = 0; i < 18; i++) {
    const a = (i / 18) * Math.PI * 2 + 0.09;
    if (Math.abs(Math.sin(a / 2)) < 0.14) continue; // gap at the front (+Z) over the door
    b.box([0.07, 0.8, 0.07], [Math.sin(a) * 2.42, ys + 0.4, Math.cos(a) * 2.42], PAL.timber);
  }
  b.add(new THREE.TorusGeometry(2.42, 0.045, 6, 40), M([0, ys + 0.8, 0], [Math.PI / 2, 0, 0]), PAL.timber);
  for (let i = 0; i < 8; i++) {
    const a = (i / 8) * Math.PI * 2 + 0.2;
    const s = new THREE.Vector3(Math.sin(a), 0, Math.cos(a));
    b.beam(s.clone().multiplyScalar(rad(2.4) - 0.05).setY(2.4), s.clone().multiplyScalar(2.3).setY(ys - 0.1), 0.1, 0.1, PAL.timber);
  }
  // cap (shingled dome)
  const capC = col(0x7d5b45);
  b.add(
    lathe([[1.5, 7.05], [1.62, 7.3], [1.5, 7.75], [1.25, 8.35], [0.86, 8.85], [0.42, 9.2], [0, 9.32]], 24, true),
    M(),
    (p, n) => (n.y < -0.3 ? shade(capC, 0.5) : shade(capC, 0.9 + 0.12 * Math.sin(p.y * 13))),
  );
  b.cyl(0.05, 0.05, 0.6, [0, 9.55, 0], PAL.iron, 6);
  b.blob([0.13, 0.13, 0.13], [0, 9.85, 0], col(0xd2a64a), 1);
  // axle housing toward +Z (the village), tilted up a little
  const tilt = THREE.MathUtils.degToRad(9);
  const hub = new THREE.Vector3(0, 8.0 + 2.35 * Math.tan(tilt), 2.35);
  b.add(new THREE.CylinderGeometry(0.26, 0.32, 1.4, 10), M([0, 8.0 + 1.6 * Math.tan(tilt), 1.6], [Math.PI / 2 - tilt, 0, 0]), PAL.timber);
  // door
  const rz = rad(1.2);
  b.box([1.0, 1.9, 0.4], [0, y0 + 0.95, rz - 0.1], PAL.doors[0], [0, 0, 0], 2);
  b.box([1.25, 0.15, 0.45], [0, y0 + 1.97, rz - 0.08], PAL.timber);
  for (const s of [-1, 1]) b.box([0.15, 2.0, 0.45], [s * 0.57, y0 + 1.0, rz - 0.08], PAL.timber);
  b.box([1.5, 0.32, 0.6], [0, 0.32, rz + 0.25], PAL.stone);
  const doorLamp = new THREE.Vector3(0.95, y0 + 2.25, rad(2.6) + 0.12);
  b.glow = lampGlow(r, 3.5);
  b.box([0.2, 0.28, 0.2], [doorLamp.x, doorLamp.y, doorLamp.z], col(0xe9d6a0));
  b.glow = NO_GLOW;
  b.box([0.28, 0.06, 0.28], [doorLamp.x, doorLamp.y + 0.17, doorLamp.z], PAL.iron);
  b.box([0.05, 0.05, 0.25], [doorLamp.x, doorLamp.y + 0.1, doorLamp.z - 0.15], PAL.iron);
  // windows
  for (const [y, a] of [[2.3, 1.1], [4.7, 0.5], [5.9, -0.6], [4.6, -1.9]] as [number, number][]) {
    b.push(M([0, 0, 0], [0, a, 0]));
    b.push(M([0, y, rad(y) - 0.03]));
    addWindow(b, { w: 0.48, h: 0.66, r, glow: windowGlow(r, 0.0), shutter: PAL.shutters[0] });
    b.pop();
    b.pop();
  }
  b.ao = null;
  return { hub, tilt, doorLamp };
}

/** Four lattice sails in the local XY plane (axle = +Z), origin at the hub. */
export function windmillSails(b: MeshBuilder, r: Rand) {
  const L = 6.3;
  const wood = col(0x8a6648);
  const canvas = PAL.canvas;
  b.cyl(0.36, 0.36, 0.55, [0, 0, 0.05], PAL.timber, 12, [Math.PI / 2, 0, 0]);
  b.blob([0.22, 0.22, 0.22], [0, 0, 0.32], PAL.timber, 1);
  for (let i = 0; i < 4; i++) {
    b.push(M([0, 0, 0], [0, 0, (i * Math.PI) / 2 + 0.25]));
    b.box([0.2, L + 0.4, 0.2], [0, L / 2 - 0.1, 0.12], wood);
    const y0 = 1.15, y1 = L - 0.05;
    b.box([0.07, y1 - y0, 0.08], [1.2, (y0 + y1) / 2, 0.1], wood);
    b.box([0.06, y1 - y0, 0.06], [-0.38, (y0 + y1) / 2, 0.1], wood);
    const n = 12;
    for (let j = 0; j <= n; j++) {
      const y = y0 + ((y1 - y0) * j) / n;
      b.box([1.68, 0.055, 0.07], [0.41, y, 0.1], wood);
    }
    // canvas: main sail and a narrow leading strip
    b.box([1.1, y1 - y0 - 0.3, 0.03], [0.62, (y0 + y1) / 2 + 0.05, 0.03], (p) => shade(canvas, 0.94 + 0.06 * Math.sin(p.y * 2.1)));
    b.box([0.28, y1 - y0 - 0.3, 0.03], [-0.22, (y0 + y1) / 2 + 0.05, 0.03], shade(canvas, 0.95));
    b.pop();
  }
}

// ------------------------------------------------------------------------------------------ boats
function grid(rows: number, cols: number, f: (i: number, j: number) => THREE.Vector3, flip: boolean) {
  const pos: number[] = [];
  for (let i = 0; i < rows; i++)
    for (let j = 0; j < cols; j++) {
      const p = f(i, j);
      pos.push(p.x, p.y, p.z);
    }
  const idx: number[] = [];
  for (let i = 0; i < rows - 1; i++)
    for (let j = 0; j < cols - 1; j++) {
      const a = i * cols + j, b = a + 1, c = a + cols, d = c + 1;
      if (flip) idx.push(a, c, b, b, c, d);
      else idx.push(a, b, c, b, d, c);
    }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}

/** Rowing boat: bow toward +Z, waterline at y = 0. */
export function rowingBoat(b: MeshBuilder, r: Rand, hullCol: THREE.Color, stripe: THREE.Color) {
  const NS = 14, NC = 9;
  const z0 = -1.55, z1 = 1.75;
  const halfW = (t: number) => (t < 0.45 ? 0.66 - 0.2 * ((0.45 - t) / 0.45) ** 2 : 0.66 * Math.sqrt(Math.max(0, 1 - ((t - 0.45) / 0.55) ** 2)));
  const keel = (t: number) => -0.3 + 0.28 * t ** 3 + 0.08 * (1 - t) ** 3;
  const gun = (t: number) => 0.3 + 0.2 * t ** 4 + 0.07 * (1 - t) ** 2;
  const sect = (t: number, j: number, k: number, inset: number) => {
    // j in [0, NC-1]: -side .. keel .. +side
    const u = (j / (NC - 1)) * 2 - 1;
    const phi = Math.abs(u) * Math.PI * 0.5;
    const w = Math.max(0.001, halfW(t) - inset);
    const y0 = keel(t) + inset * 1.2, y1 = gun(t);
    return new THREE.Vector3(Math.sign(u) * w * Math.pow(Math.sin(phi), 0.75), y0 + (y1 - y0) * (1 - Math.cos(phi)) ** 0.9, z0 + (z1 - z0) * t).multiplyScalar(k);
  };
  const ts = (i: number) => i / (NS - 1);
  const outer = grid(NS, NC, (i, j) => sect(ts(i), j, 1, 0), false);
  // orient: a mid-hull side vertex normal must point outward
  const testN = new THREE.Vector3().fromBufferAttribute(outer.attributes.normal as THREE.BufferAttribute, Math.floor(NS / 2) * NC + NC - 1);
  const flipOuter = testN.x < 0;
  const outerG = flipOuter ? grid(NS, NC, (i, j) => sect(ts(i), j, 1, 0), true) : outer;
  const innerG = grid(NS, NC, (i, j) => sect(Math.min(ts(i), 0.985), j, 1, 0.06), !flipOuter);
  b.add(outerG, M(), (p) => (p.y > gun((p.z - z0) / (z1 - z0)) - 0.13 ? stripe : hullCol));
  b.add(innerG, M(), (p) => shade(PAL.woodLight, 0.75 + 0.25 * Math.sin(p.z * 9)));
  // gunwale rim: a thin beam along each side top
  for (const s of [-1, 1]) {
    for (let i = 0; i < NS - 1; i++) {
      const a = sect(ts(i), s > 0 ? NC - 1 : 0, 1, 0.03);
      const c = sect(ts(i + 1), s > 0 ? NC - 1 : 0, 1, 0.03);
      b.beam(a, c, 0.08, 0.06, PAL.wood);
    }
  }
  // transom
  b.box([0.95, 0.5, 0.06], [0, 0.12, z0 + 0.02], hullCol);
  b.box([0.98, 0.08, 0.08], [0, 0.39, z0 + 0.02], PAL.wood);
  // seats
  b.box([1.15, 0.06, 0.32], [0, 0.12, -0.55], PAL.woodLight);
  b.box([1.18, 0.06, 0.3], [0, 0.14, 0.45], PAL.woodLight);
  // oars
  for (const s of [-1, 1]) {
    b.box([0.05, 0.05, 2.2], [s * 0.25, 0.2, 0.0], PAL.woodLight, [0, s * 0.06, 0]);
    b.box([0.14, 0.03, 0.42], [s * 0.25 + s * 0.06, 0.2, -1.05], PAL.woodLight, [0, s * 0.06, 0]);
  }
}
