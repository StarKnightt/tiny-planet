// The planet's ground: one cube-sphere mesh (~0.5 unit vertex spacing on land) built from heightAt(),
// with per-vertex biome weights and a hand-painted look done in a MeshStandardMaterial patch.
import * as THREE from 'three';
import type { Ctx, System } from '../core/context';
import { applyPlanetLighting } from '../core/lighting';
import { biomeAt, LANDMARKS, R } from '../core/terrain';
import { FACES, getPlanetGrid, gidx, GRID_N, GRID_PAD, GRID_W } from '../terrain/grid';
import { NOISE_GLSL } from '../terrain/glsl';

export const order = -10;

/** Cells with any corner above this height go into the shadow caster. */
const CASTER_MIN_H = -1.2;
/** Layer seen only by the sun's shadow camera. */
export const SHADOW_LAYER = 1;
/** Grid steps used for the cavity (hollow / ridge) estimate. 5 steps ~ 2.5 units. */
const CAV_STEP = 5;

export interface TerrainSystem extends System {
  mesh: THREE.Mesh;
  /** Bake time in ms (grid + attributes). */
  buildMs: number;
}

// --- dirt paths radiating from the village (colour only) -----------------------------------
function slerpDir(a: THREE.Vector3, b: THREE.Vector3, units: number): THREE.Vector3 {
  const ang = a.angleTo(b);
  const axis = new THREE.Vector3().crossVectors(a, b).normalize();
  return a.clone().applyAxisAngle(axis, Math.min(units / R, ang));
}
function makePaths() {
  const v = LANDMARKS.village;
  const targets = [
    // ends a little short of the lighthouse rock table / windmill top / just past the spawn point
    { to: LANDMARKS.lighthouse, endShort: 2.0 },
    { to: LANDMARKS.windmill, endShort: 1.2 },
    { to: LANDMARKS.spawn, endShort: -6 },
  ];
  const A: THREE.Vector3[] = [];
  const N: THREE.Vector3[] = [];
  const L: number[] = [];
  for (const t of targets) {
    const a = slerpDir(v, t.to, 4.5);
    const full = v.angleTo(t.to) * R;
    const axis = new THREE.Vector3().crossVectors(v, t.to).normalize();
    const b = v.clone().applyAxisAngle(axis, (full - t.endShort) / R);
    A.push(a);
    N.push(axis.clone());
    L.push(a.angleTo(b));
  }
  return { A, N, L };
}

const TERRAIN_FRAG_FUNCS = /* glsl */ `
${NOISE_GLSL}
varying vec4 vBiome;   // sand, forest, village, rock
varying vec2 vExtra;   // height, cavity
varying vec3 vWN;      // world normal (geometric, smooth)
uniform vec3 uPathA[3];
uniform vec3 uPathN[3];
uniform float uPathL[3];
uniform vec3 uVillage;
uniform vec3 uLighthouse;
const float PR = ${R.toFixed(1)};

// 0..1 dirt path coverage at unit direction d
float tpPaths(vec3 d) {
  float m = 0.0;
  for (int i = 0; i < 3; i++) {
    vec3 a = uPathA[i];
    vec3 n = uPathN[i];
    float L = uPathL[i];
    float sd = dot(d, n);
    vec3 pr = d - n * sd;
    float t = atan(dot(pr, cross(n, a)), dot(pr, a)) / L;
    float fi = float(i);
    float env = smoothstep(0.0, 0.25, t) * smoothstep(1.0, 0.8, t);
    float off = (1.5 * sin(t * L * PR * 0.17 + fi * 2.1) + 1.0 * vnoise(d * PR * 0.07 + fi * 13.0)) * env;
    float dist = abs(sd * PR - off);
    float w = mix(1.25, 0.8, clamp(t, 0.0, 1.0)) + 0.22 * vnoise(d * PR * 0.9 + fi * 5.0);
    float e = 1.0 - smoothstep(w * 0.45, w, dist);
    e *= smoothstep(-0.03, 0.04, t) * smoothstep(1.03, 0.96, t);
    m = max(m, e);
  }
  return m;
}
`;

const TERRAIN_COLOR = /* glsl */ `
  vec3 P = vPlanetPos;
  vec3 up = normalize(P);
  float hgt = vExtra.x;
  float cav = vExtra.y;
  float sand = vBiome.x, forest = vBiome.y, village = vBiome.z, rock = vBiome.w;
  vec3 wn = normalize(vWN);
  float slope = 1.0 - dot(wn, up);
  // screen footprint, used to fade detail that would alias
  float fw = length(fwidth(P));
  // fade a feature of spatial frequency f (cycles / unit) before it gets under ~3 px per cycle
  #define AAF(f) (1.0 - smoothstep(0.12, 0.33, fw * (f)))
  float fineFade = AAF(4.0);
  float midFade = AAF(0.6);
  float cobFade = AAF(2.2);

  // shared noise fields
  float nBig = snoise(P * 0.022 + 3.1);                    // ~45 unit hue drift
  float nMid = fbm3n(P * 0.075);                           // ~13 unit patches
  float nSm  = snoise(P * 0.42 + 7.7) * midFade;           // ~2.5 unit blotches
  float nPatch = snoise(P * 1.05 - 2.3) * AAF(1.05);       // ~1 unit dabs
  float nFine = (vnoise(P * 2.3) * 0.6 + vnoise(P * 5.1 + 3.0) * 0.4) * fineFade;
  float cavN = smoothstep(0.05, 0.9, cav);
  float ridge = smoothstep(-0.1, -0.8, cav);
  // painterly dabs: soft-thresholded noise reads as brush marks rather than grain
  float dabL = smoothstep(0.25, 0.65, nPatch + 0.35 * nFine);
  float dabD = smoothstep(0.25, 0.65, -nPatch + 0.35 * nFine);
  // small crisp dabs (~0.4 unit) and specks: what keeps the ground from being a smear at eye level
  float nDab = snoise(P * 2.4 + 5.1) * AAF(2.4);
  float dabS = smoothstep(0.30, 0.42, nDab + 0.25 * nFine);
  float dabSd = smoothstep(0.30, 0.42, -nDab + 0.25 * nFine);
  float speck = smoothstep(0.62, 0.75, vnoise(P * 7.0 - 1.7)) * AAF(7.0);

  // --- grass ---
  vec3 gYellow = srgb(vec3(0.76, 0.77, 0.36));
  vec3 gMid    = srgb(vec3(0.52, 0.69, 0.28));
  vec3 gDeep   = srgb(vec3(0.30, 0.52, 0.22));
  vec3 grass = mix(gMid, gYellow, smoothstep(-0.55, 0.65, nBig * 0.85 + nMid * 0.5));
  grass = mix(grass, gDeep, clamp(cavN * 0.7 + smoothstep(0.2, 0.8, -nMid) * 0.35, 0.0, 1.0));
  grass = mix(grass, gYellow, ridge * 0.35);
  grass = mix(grass, gDeep * 1.1, smoothstep(0.3, 0.8, nSm) * 0.35);            // darker lush clumps
  grass = mix(grass, gYellow * vec3(1.06, 1.0, 0.9), smoothstep(0.35, 0.85, -nSm) * 0.3);   // sun-dried patches
  grass *= 1.0 + 0.10 * dabL - 0.10 * dabD + 0.07 * nFine;
  grass = mix(grass, grass * vec3(1.12, 1.08, 0.88), dabS * 0.6);               // sunlit straw dabs
  grass = mix(grass, grass * vec3(0.78, 0.86, 0.80), dabSd * 0.55);             // shaded tufts
  grass = mix(grass, srgb(vec3(0.85, 0.82, 0.48)), speck * 0.35);

  // --- forest floor: needle litter with moss, dappled ---
  vec3 needles = srgb(vec3(0.47, 0.36, 0.23));
  vec3 needlesDk = srgb(vec3(0.33, 0.25, 0.17));
  vec3 moss = srgb(vec3(0.31, 0.43, 0.18));
  vec3 ff = mix(needles, needlesDk, smoothstep(-0.3, 0.6, nSm));
  ff = mix(ff, moss, smoothstep(0.0, 0.5, nMid + 0.3 * nSm) * 0.7);
  ff = mix(ff, srgb(vec3(0.56, 0.44, 0.28)), dabL * 0.5);
  ff *= 1.0 - 0.15 * dabD + 0.12 * nFine;
  ff = mix(ff, srgb(vec3(0.60, 0.46, 0.29)), dabS * 0.5);
  ff = mix(ff, ff * 0.72, dabSd * 0.5);
  ff = mix(ff, srgb(vec3(0.62, 0.55, 0.40)), speck * 0.4);
  float forestW = smoothstep(0.1, 0.65, forest + 0.15 * nSm);

  // --- village green: worn grass, packed earth, a cobbled square at the centre ---
  vec3 worn = srgb(vec3(0.62, 0.67, 0.35)) * (1.0 + 0.08 * dabL - 0.08 * dabD);
  vec3 earth = srgb(vec3(0.64, 0.51, 0.36));
  vec3 earthDk = srgb(vec3(0.51, 0.40, 0.28));
  float distV = acos(clamp(dot(up, uVillage), -1.0, 1.0)) * PR;
  // bare earth: worn round the square and in scattered patches, more of it toward the centre
  float earthMask = village > 0.004 ? smoothstep(0.15, 0.5, snoise(P * 0.12 + 4.0) * 0.5 + nSm * 0.18 + nPatch * 0.1 + smoothstep(12.0, 5.5, distV) * 0.5) : 0.0;
  vec3 earthC = mix(earth, earthDk, smoothstep(-0.3, 0.9, nFine + 0.6 * nSm + 0.4 * nPatch));
  earthC = mix(earthC, earthC * vec3(1.12, 1.08, 1.02), dabS * 0.6);
  earthC = mix(earthC, earthC * 0.8, dabSd * 0.5);
  earthC = mix(earthC, srgb(vec3(0.62, 0.57, 0.50)), speck * 0.35);          // pebbles
  worn = mix(worn, worn * vec3(1.1, 1.06, 0.9), dabS * 0.5);
  worn = mix(worn, earthC, dabSd * 0.45);                                     // bare spots in the worn turf
  vec3 vg = mix(worn, earthC, earthMask);
  float plaza = 1.0 - smoothstep(4.6, 5.6, distV + 0.6 * nSm);
  if (plaza > 0.001) {
    vec3 vc = tpVoronoi(P * 2.6);
    float edgeD = vc.y - vc.x;
    float grout = smoothstep(0.015, 0.07, edgeD);
    float dome = smoothstep(0.04, 0.5, edgeD);                                 // rounded stone tops catch light
    vec3 stoneA = mix(vec3(0.72, 0.66, 0.58), vec3(0.62, 0.56, 0.52), fract(vc.z * 7.0));
    vec3 stone = srgb(mix(stoneA, vec3(0.66, 0.60, 0.53), smoothstep(0.7, 1.0, vc.z))) * (0.86 + 0.16 * dome + 0.06 * nFine);
    vec3 cob = mix(srgb(vec3(0.40, 0.36, 0.30)), mix(srgb(vec3(0.66, 0.60, 0.54)), stone, cobFade), mix(0.85, grout, cobFade));
    vg = mix(vg, cob, plaza);
  }
  float villageW = smoothstep(0.05, 0.6, village);

  // --- paths ---
  float path = (distV < 32.0 && hgt > 0.35) ? tpPaths(up) * (1.0 - smoothstep(0.1, 0.5, sand)) * smoothstep(0.35, 0.8, hgt) : 0.0;
  vec3 dirt = mix(srgb(vec3(0.69, 0.55, 0.38)), srgb(vec3(0.55, 0.43, 0.30)), smoothstep(-0.2, 0.7, nSm + 0.5 * nFine + 0.3 * nPatch));
  dirt = mix(dirt, dirt * vec3(1.1, 1.07, 1.02), dabS * 0.6);
  dirt = mix(dirt, dirt * 0.8, dabSd * 0.5);
  dirt = mix(dirt, srgb(vec3(0.63, 0.58, 0.51)), speck * 0.35);

  // --- sand: pale peach, mottled, wind ripples, darker wet band at the waterline ---
  vec3 sandC = mix(srgb(vec3(0.94, 0.78, 0.58)), srgb(vec3(0.88, 0.70, 0.51)), smoothstep(-0.4, 0.6, nMid + 0.5 * nSm));
  float rippleF = AAF(1.1);
  float ripPh = dot(P, vec3(0.62, 0.21, 0.76)) * 6.5 + (rippleF > 0.0 && hgt < 2.5 ? snoise(P * 0.35) * 3.0 : 0.0);
  float ripple = sin(ripPh) * rippleF;
  sandC *= 1.0 + 0.06 * dabL - 0.05 * dabD + 0.05 * nFine + 0.035 * ripple;
  sandC = mix(sandC, sandC * vec3(1.05, 1.04, 1.03), dabS * 0.5);
  sandC = mix(sandC, sandC * vec3(0.94, 0.92, 0.92), dabSd * 0.4);
  sandC = mix(sandC, srgb(vec3(0.70, 0.60, 0.52)), speck * 0.25);           // shell grit
  float wet = 1.0 - smoothstep(0.08, 0.45, hgt + 0.06 * nSm);
  vec3 wetC = srgb(vec3(0.69, 0.55, 0.40));
  sandC = mix(sandC, wetC * (1.0 + 0.05 * nFine), wet);
  float sandW = max(smoothstep(0.25, 0.65, sand + 0.18 * nSm), smoothstep(0.55, 0.2, hgt));

  // --- rock: grey-violet with soft strata and lichen ---
  float strata = sin(hgt * 3.2 + nMid * 2.5 + nSm * 0.8 + nPatch * 0.3);
  vec3 rockC = mix(srgb(vec3(0.51, 0.49, 0.54)), srgb(vec3(0.68, 0.67, 0.68)), smoothstep(-0.6, 0.8, strata * 0.6 + nSm * 0.5));
  rockC = mix(rockC, srgb(vec3(0.39, 0.36, 0.43)), cavN * 0.5 + dabD * 0.25);
  rockC = mix(rockC, srgb(vec3(0.66, 0.68, 0.45)), smoothstep(0.45, 0.8, nPatch) * smoothstep(0.3, 0.1, slope) * 0.4);
  rockC *= 1.0 + 0.1 * nFine + 0.1 * dabS - 0.12 * dabSd;
  float rockW = smoothstep(0.25, 0.6, max(rock, smoothstep(0.32, 0.5, slope)) + 0.15 * nSm);

  // --- compose (land) ---
  vec3 col = grass;
  col = mix(col, ff, forestW);
  col = mix(col, vg, villageW);
  col = mix(col, dirt, path * (1.0 - plaza));
  col = mix(col, sandC, sandW);
  col = mix(col, rockC, rockW);

  // --- seabed: wet sand -> pale green -> deep blue-green ---
  if (hgt < 0.1) {
    float dep = -hgt;
    vec3 bed = mix(wetC, srgb(vec3(0.72, 0.66, 0.50)), smoothstep(-0.1, 0.8, dep + 0.2 * nSm));
    bed = mix(bed, srgb(vec3(0.36, 0.55, 0.46)), smoothstep(0.8, 2.6, dep + 0.4 * nMid));
    bed = mix(bed, srgb(vec3(0.10, 0.27, 0.30)), smoothstep(2.3, 5.0, dep + 0.5 * nMid));
    bed *= 1.0 + 0.07 * nFine + 0.05 * dabL - 0.06 * dabD + 0.03 * ripple;
    bed = mix(bed, rockC * vec3(0.8, 0.9, 0.95), rockW * smoothstep(1.5, 0.3, dep));
    col = mix(col, bed, smoothstep(0.1, -0.15, hgt));
  }
  diffuseColor.rgb = col;
  float tpWet = wet * sandW * smoothstep(-0.4, 0.0, hgt);
  float tpBump = mix(0.35, 0.8, rockW) * (1.0 - 0.5 * villageW * (1.0 - plaza)) + 0.3 * plaza;
  float tpRipple = sandW * (1.0 - wet * 0.6) * rippleF;
  float tpRipPh = ripPh;
`;

const TERRAIN_NORMAL = /* glsl */ `
  {
    // painterly micro relief: gradient of a couple of noise octaves (+ sand ripples), on the tangent plane
    vec4 b1 = vnoised(P * 0.9 + 2.0);
    vec4 b2 = vnoised(P * 2.6 - 4.0);
    vec3 g = (b1.yzw * 0.5 * AAF(2.2) + b2.yzw * 0.22 * AAF(6.0)) * tpBump;
    g += cos(tpRipPh) * 6.5 * vec3(0.62, 0.21, 0.76) * 0.012 * tpRipple;
    g -= wn * dot(g, wn);
    vec3 gv = (viewMatrix * vec4(g, 0.0)).xyz;
    normal = normalize(normal - gv);
  }
`;

const TERRAIN_CAUSTICS = /* glsl */ `
  if (hgt < 0.0 && hgt > -3.5) {
    vec3 cq = P * 1.5 + up * uTime * 0.5;
    cq += 0.35 * vec3(snoise(cq * 0.5), snoise(cq * 0.5 + 9.0), snoise(cq * 0.5 + 17.0));
    vec3 cv = tpVoronoi(cq);
    float c = 1.0 - smoothstep(0.0, 0.11, cv.y - cv.x);
    float depthFade = smoothstep(0.0, 0.35, -hgt) * smoothstep(-3.5, -1.2, hgt);
    reflectedLight.directDiffuse *= 1.0 + 1.3 * c * c * depthFade * midFade;
  }
  #include <aomap_fragment>
`;

export default function createTerrain(ctx: Ctx): TerrainSystem {
  const t0 = performance.now();
  const { dirs, heights } = getPlanetGrid();
  const tGrid = performance.now() - t0;
  const V = GRID_N + 1;
  const vcount = 6 * V * V;
  const pos = new Float32Array(vcount * 3);
  const nrm = new Float32Array(vcount * 3);
  const biome = new Uint8Array(vcount * 4);
  const extra = new Float32Array(vcount * 2);
  const vh = new Float32Array(vcount);
  const P = GRID_PAD;
  const tmp = new THREE.Vector3();

  const px = (g: number, out: number[]) => {
    const r = R + heights[g];
    out[0] = dirs[g * 3] * r;
    out[1] = dirs[g * 3 + 1] * r;
    out[2] = dirs[g * 3 + 2] * r;
  };
  const a = [0, 0, 0], b = [0, 0, 0], c = [0, 0, 0], d = [0, 0, 0];

  for (let f = 0; f < 6; f++) {
    for (let j = 0; j < V; j++) {
      for (let i = 0; i < V; i++) {
        const v = (f * V + j) * V + i;
        const g = gidx(f, i + P, j + P);
        const h = heights[g];
        vh[v] = h;
        const r = R + h;
        pos[v * 3] = dirs[g * 3] * r;
        pos[v * 3 + 1] = dirs[g * 3 + 1] * r;
        pos[v * 3 + 2] = dirs[g * 3 + 2] * r;
        // normal: central differences on the padded grid (no seams: the apron continues past the face edge)
        px(gidx(f, i + P + 1, j + P), a);
        px(gidx(f, i + P - 1, j + P), b);
        px(gidx(f, i + P, j + P + 1), c);
        px(gidx(f, i + P, j + P - 1), d);
        const ux = a[0] - b[0], uy = a[1] - b[1], uz = a[2] - b[2];
        const wx = c[0] - d[0], wy = c[1] - d[1], wz = c[2] - d[2];
        let nx = uy * wz - uz * wy, ny = uz * wx - ux * wz, nz = ux * wy - uy * wx;
        const nl = 1 / Math.hypot(nx, ny, nz);
        nx *= nl; ny *= nl; nz *= nl;
        nrm[v * 3] = nx;
        nrm[v * 3 + 1] = ny;
        nrm[v * 3 + 2] = nz;
        // cavity: mean of 4 neighbours ~2.5 units away minus own height (>0 = hollow)
        const s = CAV_STEP;
        const hm = (heights[gidx(f, i + P + s, j + P)] + heights[gidx(f, i + P - s, j + P)] +
          heights[gidx(f, i + P, j + P + s)] + heights[gidx(f, i + P, j + P - s)]) * 0.25;
        extra[v * 2] = h;
        extra[v * 2 + 1] = hm - h;
        if (h > -1.5) {
          tmp.set(dirs[g * 3], dirs[g * 3 + 1], dirs[g * 3 + 2]);
          const bi = biomeAt(tmp);
          biome[v * 4] = Math.round(bi.sand * 255);
          biome[v * 4 + 1] = Math.round(bi.forest * 255);
          biome[v * 4 + 2] = Math.round(bi.village * 255);
          biome[v * 4 + 3] = Math.round(bi.rock * 255);
        } else {
          // seabed: only rock matters (cape foot), and it is height-driven in the shader anyway
          biome[v * 4 + 3] = 0;
        }
      }
    }
  }

  // indices: two triangles per cell, split along the diagonal with the smaller height jump.
  // A second index holds only cells near or above the waterline: that is the shadow caster.
  const idx = new Uint32Array(6 * GRID_N * GRID_N * 6);
  const cidx = new Uint32Array(6 * GRID_N * GRID_N * 6);
  let ni = 0;
  let nc = 0;
  for (let f = 0; f < 6; f++) {
    for (let j = 0; j < GRID_N; j++) {
      for (let i = 0; i < GRID_N; i++) {
        const v00 = (f * V + j) * V + i;
        const v10 = v00 + 1;
        const v01 = v00 + V;
        const v11 = v01 + 1;
        const h00 = vh[v00], h10 = vh[v10], h01 = vh[v01], h11 = vh[v11];
        const start = ni;
        if (Math.abs(h00 - h11) <= Math.abs(h10 - h01)) {
          idx[ni++] = v00; idx[ni++] = v10; idx[ni++] = v11;
          idx[ni++] = v00; idx[ni++] = v11; idx[ni++] = v01;
        } else {
          idx[ni++] = v00; idx[ni++] = v10; idx[ni++] = v01;
          idx[ni++] = v10; idx[ni++] = v11; idx[ni++] = v01;
        }
        if (Math.max(h00, h10, h01, h11) > CASTER_MIN_H) {
          for (let k = start; k < ni; k++) cidx[nc++] = idx[k];
        }
      }
    }
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setAttribute('normal', new THREE.BufferAttribute(nrm, 3));
  geo.setAttribute('aBiome', new THREE.BufferAttribute(biome, 4, true));
  geo.setAttribute('aExtra', new THREE.BufferAttribute(extra, 2));
  geo.setIndex(new THREE.BufferAttribute(idx, 1));
  geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), R + 12);

  const paths = makePaths();
  const uniforms = {
    uPathA: { value: paths.A },
    uPathN: { value: paths.N },
    uPathL: { value: paths.L },
    uVillage: { value: LANDMARKS.village.clone() },
    uLighthouse: { value: LANDMARKS.lighthouse.clone() },
  };

  const mat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 1, metalness: 0 });
  applyPlanetLighting(mat, {
    key: 'tp-terrain-v1',
    uniforms,
    patch: (shader) => {
      shader.vertexShader = shader.vertexShader
        .replace(
          '#include <common>',
          `#include <common>
attribute vec4 aBiome;
attribute vec2 aExtra;
varying vec4 vBiome;
varying vec2 vExtra;
varying vec3 vWN;`,
        )
        .replace(
          '#include <begin_vertex>',
          `#include <begin_vertex>
vBiome = aBiome;
vExtra = aExtra;
vWN = normalize(mat3(modelMatrix) * normal);`,
        );
      shader.fragmentShader = shader.fragmentShader
        .replace('void main() {', `${TERRAIN_FRAG_FUNCS}\nvoid main() {`)
        .replace('#include <color_fragment>', TERRAIN_COLOR)
        .replace('#include <roughnessmap_fragment>', `#include <roughnessmap_fragment>\nroughnessFactor = mix(roughnessFactor, 0.42, tpWet);`)
        .replace('#include <normal_fragment_maps>', `#include <normal_fragment_maps>\n${TERRAIN_NORMAL}`)
        .replace('#include <aomap_fragment>', TERRAIN_CAUSTICS);
    },
  });

  const mesh = new THREE.Mesh(geo, mat);
  mesh.name = 'terrain';
  mesh.castShadow = false; // the caster below does it, without the seabed
  mesh.receiveShadow = true;
  mesh.matrixAutoUpdate = false;
  mesh.updateMatrix();
  ctx.scene.add(mesh);

  // Shadow caster: same vertices, land cells only, on layer 1 so only the sun's shadow camera sees it.
  // (Seabed triangles would double the shadow pass for shadows nobody can see.)
  const cgeo = new THREE.BufferGeometry();
  cgeo.setAttribute('position', geo.getAttribute('position'));
  cgeo.setAttribute('normal', geo.getAttribute('normal'));
  cgeo.setIndex(new THREE.BufferAttribute(cidx.slice(0, nc), 1));
  cgeo.boundingSphere = geo.boundingSphere.clone();
  const caster = new THREE.Mesh(cgeo, new THREE.MeshBasicMaterial({ colorWrite: false }));
  caster.name = 'terrain-shadow-caster';
  caster.castShadow = true;
  caster.receiveShadow = false;
  caster.layers.set(SHADOW_LAYER);
  caster.matrixAutoUpdate = false;
  caster.updateMatrix();
  ctx.scene.add(caster);
  ctx.sun.shadow.camera.layers.enable(SHADOW_LAYER);

  const buildMs = performance.now() - t0;
  if (new URLSearchParams(location.search).has('debug')) {
    console.log(`[terrain] grid ${tGrid.toFixed(0)} ms, total ${buildMs.toFixed(0)} ms, ${ni / 3} tris, caster ${nc / 3}`);
  }
  return { mesh, buildMs };
}
