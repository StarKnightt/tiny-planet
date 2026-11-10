// The sea: a sphere of radius R with a hand-written water shader.
// Depth comes from a baked height atlas of heightAt() (src/terrain/grid.ts) sampled with a cubic
// B-spline, so shoreline foam and the shallow-water fade are smooth curves, not polygons.
import * as THREE from 'three';
import type { Ctx, System } from '../core/context';
import { PLANET_GLSL, planetUniforms } from '../core/lighting';
import { R } from '../core/terrain';
import { getHeightTexture, getPlanetGrid, gidx, GRID_N, GRID_PAD, HEIGHT_TEX_GLSL } from '../terrain/grid';
import { NOISE_GLSL } from '../terrain/glsl';
import { ATMOS_GLSL, atmosUniforms } from '../sky/atmosphere';

export const order = -9;

/** Ocean cells per cube face edge (must divide GRID_N). 96 -> ~1 unit spacing. */
const OCEAN_N = 96;

export interface OceanSystem extends System {
  mesh: THREE.Mesh;
  material: THREE.ShaderMaterial;
}

// Long swells: shared by vertex (displacement) and fragment (normal). World-space plane waves;
// amplitude total <= 0.12 so the sea never floods the beach.
const SWELL_GLSL = /* glsl */ `
const int SWELLS = 4;
const vec4 SW_K[4] = vec4[4](          // xyz = wave vector (rad / unit), w = amplitude
  vec4( 0.52, -0.18,  0.38, 0.045),
  vec4(-0.30,  0.55,  0.42, 0.032),
  vec4( 0.71,  0.40, -0.55, 0.024),
  vec4(-0.62, -0.70, -0.25, 0.018));
// value (x) and world gradient (yzw)
vec4 tpSwell(vec3 p, float t) {
  vec4 r = vec4(0.0);
  for (int i = 0; i < SWELLS; i++) {
    vec3 k = SW_K[i].xyz;
    float w = 0.62 * sqrt(9.8 * length(k));
    float ph = dot(k, p) - w * t + float(i) * 1.7;
    r.x += SW_K[i].w * sin(ph);
    r.yzw += SW_K[i].w * cos(ph) * k;
  }
  return r;
}
`;

const VERT = /* glsl */ `
#include <common>
#include <shadowmap_pars_vertex>
${PLANET_GLSL}
${SWELL_GLSL}
uniform sampler2D uHeightTex;
${HEIGHT_TEX_GLSL}
varying vec3 vWorld;
void main() {
  vec3 dir = normalize(position);
  float h = planetHeight(uHeightTex, dir);
  // swell is a little calmer right at the waterline so the swash stays a gentle lap
  float amp = mix(0.6, 1.0, smoothstep(0.0, 2.5, -h));
  float s = tpSwell(dir * ${R.toFixed(1)}, uTime).x * amp;
  vec3 objectNormal = dir;
  vec3 transformedNormal = normalMatrix * objectNormal;
  vec4 worldPosition = modelMatrix * vec4(dir * (${R.toFixed(1)} + s), 1.0);
  vec4 mvPosition = viewMatrix * worldPosition;
  gl_Position = projectionMatrix * mvPosition;
  vWorld = worldPosition.xyz;
  #include <shadowmap_vertex>
}
`;

const FRAG = /* glsl */ `
#include <common>
#include <packing>
#include <bsdfs>
#include <lights_pars_begin>
#include <shadowmap_pars_fragment>
#include <shadowmask_pars_fragment>
${PLANET_GLSL}
${ATMOS_GLSL}
${NOISE_GLSL}
${SWELL_GLSL}
uniform sampler2D uHeightTex;
${HEIGHT_TEX_GLSL}
varying vec3 vWorld;
const float PR = ${R.toFixed(1)};

float tpBeckmann(float nh, float m) {
  float nh2 = max(nh * nh, 1e-4);
  return exp((nh2 - 1.0) / (nh2 * m * m)) / (3.14159 * m * m * nh2 * nh2);
}

void main() {
  vec3 P = vWorld;
  vec3 up = normalize(P);
  vec3 V = normalize(cameraPosition - P);
  vec3 L = normalize(uSunDir);
  float t = uTime;
  float fw = length(fwidth(P));
  float camDist = length(cameraPosition - P);
  float detailFade = (1.0 - smoothstep(0.08, 0.5, fw)) * (1.0 - 0.6 * smoothstep(6.0, 30.0, camDist));
  float fineFade = 1.0 - smoothstep(0.04, 0.18, fw);

  // ---- depth & shoreline ----
  float hT = planetHeightSmooth(uHeightTex, up);
  float depth = length(P) - PR - hT;          // water column under this point (swell included)
  float dCalm = max(-hT, 0.0);                // still-water depth (for colour, no wobble)

  // ---- normal: swell + directional chop + noise detail ----
  vec3 g = tpSwell(up * PR, t).yzw * mix(0.6, 1.0, smoothstep(0.0, 2.5, dCalm));
  // short chop waves
  const vec4 CH[5] = vec4[5](
    vec4( 1.9, 0.7, -1.2, 0.028), vec4(-1.4, 2.1, 0.5, 0.022), vec4(0.6, -1.8, 2.2, 0.018),
    vec4(-2.6, -0.4, 1.7, 0.013), vec4(2.2, 2.4, 1.1, 0.010));
  for (int i = 0; i < 5; i++) {
    vec3 k = CH[i].xyz;
    float w = 0.55 * sqrt(9.8 * length(k));
    g += CH[i].w * cos(dot(k, P) - w * t + float(i) * 2.3) * k * detailFade;
  }
  vec4 n1 = vnoised(P * 0.9 + up * t * 0.35 + vec3(t * 0.12, 0.0, -t * 0.08));
  vec4 n2 = vnoised(P * 2.3 - up * t * 0.6 + vec3(0.0, t * 0.2, t * 0.1));
  g += n1.yzw * 0.07 * detailFade + n2.yzw * 0.045 * fineFade;
  g -= up * dot(g, up);
  vec3 N = normalize(up - g);
  // grazing views: flatten the normal a little so we do not see back-facing facets
  float NV = dot(N, V);
  if (NV < 0.02) { N = normalize(N + V * (0.02 - NV)); NV = 0.02; }

  // ---- light ----
  float sh = planetSunH(P);
  vec3 tint = planetSunTint(sh);
  float night = planetNight(sh);
  float shadow = getShadowMask();
  float sunK = 0.86;
  vec3 amb = planetAmbient(sh, 1.0);

  // ---- water body colour by depth ----
  float drift = snoise(P * 0.03) * 0.5 + 0.5;
  vec3 cShallow = srgb(vec3(0.22, 0.80, 0.74));
  vec3 cMid = srgb(vec3(0.05, 0.62, 0.66));
  vec3 cDeep = mix(srgb(vec3(0.04, 0.34, 0.42)), srgb(vec3(0.03, 0.27, 0.40)), drift);
  vec3 cAbyss = srgb(vec3(0.03, 0.19, 0.30));
  vec3 body = mix(cShallow, cMid, smoothstep(0.1, 1.6, dCalm));
  body = mix(body, cDeep, smoothstep(1.2, 4.0, dCalm));
  body = mix(body, cAbyss, smoothstep(4.5, 7.0, dCalm));
  float sunAmt = sunK * (0.35 + 0.65 * max(dot(up, L), 0.0)) * mix(0.55, 1.0, shadow);
  vec3 bodyLit = body * (tint * sunAmt + amb * 1.15);
  // light through the back of the swell crests
  float sss = pow(max(dot(-V, L), 0.0), 4.0) * smoothstep(-0.02, 0.08, tpSwell(up * PR, t).x) * smoothstep(0.3, 2.0, dCalm);
  bodyLit += cMid * tint * sss * 0.5 * shadow;

  // ---- transparency ----
  float vGeo = max(dot(up, V), 0.22);
  float opa = 1.0 - exp(-max(depth, 0.0) * 0.75 / vGeo);
  opa = mix(opa, 1.0, smoothstep(3.0, 4.2, dCalm));     // deep water is fully opaque
  opa *= smoothstep(0.0, 0.06, depth);

  // ---- reflection ----
  float F = 0.02 + 0.98 * pow(1.0 - NV, 5.0);
  F = min(F, 0.5);
  float lowSunEarly = 1.0 - smoothstep(0.05, 0.6, sh);
  vec3 Rr = reflect(-V, N);
  if (dot(Rr, up) < 0.02) Rr = normalize(Rr + up * (0.02 - dot(Rr, up)));
  // the real sky (same single-scattering integral the sky background uses), so the sea mirrors it
  vec3 skyL, skyT;
  atmIntegrate(P + up * 0.2, Rr, 1e9, 4, skyL, skyT);
  vec3 sky = skyL;
  // low sun: warm the reflected sun-side sky a little so the glitter path reads as molten, not milky
  sky *= mix(vec3(1.0), vec3(1.0, 0.72, 0.5), lowSunEarly * pow(max(dot(Rr, L), 0.0), 3.0));

  // ---- sun glitter: broad microfacet lobe (the path) + sharp sparkles ----
  vec3 H = normalize(L + V);
  float NH = max(dot(N, H), 0.0);
  float VH = max(dot(V, H), 0.0);
  float Fh = 0.02 + 0.98 * pow(1.0 - VH, 5.0);
  float lowSun = 1.0 - smoothstep(0.05, 0.6, sh);
  float m = mix(0.11, 0.27, lowSun);
  float NL = max(dot(N, L), 0.0);
  float spec = tpBeckmann(NH, m) * Fh * NL / max(4.0 * NV * max(dot(up, L), 0.05), 0.05) * 0.9;
  vec4 sp = vnoised(P * 7.0 + up * t * 1.4);
  vec3 Ns = normalize(N - (sp.yzw - up * dot(sp.yzw, up)) * 0.11);
  float spark = pow(max(dot(Ns, H), 0.0), 900.0) * 18.0 * fineFade;
  float sTot = spec + spark * Fh * 4.0;
  float cap = mix(2.6, 2.4, lowSun);
  sTot = cap * sTot / (cap + sTot);                     // soft cap: keeps the hue instead of clipping to white
  vec3 glitTint = tint * mix(vec3(1.0), vec3(1.0, 0.32, 0.07), lowSun);
  vec3 sunSpec = glitTint * shadow * sTot * (1.0 + 1.4 * lowSun);
  // moonlit sheen at night
  vec3 Hm = normalize(uMoonDir + V);
  float moonVis = smoothstep(-0.02, 0.2, dot(up, uMoonDir)) * planetNight(sh);
  vec3 moonSpec = vec3(0.30, 0.38, 0.55) * tpBeckmann(max(dot(N, Hm), 0.0), 0.16) * 0.012 * moonVis;

  // ---- foam ----
  float shoreZ = 1.0 - smoothstep(0.0, 2.6, dCalm);
  float foam = 0.0;
  if (shoreZ > 0.0) {
    float wob = snoise(P * 0.22) * 0.45 + snoise(P * 0.9 + 3.0) * 0.12;
    float ph = dCalm * 1.6 + t * 0.32 + wob;           // phase grows with time -> bands travel shoreward
    float band = floor(ph);
    float f = fract(ph);
    float line = smoothstep(0.0, 0.07, f) * (1.0 - smoothstep(0.1, 0.42, f));
    float bandRnd = fract(sin(band * 12.9898) * 43758.5453);
    float brk = smoothstep(-0.35, 0.45, snoise(P * 0.35 + vec3(band * 7.0, 0.0, 0.0)) + bandRnd * 0.4 - 0.15);
    float lace = 0.55 + 0.45 * smoothstep(-0.3, 0.6, vnoise(P * 2.6 + t * 0.2)) ;
    lace = mix(0.8, lace, detailFade);
    foam = line * brk * lace * shoreZ;
    // wash line right at the edge of the water
    float edgeW = 0.035 + 0.025 * snoise(P * 0.7 + t * 0.15);
    float edge = smoothstep(0.0, 0.008, depth) * (1.0 - smoothstep(edgeW * 0.5, edgeW, depth));
    edge *= smoothstep(-0.2, 0.3, vnoise(P * 1.9 + t * 0.12) + 0.25);   // broken, not a solid rim
    // a lacy fringe just behind the wash line
    float fringe = smoothstep(edgeW, edgeW + 0.05, depth) * (1.0 - smoothstep(edgeW + 0.08, edgeW + 0.3, depth));
    float laceN = vnoise(P * 3.4 - t * 0.25) * 0.6 + vnoise(P * 7.1 + t * 0.2) * 0.4;
    fringe *= smoothstep(0.05, 0.45, laceN) * mix(0.6, 1.0, detailFade);
    foam = max(foam * 0.8, max(edge * 0.85, fringe * 0.7));
  }
  foam = clamp(foam, 0.0, 1.0);
  vec3 foamLit = srgb(vec3(0.97, 0.98, 0.96)) * (tint * sunK * (0.45 + 0.55 * max(dot(up, L), 0.0)) * mix(0.5, 1.0, shadow) + amb * 1.3 + vec3(0.03, 0.04, 0.07) * night);

  // ---- combine (premultiplied, then back to straight alpha for normal blending) ----
  vec3 pre = bodyLit * opa * (1.0 - F) + sky * F + sunSpec + moonSpec;
  float a = 1.0 - (1.0 - opa) * (1.0 - F);
  pre = mix(pre, foamLit, foam);
  a = mix(a, 1.0, foam);
  float specL = dot(sunSpec, vec3(0.33));
  a = clamp(max(a, specL), 0.0, 1.0);
  gl_FragColor = vec4(pre / max(a, 1e-3), a);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;

function buildOceanGeometry(): THREE.BufferGeometry {
  const { heights } = getPlanetGrid();
  const step = GRID_N / OCEAN_N;
  const V = OCEAN_N + 1;
  const pos = new Float32Array(6 * V * V * 3);
  const nrm = new Float32Array(6 * V * V * 3);
  const { dirs } = getPlanetGrid();
  for (let f = 0; f < 6; f++) {
    for (let j = 0; j < V; j++) {
      for (let i = 0; i < V; i++) {
        const v = (f * V + j) * V + i;
        const g = gidx(f, i * step + GRID_PAD, j * step + GRID_PAD);
        for (let k = 0; k < 3; k++) {
          nrm[v * 3 + k] = dirs[g * 3 + k];
          pos[v * 3 + k] = dirs[g * 3 + k] * R;
        }
      }
    }
  }
  // drop cells that sit wholly over dry land (min terrain height over the cell well above the swell)
  const idx: number[] = [];
  for (let f = 0; f < 6; f++) {
    for (let j = 0; j < OCEAN_N; j++) {
      for (let i = 0; i < OCEAN_N; i++) {
        let minH = Infinity;
        for (let b = 0; b <= step; b++) {
          for (let a = 0; a <= step; a++) {
            minH = Math.min(minH, heights[gidx(f, i * step + a + GRID_PAD, j * step + b + GRID_PAD)]);
          }
        }
        if (minH > 0.6) continue;
        const v00 = (f * V + j) * V + i;
        const v10 = v00 + 1;
        const v01 = v00 + V;
        const v11 = v01 + 1;
        idx.push(v00, v10, v11, v00, v11, v01);
      }
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setAttribute('normal', new THREE.BufferAttribute(nrm, 3));
  geo.setIndex(new THREE.BufferAttribute(new Uint32Array(idx), 1));
  geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), R + 1);
  return geo;
}

export default function createOcean(ctx: Ctx): OceanSystem {
  const geo = buildOceanGeometry();
  const uniforms = {
    ...THREE.UniformsUtils.clone(THREE.UniformsLib.lights),
    ...planetUniforms,
    ...atmosUniforms,
    uHeightTex: { value: getHeightTexture() },
  };
  const material = new THREE.ShaderMaterial({
    name: 'ocean',
    uniforms,
    vertexShader: VERT,
    fragmentShader: FRAG,
    lights: true,
    transparent: true,
    depthWrite: true,
    fog: false,
  });
  const mesh = new THREE.Mesh(geo, material);
  mesh.name = 'ocean';
  mesh.receiveShadow = true;
  mesh.castShadow = false;
  mesh.matrixAutoUpdate = false;
  mesh.updateMatrix();
  ctx.scene.add(mesh);
  return { mesh, material };
}
