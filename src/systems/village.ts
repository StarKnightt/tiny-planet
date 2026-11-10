// Everything built by people: the village on the green, the lighthouse on the cape, the windmill on
// its hill, the pier and boats, street lamps, light pools, chimney smoke.
//
// Draw calls: one merged static mesh (+ its shadow pass), sails (+shadow), moored boat (+shadow),
// lighthouse beams, lamp halo, smoke. All animation is a pure function of ctx.time.
import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import type { Ctx, System } from '../core/context';
import { nightAt } from '../core/lighting';
import { rng } from '../core/noise';
import { findCoast, heightAt, LANDMARKS, offsetDir, R, surfacePoint, tangentFrame, uprightQuaternion } from '../core/terrain';
import { col, M, MeshBuilder, mixc, shade, type V3 } from '../village/builder';
import { lighthouse, rowingBoat, windmill, windmillSails } from '../village/landmarks';
import { beamMaterial, haloMaterial, smokeMaterial, villageMaterial } from '../village/materials';
import {
  barrel, bench, bush, cottage, crate, houseAO, marketStall, PAL, pick, propAO, signpost, streetLamp, vegPatch, well,
  type CottageSpec,
} from '../village/parts';

export const order = 20;

export interface Collider { x: number; y: number; z: number; r: number }
const colliders: Collider[] = [];
/** World-space bounding circles (centre on the ground + radius) of solid things the player must not walk through. */
export function getColliders(): Collider[] {
  return colliders;
}

const V = LANDMARKS.village;
const DEG = Math.PI / 180;
const ONE = new THREE.Vector3(1, 1, 1);

/** village-plane coords (east, north) of a bearing (deg, clockwise from north) and distance */
const P = (bearDeg: number, dist: number): [number, number] => [dist * Math.sin(bearDeg * DEG), dist * Math.cos(bearDeg * DEG)];
const vdir = (e: number, n: number) => offsetDir(V, e, n);

/** Matrix that stands a local frame on the planet at `dir`, origin `h` above sea level. */
function frameAt(dir: THREE.Vector3, yaw: number, h: number): THREE.Matrix4 {
  const d = dir.clone().normalize();
  const q = uprightQuaternion(d, yaw, new THREE.Quaternion());
  return new THREE.Matrix4().compose(d.clone().multiplyScalar(R + h), q, ONE);
}
/** Frame on the ground at `dir`, sunk a little. */
const groundFrame = (dir: THREE.Vector3, yaw: number, sink = 0.04) => frameAt(dir, yaw, heightAt(dir) - sink);

/** Bearing (radians, clockwise from north) from `from` toward `to`, measured in from's tangent plane. */
function bearingTo(from: THREE.Vector3, to: THREE.Vector3): number {
  const e = new THREE.Vector3(), n = new THREE.Vector3();
  tangentFrame(from, e, n);
  const d = to.clone().sub(from);
  return Math.atan2(d.dot(e), d.dot(n));
}

/** Footing height for a footprint w x d at frame (dir, yaw): the highest ground under it, a hair lower. */
function footing(dir: THREE.Vector3, yaw: number, w: number, d: number): { h: number; spread: number } {
  const m = frameAt(dir, yaw, 0);
  let hi = -Infinity, lo = Infinity;
  for (const [x, z] of [[0, 0], [-w / 2, -d / 2], [w / 2, -d / 2], [-w / 2, d / 2], [w / 2, d / 2], [0, d / 2], [0, -d / 2], [w / 2, 0], [-w / 2, 0]]) {
    const p = new THREE.Vector3(x, 0, z).applyMatrix4(m).normalize();
    const h = heightAt(p);
    hi = Math.max(hi, h);
    lo = Math.min(lo, h);
  }
  return { h: lo + (hi - lo) * 0.65 - 0.06, spread: hi - lo };
}

function addCollider(world: THREE.Matrix4, local: THREE.Vector3, r: number) {
  const p = local.clone().applyMatrix4(world);
  colliders.push({ x: p.x, y: p.y, z: p.z, r });
}

export default function createVillage(ctx: Ctx): System {
  colliders.length = 0;
  const r = rng(4242);
  const b = new MeshBuilder();
  const smokeSources: THREE.Vector3[] = [];
  const glows: { p: THREE.Vector3; r: number; c: THREE.Color; k: number }[] = [];
  const glowAt = (p: THREE.Vector3, radius: number, k = 1, c = new THREE.Color(1.0, 0.58, 0.26)) => glows.push({ p, r: radius, c, k });

  // ------------------------------------------------------------------ cottages
  type House = { bear: number; dist: number; kind: CottageSpec['kind']; smoke?: boolean; turn?: number };
  const houses: House[] = [
    { bear: 8, dist: 11, kind: 1, smoke: true },
    { bear: 36, dist: 10.6, kind: 0 },
    { bear: 90, dist: 10.6, kind: 2, smoke: true },
    { bear: 124, dist: 11.2, kind: 3 },
    { bear: 182, dist: 12.2, kind: 1, smoke: true },
    { bear: 236, dist: 11.2, kind: 0, smoke: true },
    { bear: 264, dist: 11.8, kind: 3 },
    { bear: 327, dist: 11.2, kind: 2, smoke: true },
    { bear: 112, dist: 16.0, kind: 1, turn: -0.25 },
    { bear: 278, dist: 16.6, kind: 0, turn: 0.2 },
    { bear: 352, dist: 17.0, kind: 3, turn: 0.15 },
  ];
  const wallOrder = [0, 1, 2, 3, 4, 5, 1, 0, 3, 2, 4];
  const roofOrder = [0, 1, 2, 3, 4, 5, 2, 1, 0, 3, 1];
  houses.forEach((hs, i) => {
    const yaw = hs.bear * DEG + (hs.turn ?? 0) + (r() - 0.5) * 0.12; // +Z faces the square
    const fw0 = [4.5, 3.9, 6.3, 4.1][hs.kind], fd0 = [3.7, 3.7, 3.6, 4.5][hs.kind];
    // slide the house in a little if that finds flatter ground (less exposed plinth)
    let dist = hs.dist;
    for (let k = 0, best = Infinity; k <= 6; k++) {
      const dd = hs.dist - k * 0.25;
      const sp = footing(vdir(...P(hs.bear, dd)), yaw, fw0, fd0).spread + k * 0.02;
      if (sp < best) {
        best = sp;
        dist = dd;
      }
    }
    hs.dist = dist;
    const [e, n] = P(hs.bear, dist);
    const dir = vdir(e, n);
    const spec: CottageSpec = { kind: hs.kind, seed: i, wall: PAL.walls[wallOrder[i]], roof: PAL.roofs[roofOrder[i]] };
    const hr = rng(100 + i * 17);
    // dry-run size for the footing: same dims as cottage() uses (max)
    const fw = [4.5, 3.9, 6.3, 4.1][hs.kind], fd = [3.7, 3.7, 3.6, 4.5][hs.kind];
    const { h } = footing(dir, yaw, fw, fd);
    const world = frameAt(dir, yaw, h);
    const lean = [(hr() - 0.5) * 0.2, (hr() - 0.5) * 0.14];
    const top = [2.8, 4.8, 2.9, 3.0][hs.kind];
    b.begin(world, houseAO(0.32, top + 0.32), (p) => {
      const t = Math.max(0, p.y) / (top + 2);
      p.x += lean[0] * t * t;
      p.z += lean[1] * t * t;
    });
    const info = cottage(b, spec, hr);
    // bushes beside the door, a barrel or a bench by some
    b.ao = propAO;
    b.deform = null;
    bush(b, [-(info.w / 2 + 0.2), 0, info.d / 2 + 0.45], hr, 0.9, hr() < 0.7);
    if (hr() < 0.6) bush(b, [info.w / 2 + 0.3, 0, info.d / 2 + 0.2], hr, 0.75, hr() < 0.5);
    if (hr() < 0.5) barrel(b, [info.w / 2 + 0.45, 0, -info.d / 2 + 0.6], hr, 0.9);
    else bush(b, [info.w / 2 + 0.4, 0, -info.d / 2 + 0.3], hr, 1.1, false);
    if (hs.smoke) smokeSources.push(info.chimney.clone().applyMatrix4(world));
    addCollider(world, new THREE.Vector3(0, 0, 0), info.radius * 0.92);
  });

  // ------------------------------------------------------------------ the square
  {
    // cobbles: concentric rings of chunky stones
    b.begin(new THREE.Matrix4(), null);
    const rr = rng(7);
    b.variation = 0.05;
    for (let rad = 0.35; rad < 6.0; rad += 0.6) {
      const n = Math.max(1, Math.floor((2 * Math.PI * rad) / 0.62));
      const off = rr() * 6.28;
      for (let i = 0; i < n; i++) {
        const a = off + (i / n) * Math.PI * 2 + (rr() - 0.5) * 0.15;
        const rj = rad + (rr() - 0.5) * 0.14;
        if (rj > 5.85 - rr() * 0.6) continue; // ragged edge
        const dir = vdir(Math.sin(a) * rj, Math.cos(a) * rj);
        const s = 0.25 + rr() * 0.07;
        const c = shade(mixc(col(0x948a7c), col(0x857a6c), rr()), 0.85 + rr() * 0.25);
        b.world.copy(groundFrame(dir, rr() * 6.28, 0.07));
        b.cyl(s, s * 1.08, 0.15, [0, 0.0, 0], (p, nn) => (nn.y > 0.5 ? c : shade(c, 0.7)), 6, [0, 0, 0]);
      }
    }
    b.variation = 0.08;
  }
  const place = (e: number, n: number, yawDeg: number, sink = 0.04) => {
    const dir = vdir(e, n);
    const m = groundFrame(dir, yawDeg * DEG, sink);
    b.begin(m, propAO);
    return m;
  };
  // well
  {
    const m = place(2.2, 2.4, 20, 0.15);
    well(b, r);
    addCollider(m, new THREE.Vector3(), 1.15);
    glowAt(new THREE.Vector3(0, 1.4, 0).applyMatrix4(m), 7.5, 0.7);
  }
  // market stalls (front +Z toward the centre)
  {
    const [e1, n1] = P(118, 4.4);
    let m = place(e1, n1, 118);
    marketStall(b, r, col(0xc9443a));
    addCollider(m, new THREE.Vector3(), 1.4);
    crate(b, [1.6, 0, 0.3], r, 0.5, 0.3);
    crate(b, [1.7, 0, -0.35], r, 0.45, -0.2);
    crate(b, [1.65, 0.5, -0.05], r, 0.4, 0.5);
    barrel(b, [-1.65, 0, 0.2], r);
    const [e2, n2] = P(250, 4.6);
    m = place(e2, n2, 250);
    marketStall(b, r, col(0x3f8c88));
    addCollider(m, new THREE.Vector3(), 1.4);
    barrel(b, [1.6, 0, 0.25], r);
    barrel(b, [1.75, 0, -0.45], r, 0.9);
    crate(b, [-1.7, 0, 0.1], r, 0.55, 0.2);
  }
  // benches facing the well / centre
  for (const [bear, dist] of [[30, 5.0], [335, 5.2], [180, 4.9]] as [number, number][]) {
    const [e, n] = P(bear, dist);
    place(e, n, bear);
    bench(b);
  }
  // barrels & crates heaps
  {
    const [e, n] = P(75, 5.2);
    place(e, n, 40);
    barrel(b, [0, 0, 0], r);
    barrel(b, [0.62, 0, 0.15], r, 0.95);
    crate(b, [-0.2, 0, 0.75], r, 0.55, 0.3);
  }

  // ------------------------------------------------------------------ paths (stepping stones)
  const lighthouseDir = LANDMARKS.lighthouse;
  const windmillDir = LANDMARKS.windmill;
  const stones = (pts: [number, number][], seed: number, width = 1.0) => {
    const rr = rng(seed);
    b.begin(new THREE.Matrix4(), null);
    b.variation = 0.05;
    for (let k = 0; k < pts.length - 1; k++) {
      const [ax, ay] = pts[k], [cx, cy] = pts[k + 1];
      const len = Math.hypot(cx - ax, cy - ay);
      const tx = (cx - ax) / len, ty = (cy - ay) / len;
      for (let s = 0; s < len; s += 0.72) {
        for (const lat of [-0.5, 0.5]) {
          if (rr() < 0.12) continue;
          const l = lat * width + (rr() - 0.5) * 0.25;
          const e = ax + tx * s - ty * l + (rr() - 0.5) * 0.15, n = ay + ty * s + tx * l + (rr() - 0.5) * 0.15;
          const dir = vdir(e, n);
          if (heightAt(dir) < 0.3) continue;
          const sz = 0.26 + rr() * 0.12;
          const c = shade(mixc(col(0x9a9082), col(0x857b6e), rr()), 0.85 + rr() * 0.25);
          b.world.copy(groundFrame(dir, rr() * 6.28, 0.07));
          b.cyl(sz, sz * 1.1, 0.15, [0, 0, 0], (p, nn) => (nn.y > 0.5 ? c : shade(c, 0.7)), 6, [0, 0, 0]);
        }
      }
    }
    b.variation = 0.08;
  };

  // pier geometry first: we need its landward end for the south path
  const coast = findCoast(V, vdir(-30, -30));
  const ce = new THREE.Vector3(), cn = new THREE.Vector3();
  tangentFrame(coast, ce, cn);
  const toCoast = coast.clone().sub(V);
  const ax = new THREE.Vector2(toCoast.dot(ce), toCoast.dot(cn)).normalize();
  /** direction at `s` along the pier axis (s=0 at the waterline, + seaward) and `lat` to its right */
  const pierAt = (s: number, lat: number) => offsetDir(coast, ax.x * s + ax.y * lat, ax.y * s - ax.x * lat);
  const pierYaw = Math.atan2(ax.x, ax.y);
  let s0 = -6;
  for (let s = -6; s < 0; s += 0.1) if (heightAt(pierAt(s, 0)) < 0.95) { s0 = s; break; }
  const s1 = 13;
  const deckH = 1.12;
  // landward end of the pier in village-plane coords
  const ve = new THREE.Vector3(), vn = new THREE.Vector3();
  tangentFrame(V, ve, vn);
  const toVP = (d: THREE.Vector3): [number, number] => {
    const q = d.clone().multiplyScalar(R).sub(V.clone().multiplyScalar(R));
    return [q.dot(ve), q.dot(vn)];
  };
  const pierFoot = toVP(pierAt(s0 - 1.0, 0));
  const lhFoot = toVP(offsetDir(lighthouseDir, 0, 0));
  const wmFoot = toVP(windmillDir);

  stones([P(205, 5.4), P(204, 10), P(208, 15), P(214, 19), pierFoot], 11);
  stones([P(155, 5.4), P(156, 11), P(159, 16), [lhFoot[0] * 0.86, lhFoot[1] * 0.86]], 12);
  stones([P(298, 5.4), P(297, 12), P(296, 18), [wmFoot[0] * 0.88, wmFoot[1] * 0.88]], 13);
  stones([P(60, 5.4), P(62, 12), P(64, 18)], 14);
  stones([P(355, 5.6), P(352, 11.5), P(352, 14.5)], 15, 0.8);

  // ------------------------------------------------------------------ lamps
  const lampAt = (e: number, n: number, glowR = 5.5, k = 1.0) => {
    const m = place(e, n, r() * 360, 0.06);
    const head = streetLamp(b, r);
    glowAt(new THREE.Vector3(0, 1.4, 0).applyMatrix4(m), glowR, k);
    return head.applyMatrix4(m);
  };
  for (const bear of [42, 138, 228, 318]) lampAt(...P(bear, 6.3), 5.5, 1.1);
  lampAt(...P(212, 14.5), 5.5, 1.0); // south path (spawn side)
  lampAt(...P(292, 14.5), 5.0, 1.0); // west path
  lampAt(...P(67, 13.5), 5.0, 1.0); // east path

  // signpost at the spawn-side entrance
  {
    const m = place(-0.9, -5.7, 0);
    const toWm = bearingTo(vdir(-0.9, -5.7), windmillDir);
    const toLh = bearingTo(vdir(-0.9, -5.7), lighthouseDir);
    const toPier = bearingTo(vdir(-0.9, -5.7), pierAt(0, 0));
    signpost(b, [
      { yaw: Math.PI / 2 - toWm, c: col(0xd6a85a) },
      { yaw: Math.PI / 2 - toLh, c: col(0xc9a070) },
      { yaw: Math.PI / 2 - toPier, c: col(0xb98f60) },
    ]);
    addCollider(m, new THREE.Vector3(), 0.25);
  }

  // ------------------------------------------------------------------ fences, walls, gardens
  const fence = (pts: [number, number][], seed: number) => {
    const rr = rng(seed);
    b.begin(new THREE.Matrix4(), null);
    const wood = col(0x9a7550);
    const posts: { top: THREE.Vector3; mid: THREE.Vector3; up: THREE.Vector3 }[] = [];
    for (let k = 0; k < pts.length - 1; k++) {
      const [ax0, ay0] = pts[k], [cx, cy] = pts[k + 1];
      const len = Math.hypot(cx - ax0, cy - ay0);
      const n = Math.max(1, Math.round(len / 1.5));
      for (let i = k === 0 ? 0 : 1; i <= n; i++) {
        const t = i / n;
        const dir = vdir(ax0 + (cx - ax0) * t, ay0 + (cy - ay0) * t);
        const m = groundFrame(dir, rr() * 6.28, 0.25);
        b.world.copy(m);
        const tilt: V3 = [(rr() - 0.5) * 0.08, 0, (rr() - 0.5) * 0.08];
        b.box([0.11, 1.25, 0.11], [0, 0.62, 0], shade(wood, 0.85 + rr() * 0.2), tilt);
        b.box([0.14, 0.06, 0.14], [0, 1.25, 0], shade(wood, 0.7), tilt);
        const up = dir.clone();
        posts.push({ top: new THREE.Vector3(0, 1.08, 0).applyMatrix4(m), mid: new THREE.Vector3(0, 0.68, 0).applyMatrix4(m), up });
      }
    }
    b.world.identity();
    for (let i = 0; i < posts.length - 1; i++) {
      const a = posts[i], c = posts[i + 1];
      const up = a.up.clone().add(c.up).normalize();
      b.beam(a.top, c.top, 0.05, 0.11, shade(wood, 0.95 + rr() * 0.1), up);
      b.beam(a.mid, c.mid, 0.05, 0.11, shade(wood, 0.95 + rr() * 0.1), up);
    }
  };
  const stoneWall = (pts: [number, number][], seed: number) => {
    const rr = rng(seed);
    b.begin(new THREE.Matrix4(), null);
    for (let k = 0; k < pts.length - 1; k++) {
      const [ax0, ay0] = pts[k], [cx, cy] = pts[k + 1];
      const len = Math.hypot(cx - ax0, cy - ay0);
      const yaw = Math.atan2(cx - ax0, cy - ay0) + Math.PI / 2;
      let s = 0;
      while (s < len) {
        const sl = 0.45 + rr() * 0.35;
        const t = (s + sl / 2) / len;
        const dir = vdir(ax0 + (cx - ax0) * t, ay0 + (cy - ay0) * t);
        b.world.copy(groundFrame(dir, yaw, 0.2));
        const c = shade(mixc(PAL.stone, PAL.stoneDark, rr()), 0.9 + rr() * 0.2);
        // dry-stone rubble: flattened rocks in two courses + a rough cap
        b.blob([sl * 0.55, 0.24, 0.34], [0, 0.12, (rr() - 0.5) * 0.08], c, 1, [0, rr() * 0.4, 0]);
        b.blob([sl * 0.42, 0.2, 0.28], [(rr() - 0.5) * 0.15, 0.42, (rr() - 0.5) * 0.06], shade(c, 0.95 + rr() * 0.12), 1, [0, rr() * 0.6, 0]);
        if (rr() < 0.55) b.blob([0.16, 0.13, 0.2], [(rr() - 0.5) * 0.3, 0.6, 0], shade(c, 1.05), 0);
        if (rr() < 0.3) b.blob([0.2, 0.09, 0.2], [(rr() - 0.5) * 0.3, 0.64, 0], col(0x6f9a4a), 1);
        s += sl;
      }
    }
  };
  fence([P(200, 15.5), P(207, 20), P(214, 23.5)], 21);
  fence([P(222, 14.5), P(224, 18.5), P(227, 21.5)], 22);
  stoneWall([P(287, 13.5), P(287, 19.5)], 23);
  stoneWall([P(304, 13.5), P(303, 18.0)], 24);
  stoneWall([P(149, 13.5), P(152, 19.5)], 25);
  // vegetable gardens behind a few houses, fenced
  const garden = (bear: number, dist: number, w: number, d: number, seed: number) => {
    const [e, n] = P(bear, dist);
    const rr = rng(seed);
    place(e, n, bear, 0.05);
    vegPatch(b, w, d, rr);
    const yaw = bear * DEG;
    const ex = Math.cos(yaw), ny = -Math.sin(yaw); // local +X in village plane
    const fz = Math.sin(yaw), fn = Math.cos(yaw); // local -Z (outward)
    const c = (x: number, z: number): [number, number] => [e + ex * x - fz * z, n + ny * x - fn * z];
    const W = w / 2 + 0.6, D = d / 2 + 0.6;
    fence([c(-W + 1.0, D), c(-W, D), c(-W, -D), c(W, -D), c(W, D), c(W - 1.0, D)], seed + 1);
  };
  garden(36, 16.0, 2.6, 1.8, 31);
  garden(258, 17.2, 2.4, 1.8, 32);
  garden(140, 16.5, 2.8, 1.8, 33);

  // scattered bushes on the green
  {
    const rr = rng(55);
    for (let i = 0; i < 26; i++) {
      const bear = rr() * 360, dist = 7.5 + rr() * 12;
      const [e, n] = P(bear, dist);
      // keep clear of houses and paths
      const near = houses.some((h) => {
        const [he, hn] = P(h.bear, h.dist);
        return Math.hypot(he - e, hn - n) < 3.6;
      });
      const onPath = [205, 155, 298, 60, 355].some((pb) => Math.abs(((bear - pb + 540) % 360) - 180) < 8);
      if (near || onPath || heightAt(vdir(e, n)) < 1.2) continue;
      place(e, n, 0, 0.1);
      bush(b, [0, 0, 0], rr, 0.8 + rr() * 0.5, rr() < 0.5);
    }
  }

  // ------------------------------------------------------------------ lighthouse + keeper's cottage
  let lampWorld = new THREE.Vector3();
  let lhQuat = new THREE.Quaternion();
  {
    const dir = lighthouseDir.clone();
    const yaw = bearingTo(dir, V) + Math.PI;
    const world = frameAt(dir, yaw, heightAt(dir) - 0.05);
    b.begin(world, houseAO(0.35, 13.4));
    const info = lighthouse(b, r);
    lampWorld = info.lamp.clone().applyMatrix4(world);
    lhQuat = uprightQuaternion(dir, yaw, new THREE.Quaternion());
    addCollider(world, new THREE.Vector3(), info.radius + 0.2);
    glowAt(new THREE.Vector3(0, 0.8, 3.0).applyMatrix4(world), 6.0, 0.8);

    // keeper's cottage: beside the tower, toward the village side
    const cd = offsetDir(dir, 0, 0);
    const ke = new THREE.Vector3(), kn = new THREE.Vector3();
    tangentFrame(dir, ke, kn);
    const toV = new THREE.Vector2(Math.sin(yaw - Math.PI), Math.cos(yaw - Math.PI)); // bearing toward village
    const side = new THREE.Vector2(toV.y, -toV.x);
    // search a ring around the tower for the flattest spot that still faces the village
    let kd = offsetDir(cd, toV.x * 5 + side.x * 3, toV.y * 5 + side.y * 3);
    let bestScore = Infinity;
    for (let a = 0; a < 360; a += 10)
      for (let dist = 5.2; dist <= 8.5; dist += 0.5) {
        const ex = Math.sin(a * DEG) * dist, nx = Math.cos(a * DEG) * dist;
        const d = offsetDir(cd, ex, nx);
        const ky = bearingTo(d, V) + Math.PI + 0.4;
        const f = footing(d, ky, 4.6, 3.8);
        const facing = 1 - (ex * toV.x + nx * toV.y) / dist; // 0 = toward the village
        // stay on the landward side and off the west (beach-view) side so the tower reads clearly
        const score = f.spread + 0.25 * facing + (heightAt(d) < 1.5 ? 10 : 0) + (facing > 0.75 || ex < 0.5 ? 10 : 0);
        if (score < bestScore) {
          bestScore = score;
          kd = d;
        }
      }
    const kyaw = bearingTo(kd, V) + Math.PI + 0.4;
    const kf = footing(kd, kyaw, 4.5, 3.7);
    const kw = frameAt(kd, kyaw, kf.h);
    const kr = rng(909);
    b.begin(kw, houseAO(0.32, 2.82));
    const kinfo = cottage(b, { kind: 0, seed: 99, wall: col(0xf6f1e6), roof: col(0xb84a3a) }, kr);
    smokeSources.push(kinfo.chimney.clone().applyMatrix4(kw));
    addCollider(kw, new THREE.Vector3(), kinfo.radius * 0.92);
    b.ao = propAO;
    bush(b, [-(kinfo.w / 2 + 0.2), 0, kinfo.d / 2 + 0.4], kr, 0.9, true);
    barrel(b, [kinfo.w / 2 + 0.45, 0, kinfo.d / 2 - 0.3], kr);
  }

  // ------------------------------------------------------------------ windmill
  const sailsPivot = new THREE.Object3D();
  {
    const dir = windmillDir.clone();
    const yaw = bearingTo(dir, V) + Math.PI;
    const world = frameAt(dir, yaw, heightAt(dir) - 0.05);
    b.begin(world, null);
    const info = windmill(b, r);
    addCollider(world, new THREE.Vector3(), 2.15);
    glowAt(new THREE.Vector3(0, 1.4, 2.8).applyMatrix4(world), 6.0, 1.0);
    // sails pivot in world: hub position, tilted axle
    const q = uprightQuaternion(dir, yaw, new THREE.Quaternion());
    sailsPivot.position.copy(info.hub).applyMatrix4(world);
    sailsPivot.quaternion.copy(q).multiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), -info.tilt));
    // a couple of sacks & a cart wheel by the door
    b.ao = propAO;
    crate(b, [-1.25, 0.42, 1.75], r, 0.5, 0.4);
    barrel(b, [1.45, 0.42, 1.55], r, 0.9);
  }

  // ------------------------------------------------------------------ pier
  let pierEnd = new THREE.Vector3();
  {
    const rr = rng(77);
    b.begin(new THREE.Matrix4(), null);
    const wood = col(0x8c6a4a);
    // planks
    for (let s = s0; s < s1; s += 0.34) {
      const dir = pierAt(s, (rr() - 0.5) * 0.05);
      b.world.copy(frameAt(dir, pierYaw + (rr() - 0.5) * 0.03, deckH));
      b.box([2.1 + (rr() - 0.5) * 0.12, 0.09, 0.3], [(rr() - 0.5) * 0.06, 0, 0], shade(wood, 0.82 + rr() * 0.3));
    }
    // posts + stringers + cross bracing
    const step = 2.0;
    const postTops: THREE.Vector3[][] = [[], []];
    for (let s = s0 + 0.15; s <= s1 + 0.01; s += step) {
      for (const [k, lat] of [[0, -1.0], [1, 1.0]] as [number, number][]) {
        const dir = pierAt(s, lat);
        const g = Math.min(heightAt(dir), deckH - 0.3) - 0.5;
        const top = deckH + (s > s1 - 0.5 || s < s0 + 0.5 ? 0.55 : 0.08);
        b.world.copy(frameAt(dir, pierYaw, g));
        const hgt = top - g;
        b.cyl(0.13, 0.15, hgt, [0, hgt / 2, 0], (p) => {
          const hh = p.y + g;
          return hh < 0.35 ? (hh < -0.3 ? col(0x3c4a36) : col(0x4f5a3c)) : shade(col(0x6d5238), 1);
        }, 8);
        postTops[k].push(new THREE.Vector3(0, deckH - g - 0.12, 0).applyMatrix4(b.world));
      }
    }
    b.world.identity();
    for (const k of [0, 1])
      for (let i = 0; i < postTops[k].length - 1; i++) {
        const a = postTops[k][i], c = postTops[k][i + 1];
        b.beam(a, c, 0.12, 0.16, shade(wood, 0.7), a.clone().add(c).normalize());
      }
    // pier-end lamp, bollard rope, crates
    const endDir = pierAt(s1 - 0.6, 0.6);
    const m = frameAt(endDir, pierYaw, deckH + 0.04);
    b.begin(m, propAO);
    streetLamp(b, r);
    pierEnd = new THREE.Vector3(0, 0.5, 0).applyMatrix4(m);
    glowAt(pierEnd.clone(), 5.5, 1.1);
    b.begin(frameAt(pierAt(s1 - 1.6, -0.5), pierYaw + 0.3, deckH + 0.04), propAO);
    crate(b, [0, 0, 0], r, 0.5, 0.2);
    barrel(b, [0.2, 0, 0.7], r, 0.85);
    b.begin(frameAt(pierAt(s0 + 1.5, 0.45), pierYaw, deckH + 0.04), propAO);
    crate(b, [0, 0, 0], r, 0.45, -0.3);
  }

  // beached boat on the sand beside the pier
  {
    let best = pierAt(-1.2, -4.2);
    for (let lat = -3.5; lat > -9; lat -= 0.5)
      for (let s = -3; s < 1; s += 0.5) {
        const d = pierAt(s, lat), h = heightAt(d);
        if (h > 0.25 && h < 0.7) {
          best = d;
          lat = -99;
          break;
        }
      }
    const m = frameAt(best, pierYaw + 2.4, heightAt(best) + 0.1);
    m.multiply(M([0, 0, 0], [0.06, 0, 0.22]));
    b.begin(m, null);
    rowingBoat(b, r, col(0x3f7f9e), col(0xf2ece0));
  }

  // ------------------------------------------------------------------ build meshes
  const mat = villageMaterial();
  const staticGeo = b.build();
  const staticMesh = new THREE.Mesh(staticGeo, mat);
  staticMesh.castShadow = true;
  staticMesh.receiveShadow = true;
  staticMesh.name = 'village';
  ctx.scene.add(staticMesh);
  const tris = b.triangles;

  // sails
  const sb = new MeshBuilder();
  sb.variation = 0.04;
  windmillSails(sb, r);
  const sails = new THREE.Mesh(sb.build(), mat);
  sails.castShadow = true;
  sails.receiveShadow = true;
  sailsPivot.add(sails);
  ctx.scene.add(sailsPivot);

  // moored boat
  const bb = new MeshBuilder();
  bb.variation = 0.04;
  rowingBoat(bb, r, col(0xc0513d), col(0xf4efe4));
  const boat = new THREE.Mesh(bb.build(), mat);
  boat.castShadow = true;
  boat.receiveShadow = true;
  ctx.scene.add(boat);
  const boatDir = pierAt(s1 - 3.2, 2.3);
  const boatQ = uprightQuaternion(boatDir, pierYaw + 0.12, new THREE.Quaternion());

  // lighthouse beams: two opposite soft cones sweeping around the local up axis
  const beamMat = beamMaterial();
  // bounding cones (generous: the visible beam is the Gaussian inside them)
  const BEAM_LEN = 55, TILT = 0.03;
  const beamGeos = [1, -1].map((side) => {
    const g = new THREE.CylinderGeometry(1.4, 9.5, BEAM_LEN + 2, 24, 1, true);
    g.translate(0, -(BEAM_LEN + 2) / 2 + 1, 0); // apex end at +1 (slightly behind the lamp)
    g.rotateZ(side * (Math.PI / 2 - TILT));
    const axis = new THREE.Vector3(0, -1, 0).applyAxisAngle(new THREE.Vector3(0, 0, 1), side * (Math.PI / 2 - TILT));
    const n = g.attributes.position.count;
    const ax = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) ax.set([axis.x, axis.y, axis.z], i * 3);
    g.setAttribute('aAxis', new THREE.BufferAttribute(ax, 3));
    g.deleteAttribute('uv');
    g.deleteAttribute('normal');
    return g;
  });
  const beamMerged = mergeGeometries(beamGeos)!;
  beamMat.uniforms.uLen.value = BEAM_LEN;
  const beamPivot = new THREE.Object3D();
  beamPivot.position.copy(lampWorld);
  beamPivot.quaternion.copy(lhQuat);
  const beam = new THREE.Mesh(beamMerged, beamMat);
  beam.frustumCulled = false;
  beam.renderOrder = 10;
  beamPivot.add(beam);
  ctx.scene.add(beamPivot);

  const halo = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), haloMaterial(new THREE.Color(1.0, 0.8, 0.5).multiplyScalar(2.2), 2.4));
  halo.position.copy(lampWorld);
  halo.frustumCulled = false;
  halo.renderOrder = 11;
  ctx.scene.add(halo);
  // the halo quad sits in front of the lantern glass: push it toward the camera in update()

  // chimney smoke
  const PUFFS = 9;
  const nP = smokeSources.length * PUFFS;
  const sp = new Float32Array(nP * 4 * 3), sBase = new Float32Array(nP * 4 * 3), sWind = new Float32Array(nP * 4 * 3);
  const sSeed = new Float32Array(nP * 4), sUv = new Float32Array(nP * 4 * 2);
  const sIdx: number[] = [];
  const corners = [[0, 0], [1, 0], [1, 1], [0, 1]];
  let q = 0;
  const sr = rng(303);
  for (const src of smokeSources) {
    const e = new THREE.Vector3(), n = new THREE.Vector3();
    tangentFrame(src.clone().normalize(), e, n);
    const wind = e.clone().multiplyScalar(0.85).addScaledVector(n, 0.35).normalize();
    const off = sr();
    for (let i = 0; i < PUFFS; i++, q++) {
      const seed = off + i / PUFFS + (sr() - 0.5) * 0.03;
      for (let c = 0; c < 4; c++) {
        const v = q * 4 + c;
        sp.set([src.x, src.y, src.z], v * 3);
        sBase.set([src.x, src.y, src.z], v * 3);
        sWind.set([wind.x, wind.y, wind.z], v * 3);
        sSeed[v] = seed;
        sUv.set(corners[c], v * 2);
      }
      sIdx.push(q * 4, q * 4 + 1, q * 4 + 2, q * 4, q * 4 + 2, q * 4 + 3);
    }
  }
  const smokeGeo = new THREE.BufferGeometry();
  smokeGeo.setAttribute('position', new THREE.BufferAttribute(sp, 3));
  smokeGeo.setAttribute('aBase', new THREE.BufferAttribute(sBase, 3));
  smokeGeo.setAttribute('aWind', new THREE.BufferAttribute(sWind, 3));
  smokeGeo.setAttribute('aSeed', new THREE.BufferAttribute(sSeed, 1));
  smokeGeo.setAttribute('uv', new THREE.BufferAttribute(sUv, 2));
  smokeGeo.setIndex(sIdx);
  const smoke = new THREE.Mesh(smokeGeo, smokeMaterial());
  smoke.frustumCulled = false;
  smoke.renderOrder = 5;
  ctx.scene.add(smoke);

  // ------------------------------------------------------------------ light pools (all 12 slots)
  for (const g of glows.slice(0, 12)) ctx.registerGlow(g.p, g.r, g.c, g.k);

  if (new URLSearchParams(location.search).has('debug'))
    console.log('[village]', { triangles: tris, glows: glows.length, colliders: colliders.length, smoke: smokeSources.length });

  const _v = new THREE.Vector3();
  const _q = new THREE.Quaternion();
  const _e = new THREE.Euler();
  return {
    update(ctx) {
      const t = ctx.time;
      // sails: one full turn every 8 s
      sails.rotation.z = -t * ((Math.PI * 2) / 8);
      // boat bob / roll / pitch
      const bob = 0.05 * Math.sin(t * 1.3) + 0.025 * Math.sin(t * 2.1 + 1.0);
      boat.position.copy(boatDir).multiplyScalar(R - 0.02 + bob);
      _e.set(0.035 * Math.sin(t * 1.1 + 0.4), 0.03 * Math.sin(t * 0.37), 0.06 * Math.sin(t * 0.9 + 1.7));
      boat.quaternion.copy(boatQ).multiply(_q.setFromEuler(_e));
      // lighthouse
      const night = nightAt(lampWorld, ctx.sunDir);
      beam.rotation.y = t * ((Math.PI * 2) / 10);
      beam.visible = night > 0.001;
      beamMat.uniforms.uNight.value = night;
      const hm = halo.material as THREE.ShaderMaterial;
      hm.uniforms.uNight.value = night;
      halo.visible = night > 0.001;
      _v.copy(ctx.camera.position).sub(lampWorld);
      const d = _v.length();
      halo.position.copy(lampWorld).addScaledVector(_v, Math.min(1.2, d * 0.5) / Math.max(d, 1e-3));
    },
  };
}
