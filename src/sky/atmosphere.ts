// Shared atmosphere model. ONE analytic single-scattering integral (plus a cheap ambient term for
// multiple scattering / night airglow) is used by:
//   - the sky background (sky.ts)       : rays that hit nothing, integrated to the top of the atmosphere
//   - the star field (sky.ts)           : per-vertex, so stars fade under a day sky
//   - aerial perspective (post.ts)      : rays that hit geometry, integrated to the depth buffer
// Because it is the same integral everywhere, there is no seam between sky, limb and planet at any
// altitude, from eye level to deep space.
import * as THREE from 'three';
import { R } from '../core/terrain';

/** Top of the atmosphere (world units from the planet centre). Density is ~0 above R+40. */
export const ATM_TOP = R + 58;
/** Rayleigh: a dense low layer (scale height ATM_HR) plus a thin extended tail (ATM_HR2, weight ATM_W2),
 *  so the sky darkens gradually between ~15 and ~60 units up while the limb seen from space stays thin. */
export const ATM_HR = 6.0;
export const ATM_HR2 = 11.0;
export const ATM_W2 = 0.05;
/** Mie (haze) scale height. */
export const ATM_HM = 2.2;

const LUT_W = 128;
const LUT_H = 32;
/** Schueler's approximation of the Chapman grazing-incidence function (relative optical depth). */
function chapman(X: number, h: number, coschi: number): number {
  const c = Math.sqrt(X + h);
  if (coschi >= 0) return (c / (c * coschi + 1)) * Math.exp(-h);
  const x0 = Math.sqrt(1 - coschi * coschi) * (X + h);
  const c0 = Math.sqrt(x0);
  return 2 * c0 * Math.exp(Math.min(X - x0, 30)) - (c / (1 - c * coschi)) * Math.exp(-h);
}
/** Sun transmittance x planet sun tint, indexed by (muS, sqrt(altitude fraction)). Built once on the CPU. */
function buildSunLUT(betaR: THREE.Vector3, betaM: number): THREE.DataTexture {
  const data = new Uint16Array(LUT_W * LUT_H * 4);
  const tint = new THREE.Color();
  for (let j = 0; j < LUT_H; j++) {
    const a = Math.pow(j / (LUT_H - 1), 2);
    const alt = a * (ATM_TOP - R);
    const r = R + alt;
    const dip = Math.sqrt(Math.max(0, 1 - (R * R) / (r * r)));
    for (let i = 0; i < LUT_W; i++) {
      const mu = (i / (LUT_W - 1)) * 2 - 1;
      const tR = (1 - ATM_W2) * ATM_HR * chapman(R / ATM_HR, alt / ATM_HR, mu) + ATM_W2 * ATM_HR2 * chapman(R / ATM_HR2, alt / ATM_HR2, mu);
      const tM = ATM_HM * chapman(R / ATM_HM, alt / ATM_HM, mu);
      sunTintCPU(mu + dip * 0.3, tint);
      const o = (j * LUT_W + i) * 4;
      const ex = (b: number) => Math.exp(-0.5 * (b * tR + 1.11 * betaM * tM));
      data[o] = THREE.DataUtils.toHalfFloat(ex(betaR.x) * tint.r);
      data[o + 1] = THREE.DataUtils.toHalfFloat(ex(betaR.y) * tint.g * 1.03);
      data[o + 2] = THREE.DataUtils.toHalfFloat(ex(betaR.z) * tint.b * 1.12);
      data[o + 3] = THREE.DataUtils.toHalfFloat(1);
    }
  }
  const tex = new THREE.DataTexture(data, LUT_W, LUT_H, THREE.RGBAFormat, THREE.HalfFloatType);
  tex.minFilter = THREE.LinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.wrapS = THREE.ClampToEdgeWrapping;
  tex.wrapT = THREE.ClampToEdgeWrapping;
  tex.needsUpdate = true;
  return tex;
}

const BETA_R = new THREE.Vector3(0.0058, 0.0135, 0.0331).multiplyScalar(1.45);
const BETA_M = 0.006;

/** Shared uniform objects (same instances in every material that uses ATMOS_GLSL). */
export const atmosUniforms = {
  /** Rayleigh scattering per unit at sea level. Blue-heavy, ~2.5x Earth so a 60 m planet still gets red sunsets. */
  uAtmBetaR: { value: BETA_R },
  /** Mie (haze) scattering per unit at sea level. */
  uAtmBetaM: { value: BETA_M },
  /** Sun transmittance LUT (built from BETA_R/BETA_M at load; they are constants). */
  uAtmSunLUT: { value: null as THREE.DataTexture | null },
  /** Sun radiance used for the sky integral. */
  uAtmSunI: { value: 10.0 },
  /** Night airglow / starlight scattered by the air (keeps the night sky deep navy, not black). */
  uAtmNight: { value: new THREE.Vector3(0.08, 0.09, 0.12) },
  /** Direction to the moon. Written by sky.ts. */
  uMoonDir: { value: new THREE.Vector3(-1, 0.3, 0).normalize() },
};

/**
 * GLSL. Needs PLANET_GLSL (uSunDir, planetNight) included first.
 * atmIntegrate(ro, rd, tEnd, steps, out L, out T): in-scattered radiance and transmittance along
 * the segment [0, tEnd] of the ray (clipped to the atmosphere and to the sea-level sphere).
 */
export const ATMOS_GLSL = /* glsl */ `
#ifndef ATMOS_GLSL
#define ATMOS_GLSL
uniform vec3 uAtmBetaR;
uniform float uAtmBetaM;
uniform float uAtmSunI;
uniform vec3 uAtmNight;
uniform vec3 uMoonDir;
uniform sampler2D uAtmSunLUT;

#define ATM_RG ${R.toFixed(1)}
#define ATM_RT ${ATM_TOP.toFixed(1)}
#define ATM_HR ${ATM_HR.toFixed(2)}
#define ATM_HR2 ${ATM_HR2.toFixed(2)}
#define ATM_W2 ${ATM_W2.toFixed(3)}
#define ATM_HM ${ATM_HM.toFixed(2)}

// t of entry/exit of a ray against a centred sphere; (1e9,-1e9) on a miss.
vec2 atmSphere(vec3 ro, vec3 rd, float r) {
  float b = dot(ro, rd);
  float c = dot(ro, ro) - r * r;
  float d = b * b - c;
  if (d < 0.0) return vec2(1e9, -1e9);
  d = sqrt(d);
  return vec2(-b - d, -b + d);
}

// Sunlight reaching a point at radius r with local sun cosine muS, from a small LUT built on the
// CPU (see buildSunLUT below): physical Chapman transmittance (gives the earth shadow) times the
// planet's own art-directed noon->sunset ramp (planetSunTint), so the sky colour stays in step with
// the colour of the light on the ground. A texture fetch instead of three Chapman evaluations.
vec3 atmSunTrans(float r, float muS) {
  float a = clamp((r - ATM_RG) / (ATM_RT - ATM_RG), 0.0, 1.0);
  vec2 uv = vec2(muS * 0.5 + 0.5, sqrt(a)) * vec2(${(1 - 1 / 128).toFixed(6)}, ${(1 - 1 / 32).toFixed(6)})
          + vec2(${(0.5 / 128).toFixed(6)}, ${(0.5 / 32).toFixed(6)});
  return texture(uAtmSunLUT, uv).rgb;
}

// Cheap stand-in for multiple scattering + night airglow, isotropic.
vec3 atmAmbient(float muS) {
  float day = smoothstep(-0.22, 0.45, muS);
  float dusk = smoothstep(-0.25, 0.0, muS) * (1.0 - smoothstep(0.0, 0.3, muS));
  return uAtmSunI * (0.03 * day * vec3(0.62, 0.78, 1.0) + 0.03 * dusk * vec3(0.9, 0.55, 0.75))
       + uAtmNight * planetNight(muS);
}

void atmIntegrate(vec3 ro, vec3 rd, float tEnd, const int N, out vec3 L, out vec3 T) {
  L = vec3(0.0);
  T = vec3(1.0);
  vec2 ts = atmSphere(ro, rd, ATM_RT);
  float t0 = max(ts.x, 0.0);
  float t1 = min(ts.y, tEnd);
  vec2 tg = atmSphere(ro, rd, ATM_RG - 0.5);
  if (tg.x > 0.0) t1 = min(t1, tg.x);
  if (t1 <= t0) return;
  float ds = (t1 - t0) / float(N);
  float mu = dot(rd, uSunDir);
  float pR = 0.0596831 * (1.0 + mu * mu);
  // Mie: a tight forward lobe (sun halo) + a broad one (warm glow around the sun at dusk).
  const float g = 0.78;
  float pM = 0.1193662 * (1.0 - g * g) * (1.0 + mu * mu) / ((2.0 + g * g) * pow(max(1.0 + g * g - 2.0 * g * mu, 1e-4), 1.5));
  float pM2 = 0.0795775 * 0.75 / pow(1.25 - mu, 1.5);
  pM = pM + pM2 * 0.6;
  // Warm dusk scattering shows along low, long sight lines (horizon band, and the limb from space);
  // the zenith stays blue.
  float warmK = 0.85 * (1.0 - smoothstep(-0.1, 0.55, dot(rd, normalize(ro))));
  vec3 tau = vec3(0.0);
  vec3 Tacc = vec3(1.0);
  for (int i = 0; i < N; i++) {
    vec3 p = ro + rd * (t0 + (float(i) + 0.5) * ds);
    float r = length(p);
    float alt = max(r - ATM_RG, 0.0);
    float dR = (1.0 - ATM_W2) * exp(-alt / ATM_HR) + ATM_W2 * exp(-alt / ATM_HR2);
    float dM = exp(-alt / ATM_HM);
    vec3 dtau = (uAtmBetaR * dR + 1.11 * uAtmBetaM * dM) * ds;
    vec3 Tc = Tacc * (1.0 - 0.5 * min(dtau, vec3(1.0)));   // mid-step transmittance (dtau is small)
    float muS = dot(p, uSunDir) / r;
    vec3 sunT = atmSunTrans(r, muS);
    // Art direction: a 60 m planet has too little air for real sunset reddening, so near the
    // terminator the air scatters warm (pink/peach) instead of blue, and the forward glow widens.
    float dusk = smoothstep(-0.2, 0.02, muS) * (1.0 - smoothstep(0.02, 0.3, muS));
    vec3 bS = mix(uAtmBetaR, vec3(0.050, 0.031, 0.024) * (uAtmBetaR.b / 0.076), dusk * warmK);
    vec3 mieT = sunT * mix(vec3(1.0), vec3(1.0, 0.5, 0.22), dusk * warmK); // long-path reddening of the glow
    vec3 S = (sunT * bS * (dR * pR) + mieT * (uAtmBetaM * dM * pM * (1.0 + 1.8 * dusk))) * uAtmSunI
           + (uAtmBetaR * dR + vec3(uAtmBetaM * dM)) * atmAmbient(muS);
    L += Tc * S * ds;
    tau += dtau;
    Tacc = exp(-tau);
  }
  T = exp(-tau);
}

// Art-directed sunset/dusk paint for eye-level views (physical plausibility is not the goal: a
// 60-unit planet has far too little air for a real sunset). Replaces the integral's in-scatter by
// a painted gradient while the sun is near the local horizon, fading out with camera altitude (so
// orbit views and the altitude ladder use the plain integral) and with sun height (noon / night
// are untouched). Used by the sky background and by aerial perspective, so haze matches the sky.
// Seen from far out the limb is art-directed thinner and dimmer (a soft blue rim, never white).
// A function of camera altitude only, applied identically to sky and aerial perspective.
float atmSpaceGain(vec3 ro) { return mix(1.0, 0.5, smoothstep(30.0, 120.0, length(ro) - ATM_RG)); }

vec3 atmPaint(vec3 ro, vec3 rd, vec3 L, float pathK) {
  float r = length(ro);
  vec3 up = ro / r;
  float hc = dot(up, uSunDir);
  float W = smoothstep(-0.32, -0.12, hc) * (1.0 - smoothstep(0.14, 0.36, hc))
          * (1.0 - smoothstep(6.0, 44.0, r - ATM_RG));
  if (W <= 0.0) return L;
  float e = dot(rd, up);
  float eHor = -sqrt(max(0.0, 1.0 - ATM_RG * ATM_RG / (r * r)));
  // Bands are measured up from the sun's own elevation while it sinks below the local horizontal
  // (on a 60-unit planet the visible horizon dips 13+ degrees, so the sun stays in view a while).
  float x0 = max(e - max(eHor, min(hc, 0.0) - 0.04), 0.0);
  vec3 sh = uSunDir - up * hc;
  vec3 rh = rd - up * e;
  float az = dot(rh, sh) / max(length(rh) * length(sh), 1e-4);
  float sunW = smoothstep(-0.25, 0.92, az);
  float a = smoothstep(0.04, -0.2, hc);       // 0 = sun on the horizon .. 1 = late dusk
  float x = x0 * (1.0 + 1.6 * a);              // the bands sink toward the horizon as it gets late
  // toward the sun: gold -> orange -> salmon/pink -> violet -> deep blue
  vec3 gold   = mix(vec3(1.20, 0.50, 0.11), vec3(1.10, 0.26, 0.11), a);
  vec3 orange = mix(vec3(1.05, 0.31, 0.10), vec3(0.72, 0.15, 0.19), a);
  vec3 pink   = mix(vec3(0.74, 0.22, 0.32), vec3(0.32, 0.09, 0.24), a);
  vec3 violet = mix(vec3(0.25, 0.14, 0.50), vec3(0.09, 0.055, 0.22), a);
  vec3 zen    = mix(vec3(0.06, 0.10, 0.36), vec3(0.020, 0.030, 0.10), a);
  // the warm bands climb higher on the sun side
  float xs = x / mix(1.0, 1.9, sunW * (1.0 - 0.5 * a));
  vec3 cS = mix(gold, orange, smoothstep(0.0, 0.14, xs));
  cS = mix(cS, pink, smoothstep(0.10, 0.32, xs));
  cS = mix(cS, violet, smoothstep(0.28, 0.58, xs));
  cS = mix(cS, zen, smoothstep(0.52, 1.0, xs));
  // away from the sun: blue earth shadow, a pink belt above it, violet-blue up high
  vec3 shad = mix(vec3(0.26, 0.28, 0.55), vec3(0.05, 0.06, 0.16), a);
  vec3 belt = mix(vec3(0.78, 0.40, 0.56), vec3(0.20, 0.11, 0.25), a);
  vec3 vb   = mix(vec3(0.32, 0.30, 0.70), vec3(0.07, 0.07, 0.20), a);
  vec3 cA = mix(shad, belt, smoothstep(0.015, 0.10, x));
  cA = mix(cA, vb, smoothstep(0.12, 0.38, x));
  cA = mix(cA, zen, smoothstep(0.5, 1.05, x));
  vec3 c = mix(cA, cS, sunW);
  // broad warm glow around a low sun
  float ang = acos(clamp(dot(rd, uSunDir), -1.0, 1.0));
  c += vec3(1.0, 0.33, 0.07) * (0.75 * exp(-ang * 6.0) + 0.25 * exp(-ang * 2.2)) * (1.0 - a) * (1.0 - smoothstep(0.02, 0.3, hc));
  // climbing out of the air the painted sky darkens toward the physical one (no seam on the ladder)
  c *= exp(-max(r - ATM_RG - 6.0, 0.0) / 10.0);
  return mix(L, c * pathK, W);
}
#endif
`;

// ---- CPU mirrors of the planet lighting ramp (for fog colour etc.) ----
const ss = (a: number, b: number, x: number) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};
/** CPU mirror of planetSunTint(). */
export function sunTintCPU(h: number, out: THREE.Color): THREE.Color {
  const vis = ss(-0.14, 0.06, h);
  const a = ss(-0.06, 0.14, h);
  let r = 1, g = 0.4 + (0.68 - 0.4) * a, b = 0.15 + (0.3 - 0.15) * a;
  const c = ss(0.16, 0.55, h);
  g += (0.95 - g) * c;
  b += (0.88 - b) * c;
  const k = vis * (0.92 + 0.08 * ss(0, 0.4, h));
  return out.setRGB(r * k, g * k, b * k);
}
/** CPU mirror of planetAmbient(h, 1) (sky term). */
export function skyAmbientCPU(h: number, out: THREE.Color): THREE.Color {
  const day = ss(-0.05, 0.35, h);
  const dusk = (1 - Math.abs(Math.min(1, Math.max(-1, (h - 0.02) / 0.22)))) * 0.75;
  const night = 1 - ss(-0.2, 0.06, h);
  const w = ss(-0.12, 0.04, h);
  return out.setRGB(
    0.34 * day + (0.3 + 0.26 * w) * dusk + 0.05 * night,
    0.47 * day + (0.2 + 0.13 * w) * dusk + 0.075 * night,
    0.66 * day + (0.36 - 0.09 * w) * dusk + 0.15 * night,
  );
}

/** Written by clouds.ts each frame, read by post.ts: how deep the camera is inside a cloud. */
export const cloudFog = { amount: 0, color: new THREE.Color(1, 1, 1) };

const MOON_AXIS = new THREE.Vector3(0.2, 1, 0.1).normalize();
/** The moon sits a bit off the anti-sun point: a fat gibbous, visible above the night side. Idempotent. */
export function updateMoonDir(sunDir: THREE.Vector3): void {
  atmosUniforms.uMoonDir.value.copy(sunDir).negate().applyAxisAngle(MOON_AXIS, 0.42).normalize();
}

atmosUniforms.uAtmSunLUT.value = buildSunLUT(BETA_R, BETA_M);
