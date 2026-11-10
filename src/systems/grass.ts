// Rolling grass hills that sway: a dense instanced meadow + wildflowers over the whole planet.
//
// Two layers of TUFTS (each instance is a whole tuft of blades, so density is cheap):
//   hero   - 4 slim curved blades (3 segments each), 0.3-0.8 tall, occasional seed stalk. Thins out
//            with distance (per-blade random threshold, shrinking smoothly: no popping).
//   carpet - 8 short single-triangle blades that hide the ground in the near field; gone by ~36 units.
// Blade roots take exactly the terrain's ground colour (same noise + palette as terrain.ts), so the
// grass grows OUT of the ground instead of standing on it, and lighten/warm toward the tips.
// Placement is done once, deterministically, on a cube-sphere grid of biome samples. Shape, wind,
// colour and LOD all happen in the vertex shader of a patched MeshLambertMaterial (planet lighting,
// receives the sun's shadow map). Grass and flowers never cast shadows.
import * as THREE from 'three';
import type { Ctx, System } from '../core/context';
import { applyPlanetLighting } from '../core/lighting';
import { simplex3, rng } from '../core/noise';
import { biomeAt, heightAtXYZ, LANDMARKS, R } from '../core/terrain';
import { NOISE_GLSL } from '../terrain/glsl';
import { floraStat, onlyHas, SRGB_GLSL, wantsDebugGround } from '../flora/common';
import { makeDebugGround } from '../flora/debugGround';
import { pathAt } from '../flora/paths';
import { WIND_GLSL } from '../flora/wind';

export const order = 20;

/** Tufts on the planet. Hero tufts are 4 blades x 5 tris, carpet tufts 8 blades x 1 tri. */
const HERO_TUFTS = 140_000;
const CARPET_TUFTS = 260_000;
const HERO_BLADES = 4;
const CARPET_BLADES = 10;
/** Cube-sphere grid resolution per face for the biome samples (~1 m cells). */
const GRID = 100;
/** Flowers fade between these camera distances. */
const FAR0 = 65;
const FAR1 = 105;

// -------------------------------------------------------------------------------------------------
// Shaders
// -------------------------------------------------------------------------------------------------

/** Per-blade frame, wind and arc bend. Shared by blades and flowers (they bend with the same gusts). */
const BEND_GLSL = /* glsl */ `
attribute vec4 iPos;   // xyz root (world), w: blade = dryness/edge 0..1, flower = palette slot
attribute vec4 iData;  // x,y = cos/sin yaw, z = height, w = random 0..1
varying vec3 vFlCol;
varying float vTrans;
${WIND_GLSL}
${SRGB_GLSL}
struct FlBend { vec3 up; vec3 side; vec3 face; vec3 bd; float th; float gust; float dist; };
FlBend flBend(float stiff) {
  FlBend b;
  vec3 root = iPos.xyz;
  b.up = normalize(root);
  vec3 ref = abs(b.up.y) < 0.99 ? vec3(0.0, 1.0, 0.0) : vec3(1.0, 0.0, 0.0);
  vec3 e = normalize(cross(ref, b.up));
  vec3 n = cross(b.up, e);
  b.side = e * iData.x + n * iData.y;
  b.face = cross(b.side, b.up);
  b.dist = distance(cameraPosition, root);
  vec3 wd; float gust;
  flWind(root, b.up, uTime, wd, gust);
  b.gust = gust;
  float r = iData.w;
  float flut = sin(uTime * (2.4 + 2.0 * r) + r * 40.0 + gust * 4.0);
  float lean = 0.10 + 0.32 * fract(r * 3.71);
  vec3 B = b.face * lean + (wd * (0.14 + gust * 0.9 + flut * 0.07) + b.side * flut * 0.06) * stiff;
  float bl = length(B);
  b.th = clamp(bl, 1e-3, 1.3);
  b.bd = B / max(bl, 1e-4);
  return b;
}
// Point at fraction s along an arc of length 1 and total turning th, bending toward bd.
vec3 flArc(FlBend b, float s) {
  float a = b.th * s;
  return b.up * (sin(a) / b.th) + b.bd * ((1.0 - cos(a)) / b.th);
}
vec3 flTan(FlBend b, float s) { float a = b.th * s; return b.up * cos(a) + b.bd * sin(a); }
vec3 flUpper(FlBend b, float s) { float a = b.th * s; return b.up * sin(a) - b.bd * cos(a); }
`;

/** Tuft vertex shader declarations (blades). */
const TUFT_GLSL = /* glsl */ `
attribute vec4 iPos;    // xyz tuft root (world), w = floor(height*1000) + random
attribute vec4 iBio;    // village, forest, sand, cavity (as terrain.ts computes it)
attribute vec4 aBlade;  // blade in the tuft: x,y offset (m), z yaw offset, w height multiplier
attribute vec3 aBlade2; // x lean, y width multiplier, z blade index
varying vec3 vFlCol;
varying float vTrans;
${NOISE_GLSL}
${WIND_GLSL}
// The terrain's ground colour on grass land (mirrors TERRAIN_COLOR in src/systems/terrain.ts, minus
// the sub-metre dabs), so blade roots match the ground they grow from. Linear colour.
vec3 grGround(vec3 P, vec4 bio) {
  float nBig = snoise(P * 0.022 + 3.1);
  float nMid = fbm3n(P * 0.075);
  float nSm = snoise(P * 0.42 + 7.7);
  float cavN = smoothstep(0.05, 0.9, bio.w);
  float ridge = smoothstep(-0.1, -0.8, bio.w);
  vec3 gYellow = srgb(vec3(0.76, 0.77, 0.36));
  vec3 gMid = srgb(vec3(0.52, 0.69, 0.28));
  vec3 gDeep = srgb(vec3(0.30, 0.52, 0.22));
  vec3 g = mix(gMid, gYellow, smoothstep(-0.55, 0.65, nBig * 0.85 + nMid * 0.5));
  g = mix(g, gDeep, clamp(cavN * 0.7 + smoothstep(0.2, 0.8, -nMid) * 0.35, 0.0, 1.0));
  g = mix(g, gYellow, ridge * 0.35);
  g = mix(g, gDeep * 1.1, smoothstep(0.3, 0.8, nSm) * 0.35);
  g = mix(g, gYellow * vec3(1.06, 1.0, 0.9), smoothstep(0.35, 0.85, -nSm) * 0.3);
  g = mix(g, srgb(vec3(0.31, 0.43, 0.18)), smoothstep(0.1, 0.65, bio.y + 0.15 * nSm) * 0.8);   // forest moss
  g = mix(g, srgb(vec3(0.62, 0.67, 0.35)), smoothstep(0.05, 0.6, bio.x));                      // village green
  vec3 sandC = mix(srgb(vec3(0.91, 0.77, 0.60)), srgb(vec3(0.86, 0.70, 0.53)), smoothstep(-0.3, 0.6, nMid + 0.4 * nSm));
  g = mix(g, sandC, smoothstep(0.25, 0.65, bio.z + 0.18 * nSm));
  return g;
}
`;

function tuftMain(o: { thin0: number; thin1: number; width: number; stalk: number }): string {
  const f = (x: number) => x.toFixed(4);
  return /* glsl */ `
  vec3 root0 = iPos.xyz;
  vec3 up = normalize(root0);
  float tH = floor(iPos.w) * 0.001;
  float tr = fract(iPos.w);
  float dist = distance(cameraPosition, root0);
  float br = fract(tr * 7.13 + aBlade2.z * 0.6180339);
  // distance thinning: a growing random fraction of blades shrinks smoothly to nothing
  float keep = 1.0 - smoothstep(${f(o.thin0)}, ${f(o.thin1)}, dist);
  float vis = smoothstep(0.0, 0.12, keep * 1.12 - br);
  // cheap per-tuft culls before the wind and colour noise: tufts over the horizon or well outside the
  // view collapse to a degenerate point (the GPU still fetches them, but skips all the shading work)
  vec4 rc = projectionMatrix * viewMatrix * vec4(root0 + up * 0.4, 1.0);
  float mg = 1.2 * projectionMatrix[1][1];
  if (dot(up, cameraPosition - root0) < -4.0 || rc.w < -1.5
      || abs(rc.x) > rc.w + mg || abs(rc.y) > rc.w + mg) vis = 0.0;
  vec3 flPos = root0;
  vec3 objectNormal = up;
  vFlCol = vec3(0.0);
  vTrans = 0.0;
  if (vis > 0.0) {
    vec3 ref = abs(up.y) < 0.99 ? vec3(0.0, 1.0, 0.0) : vec3(1.0, 0.0, 0.0);
    vec3 e = normalize(cross(ref, up));
    vec3 n = cross(up, e);
    float ty = tr * 43.98;
    vec3 te = e * cos(ty) + n * sin(ty);
    vec3 tn = cross(up, te);
    vec3 root = root0 + te * aBlade.x + tn * aBlade.y;
    float yaw = ty + aBlade.z;
    vec3 side = e * cos(yaw) + n * sin(yaw);
    vec3 face = cross(side, up);
    float stalk = (aBlade2.z < 0.5 && fract(tr * 31.7) < ${f(o.stalk)}) ? 1.0 : 0.0;
    float H = tH * aBlade.w * (0.85 + 0.3 * fract(br * 3.7)) * (1.0 + 0.7 * stalk) * vis;
    float W = ${f(o.width)} * aBlade2.y * mix(0.6, 1.0, clamp(tH * 2.2, 0.0, 1.0)) * (1.0 - 0.45 * stalk)
            * (1.0 + dist * 0.012 + (1.0 - keep) * 0.7);
    vec3 wd; float gust;
    flWind(root0, up, uTime, wd, gust);
    float flut = sin(uTime * (2.4 + 2.0 * br) + br * 40.0 + gust * 4.0);
    vec3 B = face * aBlade2.x + wd * (0.14 + gust * 0.9 + flut * 0.07) + side * flut * 0.06;
    float bl = length(B);
    float th = clamp(bl, 1e-3, 1.3);
    vec3 bd = B / max(bl, 1e-4);
    float s = position.y;
    float a = th * s;
    flPos = root + H * (up * (sin(a) / th) + bd * ((1.0 - cos(a)) / th)) + side * (position.x * W * (1.0 + 0.3 * gust));
    // shade as a soft mass: normals mostly the local up
    objectNormal = normalize(mix(up * sin(a) - bd * cos(a), up, 0.78));

    vec3 g = grGround(root0, iBio);
    float pv = 0.86 + 0.26 * fract(br * 9.31);                          // per-blade value variation
    vec3 body = mix(g * vec3(0.74, 0.93, 0.66), srgb(vec3(0.40, 0.62, 0.22)), 0.45) * pv;                          // a touch deeper and greener than the ground
    vec3 tip = mix(g * vec3(1.0, 1.08, 0.82), srgb(vec3(0.62, 0.78, 0.30)), 0.4) * pv;
    tip = mix(tip, srgb(vec3(0.86, 0.80, 0.44)), 0.4 * stalk + 0.25 * step(0.8, fract(br * 5.1)));
    vec3 c = mix(g * 0.86, body, smoothstep(0.0, 0.4, s));  // base occlusion gives the mass depth
    c = mix(c, tip, smoothstep(0.45, 1.0, s));
    c = mix(c, mix(g, tip, 0.5), smoothstep(30.0, 90.0, dist));
    // gust crests flatten the blades and show their pale sheen
    c = mix(c * 0.94, srgb(vec3(0.93, 0.93, 0.62)), gust * (0.05 + 0.3 * s));
    vFlCol = c;
    vTrans = s * s;
  }
`;
}
// Flower: a thin stem (1 tri) and a 4-sided bipyramid head (8 tris). aPart: 0 stem, 1 head.
const FLOWER_MAIN = /* glsl */ `
  FlBend fb = flBend(0.75);
  float fr = iData.w;
  float far = smoothstep(${(FAR0 - 15).toFixed(1)} + 30.0 * fr, ${(FAR1 - 25).toFixed(1)} + 50.0 * fr, fb.dist);
  float fh = iData.z * (1.0 - far);
  vec3 flPos;
  vec3 objectNormal;
  float hr = (0.055 + 0.03 * fract(fr * 5.3)) * (1.0 - far) * (1.0 + fb.dist * 0.008);
  if (aPart < 0.5) {
    float fs = position.y;
    flPos = iPos.xyz + fh * flArc(fb, fs) + fb.side * (position.x * 0.018);
    objectNormal = fb.up;
    vFlCol = flLin(mix(vec3(0.12, 0.24, 0.10), vec3(0.32, 0.50, 0.18), fs));
    vTrans = 0.3 * fs;
  } else {
    vec3 t = flTan(fb, 1.0);
    vec3 top = iPos.xyz + fh * flArc(fb, 1.0);
    vec3 lp = position * vec3(1.0, 0.55, 1.0);
    flPos = top + (fb.side * lp.x + fb.face * lp.z) * hr + t * lp.y * hr;
    objectNormal = normalize(fb.side * lp.x + fb.face * lp.z + t * (lp.y * 2.0 + 0.6));
    int slot = int(iPos.w + 0.5);
    vec3 c = slot == 0 ? vec3(0.97, 0.95, 0.88)      // white daisy
           : slot == 1 ? vec3(1.00, 0.84, 0.25)      // buttercup yellow
           : slot == 2 ? vec3(0.98, 0.60, 0.72)      // pink
           :             vec3(0.72, 0.62, 0.95);     // lavender
    c *= 0.9 + 0.18 * fract(fr * 17.3);
    // a warm eye in the centre of the top
    c = mix(c, vec3(0.95, 0.70, 0.20), smoothstep(0.6, 1.0, position.y) * (slot == 0 ? 0.8 : 0.25));
    vFlCol = flLin(c);
    vTrans = 0.6;
  }
`;

const FRAG_DECL = /* glsl */ `
varying vec3 vFlCol;
varying float vTrans;
// Wrapped diffuse + translucent back-light toward the sun (glows at sunset when looking into the sun).
void RE_Direct_Flora(const in IncidentLight directLight, const in vec3 geometryPosition, const in vec3 geometryNormal,
                     const in vec3 geometryViewDir, const in vec3 geometryClearcoatNormal,
                     const in LambertMaterial material, inout ReflectedLight reflectedLight) {
  float nl = dot(geometryNormal, directLight.direction);
  // wrap grows toward the tip: roots light exactly like the ground they grow from
  float wk = 0.3 * sqrt(vTrans);
  float wrapL = saturate((nl + wk) / (1.0 + wk));
  float back = pow(saturate(dot(-geometryViewDir, directLight.direction)), 4.0);
  vec3 irr = directLight.color * (wrapL + back * vTrans * 2.6);
  reflectedLight.directDiffuse += irr * BRDF_Lambert(material.diffuseColor);
}
#undef RE_Direct
#define RE_Direct RE_Direct_Flora
`;

function patchFrag(shader: THREE.WebGLProgramParametersWithUniforms) {
  shader.fragmentShader = shader.fragmentShader
    .replace('#include <lights_lambert_pars_fragment>', `#include <lights_lambert_pars_fragment>\n${FRAG_DECL}`)
    .replace('#include <color_fragment>', '#include <color_fragment>\ndiffuseColor.rgb *= vFlCol;')
    // blades are lit as soft "meadow" surfaces: keep the shading normal on the sky side for both faces
    .replace('#include <normal_fragment_begin>', '#include <normal_fragment_begin>\n#ifdef DOUBLE_SIDED\nnormal *= faceDirection;\n#endif');
}

function makeTuftMaterial(key: string, main: string): THREE.MeshLambertMaterial {
  return applyPlanetLighting(new THREE.MeshLambertMaterial({ color: 0xffffff, side: THREE.DoubleSide }), {
    key: `flora-${key}`,
    patch: (shader) => {
      shader.vertexShader = shader.vertexShader
        .replace('void main() {', `${TUFT_GLSL}\nvoid main() {`)
        .replace('#include <beginnormal_vertex>', main)
        .replace('#include <begin_vertex>', 'vec3 transformed = flPos;');
      patchFrag(shader);
    },
  });
}

function makeFlowerMaterial(): THREE.MeshLambertMaterial {
  return applyPlanetLighting(new THREE.MeshLambertMaterial({ color: 0xffffff, side: THREE.DoubleSide }), {
    key: 'flora-flower',
    patch: (shader) => {
      shader.vertexShader = shader.vertexShader
        .replace('void main() {', `${BEND_GLSL}\nattribute float aPart;\nvoid main() {`)
        .replace('#include <beginnormal_vertex>', FLOWER_MAIN)
        .replace('#include <begin_vertex>', 'vec3 transformed = flPos;');
      patchFrag(shader);
    },
  });
}
// -------------------------------------------------------------------------------------------------
// Placement
// -------------------------------------------------------------------------------------------------

function cubeDir(face: number, a: number, b: number, out: THREE.Vector3): THREE.Vector3 {
  // tan warp makes cells nearly equal-area
  const u = Math.tan((a * Math.PI) / 4);
  const v = Math.tan((b * Math.PI) / 4);
  switch (face) {
    case 0: return out.set(1, v, -u).normalize();
    case 1: return out.set(-1, v, u).normalize();
    case 2: return out.set(u, 1, -v).normalize();
    case 3: return out.set(u, -1, v).normalize();
    case 4: return out.set(u, v, 1).normalize();
    default: return out.set(-u, v, -1).normalize();
  }
}

class Grow {
  pos: Float32Array;
  data: Float32Array;
  count = 0;
  constructor(cap: number) {
    this.pos = new Float32Array(cap * 4);
    this.data = new Float32Array(cap * 4);
  }
  push(x: number, y: number, z: number, w: number, a: number, b: number, c: number, d: number) {
    if (this.count * 4 >= this.pos.length) {
      const p = new Float32Array(this.pos.length * 2);
      p.set(this.pos);
      this.pos = p;
      const q = new Float32Array(this.data.length * 2);
      q.set(this.data);
      this.data = q;
    }
    const i = this.count++ * 4;
    this.pos[i] = x; this.pos[i + 1] = y; this.pos[i + 2] = z; this.pos[i + 3] = w;
    this.data[i] = a; this.data[i + 1] = b; this.data[i + 2] = c; this.data[i + 3] = d;
  }
}

const ss = (a: number, b: number, x: number) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

interface Tufts { pos: Float32Array; bio: Float32Array; count: number }

function place() {
  const N = GRID + 1;
  const dirs = new Float32Array(6 * N * N * 3);
  const grass = new Float32Array(6 * N * N);
  const village = new Float32Array(6 * N * N);
  const forest = new Float32Array(6 * N * N);
  const sand = new Float32Array(6 * N * N);
  const cav = new Float32Array(6 * N * N);
  const d = new THREE.Vector3(), q = new THREE.Vector3();
  const e = new THREE.Vector3(), n = new THREE.Vector3(), up = new THREE.Vector3(0, 1, 0), ax = new THREE.Vector3(1, 0, 0);
  const CAV = 2.5 / R; // terrain.ts estimates cavity from neighbours ~2.5 units away
  const hq = (de: number, dn: number) => {
    q.copy(d).addScaledVector(e, de).addScaledVector(n, dn).normalize();
    return heightAtXYZ(q.x, q.y, q.z);
  };
  for (let f = 0; f < 6; f++)
    for (let j = 0; j < N; j++)
      for (let i = 0; i < N; i++) {
        const k = (f * N + j) * N + i;
        cubeDir(f, (i / GRID) * 2 - 1, (j / GRID) * 2 - 1, d);
        dirs[k * 3] = d.x; dirs[k * 3 + 1] = d.y; dirs[k * 3 + 2] = d.z;
        const b = biomeAt(d);
        grass[k] = b.grass;
        village[k] = b.village;
        forest[k] = b.forest;
        sand[k] = b.sand;
        if (b.grass > 0) {
          tangentFrameFast(d, e, n, up, ax);
          cav[k] = (hq(CAV, 0) + hq(-CAV, 0) + hq(0, CAV) + hq(0, -CAV)) * 0.25 - b.h;
        }
      }

  // acceptance: dense even where the grass weight is modest (edges get short fine grass, not sparse big blades)
  const acceptW = (w: number, v: number) => ss(0.02, 0.28, w) * (1 - 0.78 * v);

  // pass 1: weighted area -> tuft density
  const cellArea = new Float32Array(6 * GRID * GRID);
  let weighted = 0;
  const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3();
  for (let f = 0; f < 6; f++)
    for (let j = 0; j < GRID; j++)
      for (let i = 0; i < GRID; i++) {
        const k00 = (f * N + j) * N + i;
        const k10 = k00 + 1, k01 = k00 + N, k11 = k00 + N + 1;
        a.fromArray(dirs, k00 * 3);
        b.fromArray(dirs, k10 * 3).sub(a);
        c.fromArray(dirs, k01 * 3).sub(a);
        const area = b.cross(c).length() * R * R;
        cellArea[(f * GRID + j) * GRID + i] = area;
        weighted += area * 0.25 * (acceptW(grass[k00], village[k00]) + acceptW(grass[k10], village[k10]) +
          acceptW(grass[k01], village[k01]) + acceptW(grass[k11], village[k11]));
      }
  const total = HERO_TUFTS + CARPET_TUFTS;
  const heroFrac = HERO_TUFTS / total;
  const density = (total / weighted) * 1.18; // compensates the clump / path / sea rejections

  const hero: Tufts = { pos: new Float32Array(HERO_TUFTS * 4 * 1.3), bio: new Float32Array(HERO_TUFTS * 4 * 1.3), count: 0 };
  const carpet: Tufts = { pos: new Float32Array(CARPET_TUFTS * 4 * 1.3), bio: new Float32Array(CARPET_TUFTS * 4 * 1.3), count: 0 };
  const push = (t: Tufts, x: number, y: number, z: number, h: number, r: number, v: number, fo: number, sa: number, cv: number) => {
    if ((t.count + 1) * 4 > t.pos.length) return;
    const i = t.count++ * 4;
    t.pos[i] = x; t.pos[i + 1] = y; t.pos[i + 2] = z;
    t.pos[i + 3] = Math.floor(Math.min(4, Math.max(0, h)) * 1000) + Math.min(0.999, r);
    t.bio[i] = v; t.bio[i + 1] = fo; t.bio[i + 2] = sa; t.bio[i + 3] = cv;
  };
  const flowers = new Grow(24000);
  const rand = rng(7001);
  const hills = LANDMARKS.hills;
  const p00 = new THREE.Vector3(), p10 = new THREE.Vector3(), p01 = new THREE.Vector3(), p11 = new THREE.Vector3();
  const lerp4 = (arr: Float32Array, k00: number, k10: number, k01: number, k11: number, w00: number, w10: number, w01: number, w11: number) =>
    arr[k00] * w00 + arr[k10] * w10 + arr[k01] * w01 + arr[k11] * w11;

  for (let f = 0; f < 6; f++)
    for (let j = 0; j < GRID; j++)
      for (let i = 0; i < GRID; i++) {
        const k00 = (f * N + j) * N + i;
        const k10 = k00 + 1, k01 = k00 + N, k11 = k00 + N + 1;
        const gmax = Math.max(grass[k00], grass[k10], grass[k01], grass[k11]);
        const expected = cellArea[(f * GRID + j) * GRID + i] * density;
        let cnt = Math.floor(expected);
        if (rand() < expected - cnt) cnt++;
        if (gmax <= 0.001) continue;
        p00.fromArray(dirs, k00 * 3); p10.fromArray(dirs, k10 * 3);
        p01.fromArray(dirs, k01 * 3); p11.fromArray(dirs, k11 * 3);
        for (let qn = 0; qn < cnt; qn++) {
          const s = rand(), t = rand();
          const w00 = (1 - s) * (1 - t), w10 = s * (1 - t), w01 = (1 - s) * t, w11 = s * t;
          const w = lerp4(grass, k00, k10, k01, k11, w00, w10, w01, w11);
          const vil = lerp4(village, k00, k10, k01, k11, w00, w10, w01, w11);
          d.set(0, 0, 0).addScaledVector(p00, w00).addScaledVector(p10, w10).addScaledVector(p01, w01).addScaledVector(p11, w11).normalize();
          const clump = 0.86 + 0.22 * simplex3(d.x * 14 + 3, d.y * 14, d.z * 14);
          if (rand() > acceptW(w, vil) * clump) continue;
          const h = heightAtXYZ(d.x, d.y, d.z);
          if (h < 0.85) continue;
          const pth = pathAt(d, 0.45);
          if (pth > 0.02 && rand() < pth * 1.25) continue;
          const fo = lerp4(forest, k00, k10, k01, k11, w00, w10, w01, w11);
          const sa = lerp4(sand, k00, k10, k01, k11, w00, w10, w01, w11);
          const cv = lerp4(cav, k00, k10, k01, k11, w00, w10, w01, w11);

          const fpatch = ss(0.28, 0.66, simplex3(d.x * 7.3 + 11, d.y * 7.3 - 4, d.z * 7.3 + 2));
          const fring = ss(0.08, 0.35, vil) * ss(0.95, 0.55, vil);
          const fmask = Math.max(fpatch * ss(0.3, 0.6, w), fring * 0.7);
          const tall = 0.5 + 0.5 * simplex3(d.x * 4.2 - 7, d.y * 4.2 + 2, d.z * 4.2 + 5);
          const hillBoost = ss(0.75, 0.15, Math.acos(Math.min(1, d.dot(hills))));
          const edgeH = 0.3 + 0.7 * ss(0.03, 0.6, w); // short toward sand / rock / forest
          const rootR = R + h - 0.05;
          const x = d.x * rootR, y = d.y * rootR, z = d.z * rootR;
          const isHero = rand() < heroFrac;
          if (isHero) {
            let th = (0.4 + 0.24 * tall + 0.12 * hillBoost) * edgeH;
            th *= (1 - 0.6 * vil) * (1 - 0.3 * fmask) * (1 - 0.6 * pth);
            push(hero, x, y, z, th, rand(), vil, fo, sa, cv);
            if (rand() < fmask * 0.36) {
              tangentFrameFast(d, e, n, up, ax);
              const nf = 1 + Math.floor(rand() * 2.2);
              const pal = simplex3(d.x * 3.1 + 20, d.y * 3.1, d.z * 3.1 - 9) * 0.5 + 0.5;
              for (let m = 0; m < nf; m++) {
                let slot = Math.min(3, Math.floor(pal * 4.6) % 4);
                if (rand() < 0.22) slot = Math.floor(rand() * 4) % 4;
                const ang = rand() * Math.PI * 2, rad = 0.35 * Math.sqrt(rand());
                const ox = Math.cos(ang) * rad, oy = Math.sin(ang) * rad;
                const yaw = rand() * Math.PI * 2;
                const fh = Math.max(th * 1.05, 0.3) + rand() * 0.16;
                flowers.push(x + e.x * ox + n.x * oy, y + e.y * ox + n.y * oy, z + e.z * ox + n.z * oy, slot,
                  Math.cos(yaw), Math.sin(yaw), fh, rand());
              }
            }
          } else {
            const ch = (0.2 + 0.08 * tall) * (0.45 + 0.55 * ss(0.03, 0.5, w)) * (1 - 0.45 * vil) * (1 - 0.6 * pth);
            push(carpet, x, y, z, ch, rand(), vil, fo, sa, cv);
          }
        }
      }
  return { hero, carpet, flowers };
}
function tangentFrameFast(d: THREE.Vector3, e: THREE.Vector3, n: THREE.Vector3, up: THREE.Vector3, ax: THREE.Vector3) {
  e.crossVectors(Math.abs(d.y) > 0.999 ? ax : up, d).normalize();
  n.crossVectors(d, e);
}

// -------------------------------------------------------------------------------------------------
// Geometry
// -------------------------------------------------------------------------------------------------

/**
 * One tuft: `nb` blades scattered in a small disc. position.x = across the blade (in blade widths),
 * position.y = fraction along it. `segs` = 3 gives a slim curved blade (5 tris), 1 a single triangle.
 */
interface BladeSet { attrs: Record<string, THREE.BufferAttribute>; index: THREE.BufferAttribute }
function bladeSet(nb: number, segs: 1 | 3, radius: number, seed: number): BladeSet {
  const r = rng(seed);
  const pos: number[] = [], b1: number[] = [], b2: number[] = [], idx: number[] = [];
  const levels = segs === 3 ? [0, 0.36, 0.7] : [0];
  const halfW = segs === 3 ? [0.5, 0.4, 0.24] : [0.5];
  for (let k = 0; k < nb; k++) {
    // blade 0 stands in the middle (it becomes the occasional seed stalk), the rest around it
    const ang = r() * Math.PI * 2, rad = k === 0 ? radius * 0.2 * r() : radius * (0.35 + 0.65 * Math.sqrt(r()));
    const ox = Math.cos(ang) * rad, oy = Math.sin(ang) * rad;
    const yawOff = r() * Math.PI * 2;
    const hMul = k === 0 ? 1.1 : 0.62 + 0.5 * r();
    const lean = 0.06 + 0.4 * r() * (k === 0 ? 0.4 : 1);
    const wMul = 0.8 + 0.4 * r();
    const base = pos.length / 3;
    const push = (x: number, y: number) => {
      pos.push(x, y, 0);
      b1.push(ox, oy, yawOff, hMul);
      b2.push(lean, wMul, k);
    };
    levels.forEach((s, l) => {
      push(-halfW[l], s);
      push(halfW[l], s);
    });
    push(0, 1);
    for (let l = 0; l < levels.length - 1; l++) {
      const a = base + l * 2;
      idx.push(a, a + 1, a + 3, a, a + 3, a + 2);
    }
    const last = base + (levels.length - 1) * 2;
    idx.push(last, last + 1, last + 2);
  }
  return {
    attrs: {
      position: new THREE.Float32BufferAttribute(pos, 3),
      // a normal attribute must exist, or three switches the material to flat (face-normal) shading;
      // the real normal is computed in the vertex shader
      normal: new THREE.Float32BufferAttribute(new Float32Array(pos.length), 3),
      aBlade: new THREE.Float32BufferAttribute(b1, 4),
      aBlade2: new THREE.Float32BufferAttribute(b2, 3),
    },
    index: new THREE.Uint16BufferAttribute(idx, 1),
  };
}

/** Tiles per cube-face edge for the CPU chunk culling (6*CH*CH chunks per layer). */
const CH = 3;
interface Chunk { mesh: THREE.Mesh; c: THREE.Vector3; u: THREE.Vector3; r: number }

/**
 * Split a tuft layer into cube-sphere tiles, each its own instanced mesh sharing the blade buffers and
 * the material. three frustum-culls them; update() hides tiles past the layer's fade distance or the
 * planet's horizon, so the GPU only ever touches tufts that can be on screen.
 */
function chunkLayer(t: Tufts, blades: BladeSet, mat: THREE.Material, name: string): Chunk[] {
  const NC = 6 * CH * CH;
  const id = new Uint16Array(t.count);
  const cnt = new Uint32Array(NC + 1);
  for (let i = 0; i < t.count; i++) {
    const x = t.pos[i * 4], y = t.pos[i * 4 + 1], z = t.pos[i * 4 + 2];
    const ax = Math.abs(x), ay = Math.abs(y), az = Math.abs(z);
    let f: number, u: number, v: number;
    if (ax >= ay && ax >= az) { f = x > 0 ? 0 : 1; u = y / ax; v = z / ax; }
    else if (ay >= az) { f = y > 0 ? 2 : 3; u = x / ay; v = z / ay; }
    else { f = z > 0 ? 4 : 5; u = x / az; v = y / az; }
    // tan-warped so tiles are near equal-area
    const tu = Math.min(CH - 1, Math.floor(((Math.atan(u) * 4) / Math.PI * 0.5 + 0.5) * CH));
    const tv = Math.min(CH - 1, Math.floor(((Math.atan(v) * 4) / Math.PI * 0.5 + 0.5) * CH));
    id[i] = (f * CH + tv) * CH + tu;
    cnt[id[i] + 1]++;
  }
  for (let k = 0; k < NC; k++) cnt[k + 1] += cnt[k];
  const pos = new Float32Array(t.count * 4), bio = new Float32Array(t.count * 4);
  const fill = cnt.slice();
  for (let i = 0; i < t.count; i++) {
    const o = fill[id[i]]++ * 4;
    for (let k = 0; k < 4; k++) { pos[o + k] = t.pos[i * 4 + k]; bio[o + k] = t.bio[i * 4 + k]; }
  }
  const out: Chunk[] = [];
  for (let k = 0; k < NC; k++) {
    const s = cnt[k], n = cnt[k + 1] - s;
    if (n === 0) continue;
    const c = new THREE.Vector3();
    for (let i = s; i < s + n; i++) c.x += pos[i * 4], c.y += pos[i * 4 + 1], c.z += pos[i * 4 + 2];
    c.multiplyScalar(1 / n);
    let r2 = 0;
    for (let i = s; i < s + n; i++) {
      const dx = pos[i * 4] - c.x, dy = pos[i * 4 + 1] - c.y, dz = pos[i * 4 + 2] - c.z;
      r2 = Math.max(r2, dx * dx + dy * dy + dz * dz);
    }
    const r = Math.sqrt(r2) + 2; // + tallest blade and its sway
    const g = new THREE.InstancedBufferGeometry();
    for (const [key, a] of Object.entries(blades.attrs)) g.setAttribute(key, a);
    g.setIndex(blades.index);
    g.setAttribute('iPos', new THREE.InstancedBufferAttribute(pos.subarray(s * 4, (s + n) * 4), 4));
    g.setAttribute('iBio', new THREE.InstancedBufferAttribute(bio.subarray(s * 4, (s + n) * 4), 4));
    g.instanceCount = n;
    g.boundingSphere = new THREE.Sphere(c.clone(), r);
    const mesh = new THREE.Mesh(g, mat);
    mesh.name = `${name}-${k}`;
    out.push({ mesh, c, u: c.clone().normalize(), r });
  }
  return out;
}

const _cd = new THREE.Vector3();
/** Hide chunks that are entirely past `far` or entirely below the planet's horizon. */
function cullChunks(chunks: Chunk[], cam: THREE.Vector3, far: number) {
  const D = cam.length();
  // horizon half-angle from the camera, widened for hills (up to ~12 high) peeking over it
  const hor = Math.acos(Math.min(1, R / Math.max(D, R))) + Math.acos(R / (R + 12));
  _cd.copy(cam).multiplyScalar(1 / Math.max(D, 1e-6));
  for (const ch of chunks) {
    const ang = Math.acos(Math.max(-1, Math.min(1, ch.u.dot(_cd)))) - ch.r / R;
    // 8 units of slack: the camera can move after this update in the same frame
    ch.mesh.visible = cam.distanceTo(ch.c) - ch.r < far + 8 && ang < hor + 0.12;
  }
}
function flowerGeometry(p: { pos: Float32Array; data: Float32Array; count: number }): THREE.InstancedBufferGeometry {
  const g = new THREE.InstancedBufferGeometry();
  const pos: number[] = [-0.5, 0, 0, 0.5, 0, 0, 0, 1, 0]; // stem
  const part: number[] = [0, 0, 0];
  const idx: number[] = [0, 1, 2];
  // head: square equator + top/bottom apex
  const top = 3, bot = 4;
  pos.push(0, 1, 0, 0, -0.6, 0);
  part.push(1, 1);
  const HS = 4;
  for (let i = 0; i < HS; i++) {
    const a = (i / HS) * Math.PI * 2 + 0.4;
    pos.push(Math.cos(a), 0, Math.sin(a));
    part.push(1);
  }
  for (let i = 0; i < HS; i++) {
    const a = 5 + i, b = 5 + ((i + 1) % HS);
    idx.push(top, b, a, bot, a, b);
  }
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('aPart', new THREE.Float32BufferAttribute(part, 1));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(new Float32Array(pos.length), 3)); // see tuftGeometry
  g.setIndex(idx);
  g.setAttribute('iPos', new THREE.InstancedBufferAttribute(p.pos.subarray(0, p.count * 4), 4));
  g.setAttribute('iData', new THREE.InstancedBufferAttribute(p.data.subarray(0, p.count * 4), 4));
  g.instanceCount = p.count;
  g.boundingSphere = new THREE.Sphere(new THREE.Vector3(), R + 15);
  return g;
}

export default function createGrass(ctx: Ctx): System {
  const t0 = performance.now();
  if (wantsDebugGround(ctx.mode) && onlyHas('grass')) ctx.scene.add(makeDebugGround());
  const t1 = performance.now();
  const { hero, carpet, flowers } = place();
  const t2 = performance.now();

  const add = (mesh: THREE.Mesh, name: string) => {
    mesh.name = name;
    mesh.frustumCulled = false;
    mesh.receiveShadow = true;
    mesh.castShadow = false;
    ctx.scene.add(mesh);
  };
  const HERO_FAR = 125, CARPET_FAR = 36;
  const heroChunks = chunkLayer(hero, bladeSet(HERO_BLADES, 3, 0.17, 11),
    makeTuftMaterial('grass-hero', tuftMain({ thin0: 40, thin1: HERO_FAR, width: 0.05, stalk: 0.14 })), 'grass');
  const carpetChunks = chunkLayer(carpet, bladeSet(CARPET_BLADES, 1, 0.3, 23),
    makeTuftMaterial('grass-carpet', tuftMain({ thin0: 10, thin1: CARPET_FAR, width: 0.06, stalk: 0 })), 'grass-carpet');
  for (const ch of [...heroChunks, ...carpetChunks]) {
    add(ch.mesh, ch.mesh.name);
    ch.mesh.frustumCulled = true;
  }
  add(new THREE.Mesh(flowerGeometry(flowers), makeFlowerMaterial()), 'flowers');

  floraStat('grass', {
    heroTufts: hero.count, carpetTufts: carpet.count, flowers: flowers.count,
    blades: hero.count * HERO_BLADES + carpet.count * CARPET_BLADES,
    groundMs: Math.round(t1 - t0), placeMs: Math.round(t2 - t1),
    chunks: heroChunks.length + carpetChunks.length,
  });
  return {
    update(c) {
      cullChunks(heroChunks, c.camera.position, HERO_FAR);
      cullChunks(carpetChunks, c.camera.position, CARPET_FAR);
    },
  };
}
