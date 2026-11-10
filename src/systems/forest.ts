// A pine forest (+ stray copses), bushes at the forest and village edges, and boulders on the cape,
// the shoreline and the hills. All instanced, placed deterministically from biomeAt().
//
// Draw calls: 4 pine variants + bushes + rocks = 6 meshes (x2 with the shadow pass = 12).
// Trees and bushes sway in the vertex shader with the same wind field as the grass; their shadow
// pass uses a matching customDepthMaterial so shadows sway with them.
import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import type { Ctx, System } from '../core/context';
import { applyPlanetLighting, planetUniforms } from '../core/lighting';
import { rng, simplex3 } from '../core/noise';
import { biomeAt, heightAtXYZ, LANDMARKS, normalAt, R, surfacePoint, uprightQuaternion } from '../core/terrain';
import { floraStat, onlyHas, wantsDebugGround } from '../flora/common';
import { makeDebugGround } from '../flora/debugGround';
import { pathAt } from '../flora/paths';
import { WIND_GLSL } from '../flora/wind';

export const order = 21;

/** Radius (world units) of the little glade kept clear at the forest centre. */
const GLADE = 7;

let treePositions = new Float32Array(0);
/** xyz world positions of every tree trunk base (ground level). Filled once the forest is built. */
export function getTreePositions(): Float32Array {
  return treePositions;
}

// -------------------------------------------------------------------------------------------------
// Geometry (all built at unit height for trees, unit radius for bushes / rocks)
// -------------------------------------------------------------------------------------------------

interface PineVariant {
  tiers: number;
  /** skirt radius of the lowest tier, as a fraction of the height */
  radius: number;
  /** where the lowest tier's skirt sits, as a fraction of the height */
  first: number;
  /** how much the tiers overlap (tier height in units of the tier step) */
  overlap: number;
  trunk: number;
}
const PINES: PineVariant[] = [
  { tiers: 5, radius: 0.27, first: 0.24, overlap: 1.9, trunk: 0.032 }, // tall & slender
  { tiers: 4, radius: 0.33, first: 0.22, overlap: 1.85, trunk: 0.036 }, // classic
  { tiers: 4, radius: 0.4, first: 0.18, overlap: 1.75, trunk: 0.04 }, // broad
  { tiers: 3, radius: 0.42, first: 0.13, overlap: 1.7, trunk: 0.045 }, // young
];

class Builder {
  pos: number[] = [];
  col: number[] = [];
  idx: number[] = [];
  /** per-vertex centre for soft "blob" normals (NaN = keep the geometric normal) */
  blob: number[] = [];
  private c = new THREE.Color();
  v(x: number, y: number, z: number, rgb: [number, number, number], blobY = NaN): number {
    this.pos.push(x, y, z);
    this.c.setRGB(rgb[0], rgb[1], rgb[2], THREE.SRGBColorSpace);
    this.col.push(this.c.r, this.c.g, this.c.b);
    this.blob.push(blobY);
    return this.pos.length / 3 - 1;
  }
  tri(a: number, b: number, c: number) {
    this.idx.push(a, b, c);
  }
  /** ring a (n verts from a0) to ring b (n verts from b0), closed */
  band(a0: number, b0: number, n: number) {
    for (let i = 0; i < n; i++) {
      const j = (i + 1) % n;
      this.tri(a0 + i, b0 + i, b0 + j);
      this.tri(a0 + i, b0 + j, a0 + j);
    }
  }
  fan(apex: number, r0: number, n: number, flip = false) {
    for (let i = 0; i < n; i++) {
      const j = (i + 1) % n;
      if (flip) this.tri(apex, r0 + i, r0 + j);
      else this.tri(apex, r0 + j, r0 + i);
    }
  }
  build(blobMix: number, blobSquash: number): THREE.BufferGeometry {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.pos, 3));
    g.setAttribute('color', new THREE.Float32BufferAttribute(this.col, 3));
    g.setIndex(this.idx);
    g.computeVertexNormals();
    const n = g.attributes.normal as THREE.BufferAttribute;
    const p = new THREE.Vector3(), a = new THREE.Vector3(), b = new THREE.Vector3();
    for (let i = 0; i < n.count; i++) {
      const by = this.blob[i];
      if (Number.isNaN(by)) continue;
      p.set(this.pos[i * 3], this.pos[i * 3 + 1], this.pos[i * 3 + 2]);
      a.fromBufferAttribute(n, i);
      b.set(p.x, (p.y - by) * blobSquash, p.z).normalize();
      a.lerp(b, blobMix).normalize();
      n.setXYZ(i, a.x, a.y, a.z);
    }
    return g;
  }
}

function mixRGB(a: [number, number, number], b: [number, number, number], t: number): [number, number, number] {
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
}

function pineGeometry(v: PineVariant, seed: number): THREE.BufferGeometry {
  const rnd = rng(seed);
  const B = new Builder();
  const SEG = 10;

  // trunk: 7-sided tapered cylinder from below ground into the lowest tiers
  const TS = 7;
  const trunkTop = v.first + (1 - v.first) * 0.45;
  const bark0: [number, number, number] = [0.4, 0.27, 0.17];
  const bark1: [number, number, number] = [0.27, 0.18, 0.12];
  const t0 = B.pos.length / 3;
  for (let i = 0; i < TS; i++) {
    const a = (i / TS) * Math.PI * 2;
    B.v(Math.cos(a) * v.trunk * 1.25, -0.09, Math.sin(a) * v.trunk * 1.25, bark1);
  }
  const t1 = B.pos.length / 3;
  for (let i = 0; i < TS; i++) {
    const a = (i / TS) * Math.PI * 2;
    B.v(Math.cos(a) * v.trunk, v.first * 0.6, Math.sin(a) * v.trunk, bark0);
  }
  const t2 = B.pos.length / 3;
  for (let i = 0; i < TS; i++) {
    const a = (i / TS) * Math.PI * 2;
    B.v(Math.cos(a) * v.trunk * 0.45, trunkTop, Math.sin(a) * v.trunk * 0.45, bark1);
  }
  B.band(t0, t1, TS);
  B.band(t1, t2, TS);

  // foliage tiers
  const n = v.tiers;
  const step = (1 - v.first) / (n - 1 + v.overlap);
  const tierH = step * v.overlap;
  const deep: [number, number, number] = [0.05, 0.13, 0.13];
  const mid: [number, number, number] = [0.14, 0.32, 0.25];
  const tip: [number, number, number] = [0.38, 0.55, 0.29];
  for (let k = 0; k < n; k++) {
    const y0 = v.first + k * step;
    const y1 = y0 + tierH;
    const f = k / Math.max(1, n - 1); // 0 = lowest tier
    const r = v.radius * (1 - 0.66 * (k / n)) * (k === n - 1 ? 0.92 : 1);
    const lift = 0.86 + 0.24 * f; // lower tiers are darker
    const L = (c: [number, number, number], m = 1): [number, number, number] => [c[0] * lift * m, c[1] * lift * m, c[2] * lift * m];
    const by = y0 + tierH * 0.3;
    const rot = rnd() * Math.PI * 2;
    const apex = B.v((rnd() - 0.5) * 0.012, y1, (rnd() - 0.5) * 0.012, L(tip, 1.05), by);
    const r1 = B.pos.length / 3;
    for (let i = 0; i < SEG; i++) {
      const a = rot + (i / SEG) * Math.PI * 2;
      const rr = r * 0.5 * (0.92 + 0.16 * rnd());
      B.v(Math.cos(a) * rr, y1 - tierH * (0.42 + 0.06 * rnd()), Math.sin(a) * rr, L(mixRGB(mid, tip, 0.45)), by);
    }
    const r2 = B.pos.length / 3;
    for (let i = 0; i < SEG; i++) {
      const a = rot + ((i + 0.5) / SEG) * Math.PI * 2;
      const out = i % 2 === 0;
      const rr = r * (out ? 1.06 : 0.9) * (0.93 + 0.14 * rnd());
      const yy = y0 - tierH * (out ? 0.05 : -0.03) + (rnd() - 0.5) * tierH * 0.08;
      B.v(Math.cos(a) * rr, yy, Math.sin(a) * rr, L(out ? tip : mid, out ? 0.95 : 1), by);
    }
    const r3 = B.pos.length / 3;
    for (let i = 0; i < SEG; i++) {
      const a = rot + ((i + 0.5) / SEG) * Math.PI * 2;
      const rr = r * 0.55;
      B.v(Math.cos(a) * rr, y0 + tierH * 0.16, Math.sin(a) * rr, L(deep), by);
    }
    const ctr = B.v(0, y0 + tierH * 0.3, 0, L(deep, 0.8), by);
    B.fan(apex, r1, SEG);
    // ring1 -> ring2 (ring2 is offset by half a segment: zig-zag strip)
    for (let i = 0; i < SEG; i++) {
      const j = (i + 1) % SEG;
      B.tri(r1 + i, r1 + j, r2 + i);
      B.tri(r1 + j, r2 + j, r2 + i);
    }
    // skirt -> underside
    for (let i = 0; i < SEG; i++) {
      const j = (i + 1) % SEG;
      B.tri(r2 + i, r2 + j, r3 + i);
      B.tri(r2 + j, r3 + j, r3 + i);
    }
    B.fan(ctr, r3, SEG, true);
  }
  return B.build(0.45, 0.8);
}

function blobSphere(detail: number, seed: number, rough: number): THREE.BufferGeometry {
  const g = new THREE.IcosahedronGeometry(1, detail);
  g.deleteAttribute('uv');
  const merged = mergeVerts(g);
  const p = merged.attributes.position as THREE.BufferAttribute;
  const v = new THREE.Vector3();
  for (let i = 0; i < p.count; i++) {
    v.fromBufferAttribute(p, i);
    const d = 1 + rough * simplex3(v.x * 1.7 + seed, v.y * 1.7 - seed * 0.3, v.z * 1.7 + seed * 0.7);
    v.multiplyScalar(d);
    p.setXYZ(i, v.x, v.y, v.z);
  }
  merged.computeVertexNormals();
  return merged;
}

/** Weld the non-indexed polyhedron into an indexed mesh so displacement keeps it watertight. */
function mergeVerts(g: THREE.BufferGeometry): THREE.BufferGeometry {
  const p = g.attributes.position as THREE.BufferAttribute;
  const map = new Map<string, number>();
  const pos: number[] = [];
  const idx: number[] = [];
  for (let i = 0; i < p.count; i++) {
    const x = p.getX(i), y = p.getY(i), z = p.getZ(i);
    const key = `${Math.round(x * 1e4)},${Math.round(y * 1e4)},${Math.round(z * 1e4)}`;
    let k = map.get(key);
    if (k === undefined) {
      k = pos.length / 3;
      pos.push(x, y, z);
      map.set(key, k);
    }
    idx.push(k);
  }
  const out = new THREE.BufferGeometry();
  out.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  out.setIndex(idx);
  return out;
}

function bushGeometry(): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [];
  const blobs = [
    [0, 0.45, 0, 0.75],
    [0.55, 0.32, 0.18, 0.55],
    [-0.42, 0.3, -0.3, 0.58],
  ];
  blobs.forEach(([x, y, z, s], i) => {
    const g = blobSphere(1, 3 + i * 5, 0.13);
    g.scale(s, s * 0.82, s);
    g.translate(x, y, z);
    parts.push(g);
  });
  const g = mergeGeometries(parts)!;
  // vertex colours: dark at the base, lighter warm on top; soft normals from the bush centre
  const p = g.attributes.position as THREE.BufferAttribute;
  const n = g.attributes.normal as THREE.BufferAttribute;
  const col = new Float32Array(p.count * 3);
  const c = new THREE.Color(), v = new THREE.Vector3(), nn = new THREE.Vector3();
  for (let i = 0; i < p.count; i++) {
    v.fromBufferAttribute(p, i);
    const t = THREE.MathUtils.clamp(v.y / 1.15, 0, 1);
    c.setRGB(0.08 + 0.22 * t, 0.18 + 0.28 * t, 0.12 + 0.1 * t, THREE.SRGBColorSpace);
    col[i * 3] = c.r; col[i * 3 + 1] = c.g; col[i * 3 + 2] = c.b;
    nn.fromBufferAttribute(n, i).lerp(v.clone().sub(new THREE.Vector3(0, 0.15, 0)).normalize(), 0.55).normalize();
    n.setXYZ(i, nn.x, nn.y, nn.z);
  }
  g.setAttribute('color', new THREE.BufferAttribute(col, 3));
  return g;
}

function rockGeometry(): THREE.BufferGeometry {
  const g = blobSphere(1, 17, 0.22);
  const p = g.attributes.position as THREE.BufferAttribute;
  const col = new Float32Array(p.count * 3);
  const c = new THREE.Color(), v = new THREE.Vector3();
  for (let i = 0; i < p.count; i++) {
    v.fromBufferAttribute(p, i);
    // flatten the bottom so it sits, round the top
    if (v.y < -0.2) v.y = -0.2 + (v.y + 0.2) * 0.4;
    p.setXYZ(i, v.x, v.y, v.z);
    const top = THREE.MathUtils.smoothstep(v.y, 0.35, 0.95);
    const base = 0.56 + 0.1 * simplex3(v.x * 3, v.y * 3, v.z * 3) + 0.08 * v.y;
    c.setRGB(base * 1.04, base * 1.0, base * 0.93, THREE.SRGBColorSpace);
    // a little moss on the crown
    c.lerp(new THREE.Color().setRGB(0.38, 0.47, 0.2, THREE.SRGBColorSpace), top * 0.55);
    col[i * 3] = c.r; col[i * 3 + 1] = c.g; col[i * 3 + 2] = c.b;
  }
  g.setAttribute('color', new THREE.BufferAttribute(col, 3));
  g.computeVertexNormals();
  return g;
}

// -------------------------------------------------------------------------------------------------
// Materials
// -------------------------------------------------------------------------------------------------

function swayGLSL(base: number, gustAmp: number, flut: number): string {
  return /* glsl */ `#include <begin_vertex>
  {
    vec3 tBase = (modelMatrix * instanceMatrix * vec4(0.0, 0.0, 0.0, 1.0)).xyz;
    vec3 tUp = normalize(tBase);
    vec3 wd; float gust;
    flWind(tBase, tUp, uTime, wd, gust);
    float hh = max(position.y, 0.0);
    float ph = dot(tBase, vec3(0.31, 0.53, 0.17));
    float sway = hh * hh * (${base.toFixed(4)} + ${gustAmp.toFixed(4)} * gust + ${flut.toFixed(4)} * sin(uTime * (1.3 + 0.4 * fract(ph)) + ph));
    mat3 im = mat3(instanceMatrix);
    vec3 lw = vec3(dot(normalize(im[0]), wd), dot(normalize(im[1]), wd), dot(normalize(im[2]), wd));
    transformed += lw * sway;
  }`;
}

/** Soft wrapped diffuse for foliage: chunky shapes shade gently instead of going black on the shadow side. */
const WRAP_GLSL = /* glsl */ `
void RE_Direct_Foliage(const in IncidentLight directLight, const in vec3 geometryPosition, const in vec3 geometryNormal,
                       const in vec3 geometryViewDir, const in vec3 geometryClearcoatNormal,
                       const in LambertMaterial material, inout ReflectedLight reflectedLight) {
  float wrapL = saturate((dot(geometryNormal, directLight.direction) + 0.35) / 1.35);
  float back = pow(saturate(dot(-geometryViewDir, directLight.direction)), 6.0) * 0.6;
  reflectedLight.directDiffuse += directLight.color * (wrapL * wrapL + back) * BRDF_Lambert(material.diffuseColor);
}
#undef RE_Direct
#define RE_Direct RE_Direct_Foliage
`;

function swayMaterials(key: string, sway: string): { mat: THREE.MeshLambertMaterial; depth: THREE.MeshDepthMaterial } {
  const mat = applyPlanetLighting(new THREE.MeshLambertMaterial({ vertexColors: true }), {
    key: `forest-${key}`,
    patch: (shader) => {
      shader.vertexShader = shader.vertexShader
        .replace('void main() {', `${WIND_GLSL}\nvoid main() {`)
        .replace('#include <begin_vertex>', sway);
      shader.fragmentShader = shader.fragmentShader.replace(
        '#include <lights_lambert_pars_fragment>',
        `#include <lights_lambert_pars_fragment>\n${WRAP_GLSL}`,
      );
    },
  });
  const depth = new THREE.MeshDepthMaterial({ depthPacking: THREE.RGBADepthPacking });
  depth.onBeforeCompile = (shader) => {
    shader.uniforms.uTime = planetUniforms.uTime;
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>\nuniform float uTime;\n${WIND_GLSL}`)
      .replace('#include <begin_vertex>', sway);
  };
  depth.customProgramCacheKey = () => `forest-depth-${key}`;
  return { mat, depth };
}

// -------------------------------------------------------------------------------------------------
// Placement
// -------------------------------------------------------------------------------------------------

const ss = (a: number, b: number, x: number) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};
const angleTo = (d: THREE.Vector3, l: THREE.Vector3) => Math.acos(Math.max(-1, Math.min(1, d.dot(l))));

/** Poisson-ish occupancy on the planet surface (world-space spatial hash). */
class Occupancy {
  private cells = new Map<number, number[]>();
  private pts: number[] = []; // x,y,z,r
  constructor(private cell: number) {}
  private key(x: number, y: number, z: number) {
    const c = this.cell;
    return ((Math.floor(x / c) + 64) * 128 + (Math.floor(y / c) + 64)) * 128 + (Math.floor(z / c) + 64);
  }
  /** true if a disc of radius r at p clears every stored disc by `scale` x (r + r_j), and min distance `minD` */
  free(p: THREE.Vector3, r: number, scale: number, minD = 0): boolean {
    const c = this.cell;
    const cx = Math.floor(p.x / c), cy = Math.floor(p.y / c), cz = Math.floor(p.z / c);
    for (let dx = -1; dx <= 1; dx++)
      for (let dy = -1; dy <= 1; dy++)
        for (let dz = -1; dz <= 1; dz++) {
          const list = this.cells.get(((cx + dx + 64) * 128 + (cy + dy + 64)) * 128 + (cz + dz + 64));
          if (!list) continue;
          for (const i of list) {
            const qx = this.pts[i] - p.x, qy = this.pts[i + 1] - p.y, qz = this.pts[i + 2] - p.z;
            const need = Math.max(minD, (r + this.pts[i + 3]) * scale);
            if (qx * qx + qy * qy + qz * qz < need * need) return false;
          }
        }
    return true;
  }
  add(p: THREE.Vector3, r: number) {
    const i = this.pts.length;
    this.pts.push(p.x, p.y, p.z, r);
    const k = this.key(p.x, p.y, p.z);
    const list = this.cells.get(k);
    if (list) list.push(i);
    else this.cells.set(k, [i]);
  }
}

interface Inst {
  pos: THREE.Vector3;
  quat: THREE.Quaternion;
  scale: THREE.Vector3;
  color: THREE.Color;
}

function randomDir(rand: () => number, out: THREE.Vector3): THREE.Vector3 {
  const z = rand() * 2 - 1;
  const a = rand() * Math.PI * 2;
  const s = Math.sqrt(1 - z * z);
  return out.set(Math.cos(a) * s, z, Math.sin(a) * s);
}

interface Collider { x: number; y: number; z: number; r: number }

function placeAll(colliders: Collider[]) {
  /** true if p keeps clear of every village collider by extra world units, and is off the dirt paths */
  // keep the classic camera spots (hill top, spawn) free of bushes and boulders in the foreground
  const spots = [LANDMARKS.hills, LANDMARKS.spawn].map((s) => surfacePoint(s, new THREE.Vector3()));
  const clear = (p: THREE.Vector3, dir: THREE.Vector3, extra: number) => {
    for (const s of spots) if (s.distanceToSquared(p) < (4.5 + extra) * (4.5 + extra)) return false;
    for (const c of colliders) {
      const dx = c.x - p.x, dy = c.y - p.y, dz = c.z - p.z;
      const need = c.r + extra;
      if (dx * dx + dy * dy + dz * dz < need * need) return false;
    }
    return pathAt(dir, extra * 0.5) < 0.05;
  };
  const trees: Inst[][] = PINES.map(() => []);
  const bushes: Inst[] = [];
  const rocks: Inst[] = [];
  const occTrees = new Occupancy(6);
  const occSmall = new Occupancy(4);
  const d = new THREE.Vector3();
  const tmp = new THREE.Vector3();

  // ---- trees ----
  {
    const rand = rng(4242);
    const CAND = 160000;
    let count = 0;
    for (let c = 0; c < CAND && count < 1000; c++) {
      randomDir(rand, d);
      const u0 = rand(), u1 = rand(), u2 = rand(), u3 = rand(), u4 = rand(), u5 = rand();
      // quick reject: the forest + copses only exist on land well above sea level
      if (heightAtXYZ(d.x, d.y, d.z) < 1.25) continue;
      // a small glade at the forest centre
      if (angleTo(d, LANDMARKS.forest) < GLADE / R) continue;
      const b = biomeAt(d);
      if (b.h < 1.25 || b.village > 0.005 || b.rock > 0.4 || b.forest < 0.04) continue;
      if (angleTo(d, LANDMARKS.windmill) < 0.16 || angleTo(d, LANDMARKS.lighthouse) < 0.24) continue;
      const p = ss(0.04, 0.4, b.forest) * Math.pow(1 - b.sand, 3);
      if (u0 > p) continue;
      const centre = ss(0.3, 0.9, b.forest);
      let v: number;
      if (centre > 0.5) v = u1 < 0.4 ? 0 : u1 < 0.75 ? 1 : u1 < 0.9 ? 2 : 3;
      else v = u1 < 0.12 ? 0 : u1 < 0.4 ? 1 : u1 < 0.7 ? 2 : 3;
      const H = (v === 0 ? 7.5 + u2 * 2.5 : v === 1 ? 5.5 + u2 * 2.5 : v === 2 ? 4.5 + u2 * 2 : 2.6 + u2 * 1.6) * (0.82 + 0.22 * centre);
      const sxz = 0.85 + 0.3 * u3;
      const fr = PINES[v].radius * H * sxz;
      surfacePoint(d, tmp);
      if (!occTrees.free(tmp, fr, 0.42, 1.25)) continue;
      if (!clear(tmp, d, fr * 0.7)) continue;
      occTrees.add(tmp, fr);
      const pos = surfacePoint(d, new THREE.Vector3(), -0.35);
      const quat = uprightQuaternion(d, u4 * Math.PI * 2);
      const tint = 0.85 + 0.25 * u5;
      const col = new THREE.Color(tint * (0.95 + 0.1 * rand()), tint, tint * (0.92 + 0.14 * rand()));
      trees[v].push({ pos, quat, scale: new THREE.Vector3(H * sxz, H, H * sxz * (0.92 + 0.16 * rand())), color: col });
      count++;
    }
  }

  // ---- bushes ----
  {
    const rand = rng(5151);
    for (let c = 0; c < 60000 && bushes.length < 420; c++) {
      randomDir(rand, d);
      const u0 = rand(), u1 = rand(), u2 = rand(), u3 = rand();
      if (heightAtXYZ(d.x, d.y, d.z) < 1.0) continue;
      const b = biomeAt(d);
      if (b.rock > 0.4 || b.sand > 0.4) continue;
      if (angleTo(d, LANDMARKS.windmill) < 0.12 || angleTo(d, LANDMARKS.lighthouse) < 0.14) continue;
      const forestEdge = ss(0.02, 0.12, b.forest) * ss(0.65, 0.3, b.forest);
      // village outskirts: clumps (noise-gated) in a broad band outside the green, never a neat ring
      const av = angleTo(d, LANDMARKS.village);
      const villageEdge = ss(0.3, 0.34, av) * ss(0.48, 0.38, av) * ss(0.15, 0.45, simplex3(d.x * 11 + 4, d.y * 11, d.z * 11 - 2));
      const glade = ss(GLADE + 2.5, GLADE, angleTo(d, LANDMARKS.forest) * R);
      const sprinkle = av > 0.38 ? 0.004 * b.grass : 0;
      const p = Math.max(forestEdge * 0.55, villageEdge * 0.45, sprinkle, glade * 0.5);
      if (u0 > p) continue;
      const s = 0.55 + 0.7 * u1 * u1;
      surfacePoint(d, tmp);
      if (!occTrees.free(tmp, s, 0.6, 0.9)) continue;
      if (!occSmall.free(tmp, s, 1.0)) continue;
      if (!clear(tmp, d, s + 0.4)) continue;
      occSmall.add(tmp, s);
      const pos = surfacePoint(d, new THREE.Vector3(), -0.2 * s);
      const quat = uprightQuaternion(d, u2 * Math.PI * 2);
      const t = 0.85 + 0.3 * u3;
      const warm = rand();
      bushes.push({ pos, quat, scale: new THREE.Vector3(s, s * (0.8 + 0.3 * rand()), s), color: new THREE.Color(t * (0.9 + 0.2 * warm), t, t * (0.95 - 0.1 * warm)) });
    }
  }

  // ---- rocks ----
  {
    const rand = rng(6262);
    const n = new THREE.Vector3();
    const up = new THREE.Vector3();
    const addRock = (dir: THREE.Vector3, size: number) => {
      surfacePoint(dir, tmp);
      if (!occTrees.free(tmp, size, 0.7, 0.8)) return false;
      if (!occSmall.free(tmp, size, 0.75)) return false;
      if (!clear(tmp, dir, size + 0.5)) return false;
      occSmall.add(tmp, size);
      normalAt(dir, n);
      up.copy(n).multiplyScalar(0.75).addScaledVector(dir, 0.25).normalize();
      const sy = size * (0.6 + 0.4 * rand());
      const pos = surfacePoint(dir, new THREE.Vector3(), -0.32 * sy);
      const quat = uprightQuaternion(up, rand() * Math.PI * 2);
      const g = 0.82 + 0.3 * rand();
      const warm = rand();
      rocks.push({
        pos,
        quat,
        scale: new THREE.Vector3(size * (0.85 + 0.4 * rand()), sy, size * (0.8 + 0.4 * rand())),
        color: new THREE.Color(g * (0.97 + 0.08 * warm), g * (0.97 + 0.03 * warm), g * (1.03 - 0.08 * warm)),
      });
      return true;
    };
    const cl = new THREE.Vector3();
    for (let c = 0; c < 40000 && rocks.length < 380; c++) {
      randomDir(rand, d);
      const u0 = rand(), u1 = rand();
      const al = angleTo(d, LANDMARKS.lighthouse);
      const b = biomeAt(d);
      if (b.village > 0.05 || angleTo(d, LANDMARKS.village) < 0.36 || angleTo(d, LANDMARKS.windmill) < 0.1) continue;
      let p = 0, size = 0.6, cluster = 1;
      if (al > 0.06 && al < 0.2 && b.h > -0.8) {
        p = 0.6; size = 0.6 + 1.2 * u1; cluster = 3;
      } else if (b.h > -0.6 && b.h < 0.95) {
        p = 0.05; size = 0.4 + 0.8 * u1; cluster = 2;
      } else if (b.rock > 0.3) {
        p = 0.2; size = 0.5 + 1.2 * u1; cluster = 2;
      } else if (b.h > 0.95) {
        p = 0.002 + 0.004 * b.grass; size = 0.5 + 1.1 * u1 * u1; cluster = 2;
      }
      if (u0 > p) continue;
      if (!addRock(d, size)) continue;
      const extra = Math.floor(rand() * (cluster + 1));
      for (let k = 0; k < extra; k++) {
        const a = rand() * Math.PI * 2, rr = size * (1.2 + rand() * 1.4);
        const e = new THREE.Vector3(), no = new THREE.Vector3();
        tangentFrameLocal(d, e, no);
        cl.copy(d).multiplyScalar(R).addScaledVector(e, Math.cos(a) * rr).addScaledVector(no, Math.sin(a) * rr).normalize();
        addRock(cl, size * (0.35 + 0.5 * rand()));
      }
    }
  }
  return { trees, bushes, rocks };
}

function tangentFrameLocal(d: THREE.Vector3, e: THREE.Vector3, n: THREE.Vector3) {
  e.crossVectors(Math.abs(d.y) > 0.999 ? new THREE.Vector3(1, 0, 0) : new THREE.Vector3(0, 1, 0), d).normalize();
  n.crossVectors(d, e);
}

function instanced(geo: THREE.BufferGeometry, mat: THREE.Material, list: Inst[], name: string): THREE.InstancedMesh {
  const mesh = new THREE.InstancedMesh(geo, mat, Math.max(1, list.length));
  mesh.name = name;
  const m = new THREE.Matrix4();
  list.forEach((it, i) => {
    m.compose(it.pos, it.quat, it.scale);
    mesh.setMatrixAt(i, m);
    mesh.setColorAt(i, it.color);
  });
  mesh.count = list.length;
  mesh.instanceMatrix.needsUpdate = true;
  if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  mesh.frustumCulled = false;
  return mesh;
}

/**
 * The village's solid footprints (houses, lighthouse, windmill, lamps...), so nothing grows through them.
 * village.ts fills them synchronously when it is created, which happens concurrently with us; wait for it
 * (bounded) instead of importing it eagerly, so a broken village file can't take the forest down.
 */
async function villageColliders(): Promise<Collider[]> {
  if (!onlyHas('village')) return [];
  const load = import.meta.glob('./village.ts')['./village.ts'];
  if (!load) return [];
  try {
    const mod = (await load()) as { getColliders?: () => Collider[] };
    for (let i = 0; i < 400; i++) {
      const c = mod.getColliders?.() ?? [];
      if (c.length) return c.slice();
      await new Promise((r) => setTimeout(r, 10));
    }
  } catch {
    // village failed to load: grow without it
  }
  return [];
}

export default async function createForest(ctx: Ctx): Promise<System> {
  const colliders = await villageColliders();
  const t0 = performance.now();
  if (wantsDebugGround(ctx.mode) && !onlyHas('grass')) ctx.scene.add(makeDebugGround());
  const t1 = performance.now();
  const { trees, bushes, rocks } = placeAll(colliders);
  const t2 = performance.now();

  const group = new THREE.Group();
  group.name = 'forest';
  const tree = swayMaterials('pine', swayGLSL(0.004, 0.018, 0.004));
  const all: number[] = [];
  PINES.forEach((v, i) => {
    const mesh = instanced(pineGeometry(v, 100 + i * 17), tree.mat, trees[i], `pines-${i}`);
    mesh.customDepthMaterial = tree.depth;
    group.add(mesh);
    for (const t of trees[i]) {
      // trunk base at ground level (instances are sunk 0.35)
      const g = t.pos.clone().normalize();
      surfacePoint(g, g);
      all.push(g.x, g.y, g.z);
    }
  });
  treePositions = new Float32Array(all);

  const bush = swayMaterials('bush', swayGLSL(0.004, 0.02, 0.006));
  const bushMesh = instanced(bushGeometry(), bush.mat, bushes, 'bushes');
  bushMesh.customDepthMaterial = bush.depth;
  group.add(bushMesh);

  const rockMat = applyPlanetLighting(new THREE.MeshLambertMaterial({ vertexColors: true, flatShading: true }), { key: 'forest-rock' });
  group.add(instanced(rockGeometry(), rockMat, rocks, 'rocks'));
  ctx.scene.add(group);

  floraStat('forest', {
    trees: trees.map((t) => t.length),
    bushes: bushes.length,
    rocks: rocks.length,
    groundMs: Math.round(t1 - t0),
    placeMs: Math.round(t2 - t1),
    colliders: colliders.length,
  });
  return {};
}
