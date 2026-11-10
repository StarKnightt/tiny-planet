// Sky: one continuous model from eye level to deep space.
//   - background: a full-screen triangle at the far plane, drawn AFTER opaque geometry with a depth
//     test, so it only shades pixels nothing else covered. Per pixel it integrates the shared
//     atmosphere (src/sky/atmosphere.ts) along the view ray and composites space behind it:
//     black, a faint milky band, a sun disc with halo, a moon.
//   - stars: one Points draw (7000 stars), faded per vertex by the same atmosphere integral, so they
//     vanish under a day sky and come out at dusk and from space.
// Aerial perspective over geometry (the atmosphere veil over the planet seen from orbit) is applied
// in post with the same integral against the depth buffer.
import * as THREE from 'three';
import type { Ctx, System } from '../core/context';
import { PLANET_GLSL, planetUniforms } from '../core/lighting';
import { rng } from '../core/noise';
import { ATMOS_GLSL, atmosUniforms, updateMoonDir } from '../sky/atmosphere';

export const order = 50;

const NOISE_GLSL = /* glsl */ `
float skyHash(vec3 p) { p = fract(p * 0.3183099 + 0.1); p *= 17.0; return fract(p.x * p.y * p.z * (p.x + p.y + p.z)); }
float skyNoise(vec3 x) {
  vec3 i = floor(x); vec3 f = fract(x); f = f * f * (3.0 - 2.0 * f);
  return mix(mix(mix(skyHash(i), skyHash(i + vec3(1,0,0)), f.x), mix(skyHash(i + vec3(0,1,0)), skyHash(i + vec3(1,1,0)), f.x), f.y),
             mix(mix(skyHash(i + vec3(0,0,1)), skyHash(i + vec3(1,0,1)), f.x), mix(skyHash(i + vec3(0,1,1)), skyHash(i + vec3(1,1,1)), f.x), f.y), f.z);
}
float skyFbm(vec3 p) { float a = 0.5, s = 0.0; for (int i = 0; i < 4; i++) { s += a * skyNoise(p); p = p * 2.03 + 7.1; a *= 0.5; } return s; }
`;

/** Normal of the galactic plane (the milky band is the great circle perpendicular to it). */
const GALAXY_N = new THREE.Vector3(0.35, 0.82, -0.45).normalize();

const bgVertex = /* glsl */ `
varying vec3 vDir;
void main() {
  vec4 v = inverse(projectionMatrix) * vec4(position.xy, 1.0, 1.0);
  vDir = (inverse(viewMatrix) * vec4(v.xyz / v.w, 0.0)).xyz;
  gl_Position = vec4(position.xy, 1.0, 1.0);
}`;

const bgFragment = /* glsl */ `
${PLANET_GLSL}
${ATMOS_GLSL}
${NOISE_GLSL}
uniform vec3 uGalN;
varying vec3 vDir;

vec3 spaceColor(vec3 d, float pix) {
  // deep space, a hint of blue
  vec3 c = vec3(0.0010, 0.0013, 0.0026);
  // milky band: soft, mottled with dust lanes
  float b = dot(d, uGalN);
  float band = exp(-b * b / 0.035);
  float n = skyFbm(d * 5.0);
  float dust = smoothstep(0.35, 0.75, skyFbm(d * 9.0 + 3.0));
  c += band * (0.25 + 0.75 * n) * (1.0 - 0.6 * dust * exp(-b * b / 0.004)) * vec3(0.016, 0.015, 0.021);
  c += exp(-b * b / 0.25) * 0.0025 * vec3(0.6, 0.7, 1.0) * n;
  return c;
}

void main() {
  vec3 rd = normalize(vDir);
  vec3 ro = cameraPosition;
  float pix = length(fwidth(rd)) + 1e-5; // angular size of a pixel
  vec3 L, T;
  atmIntegrate(ro, rd, 1e9, 12, L, T);
  L = atmPaint(ro, rd, L, 1.0) * atmSpaceGain(ro);

  vec2 tg = atmSphere(ro, rd, ATM_RG);
  bool hitsPlanet = tg.x > 0.0 && tg.x < 1e8;

  // Stars, milky band and moon disappear against a bright sky (contrast, not transmittance),
  // so skip all of that work under a day sky.
  float skyLum = dot(L, vec3(0.2126, 0.7152, 0.0722));
  float spaceVis = clamp(1.0 - skyLum * 14.0, 0.0, 1.0);
  // sun: white at noon and from space; near the horizon a big orange-red disc that sets
  float camR = length(ro);
  float hcam = dot(ro, uSunDir) / camR;
  float ground = 1.0 - smoothstep(6.0, 45.0, camR - ATM_RG);
  float lowSun = (1.0 - smoothstep(0.06, 0.40, hcam)) * ground;
  // Below the local horizon the sun is gone (the true geometric horizon of a 60-unit planet dips
  // ~13 degrees, so without this the disc would hang in the dusk sky long after the light has set).
  float sunVis = mix(1.0, smoothstep(-0.13, -0.05, hcam), ground);
  float cs = dot(rd, uSunDir);
  float ang = acos(clamp(cs, -1.0, 1.0));
  float SUN_R = mix(0.0125, 0.03, lowSun);
  float disc = 1.0 - smoothstep(SUN_R - pix, SUN_R + pix, ang);
  float limb = sqrt(max(0.0, 1.0 - (ang * ang) / (SUN_R * SUN_R)));
  vec3 sunCol = mix(vec3(1.0, 0.93, 0.82), vec3(1.0, 0.27, 0.05), lowSun);
  float sunI = mix(60.0, 2.1, lowSun);
  sunCol = mix(sunCol, vec3(1.0, 0.20, 0.05), smoothstep(-0.02, -0.12, hcam) * ground);
  vec3 sun = sunCol * disc * mix(0.55 + 0.45 * limb, 0.8 + 0.2 * limb, lowSun) * sunI * sunVis;
  // a low sun is painted OVER the bright dusk sky (adding would push it through ACES to white)
  float over = disc * sunVis * lowSun;
  vec3 halo = mix(vec3(1.0, 0.85, 0.65), vec3(1.0, 0.45, 0.16), lowSun)
            * (0.9 * exp(-ang * 70.0) + 0.06 * exp(-ang * 9.0)) * sunVis;
  // moon: lit by the sun, a little texture
  float cm = dot(rd, uMoonDir);
  float mang = acos(clamp(cm, -1.0, 1.0));
  const float MOON_R = 0.019;
  vec3 moon = vec3(0.0);
  float mdisc = 1.0 - smoothstep(MOON_R - pix, MOON_R + pix, mang);
  if (mdisc > 0.0 && spaceVis > 0.0) {
    vec3 mu = normalize(cross(uMoonDir, abs(uMoonDir.y) > 0.9 ? vec3(1, 0, 0) : vec3(0, 1, 0)));
    vec3 mv = cross(uMoonDir, mu);
    vec2 q = vec2(dot(rd, mu), dot(rd, mv)) / MOON_R;
    vec3 n = normalize(mu * q.x + mv * q.y - uMoonDir * sqrt(max(0.0, 1.0 - dot(q, q))));
    float lit = smoothstep(-0.08, 0.2, dot(n, uSunDir));
    float maria = smoothstep(0.45, 0.7, skyFbm(vec3(q * 2.2, 3.0)));
    vec3 alb = mix(vec3(0.95, 0.94, 0.9), vec3(0.62, 0.64, 0.7), maria);
    moon = alb * (0.08 + 1.6 * lit) * mdisc;
  }
  vec3 moonGlow = vec3(0.5, 0.6, 0.85) * 0.04 * exp(-mang * 30.0);

  vec3 space = vec3(0.0);
  if (spaceVis > 0.0) space = (spaceColor(rd, pix) + moon + moonGlow) * spaceVis;
  vec3 col;
  if (hitsPlanet) {
    // Only reached when no terrain is loaded (or through a hole): a dark stand-in surface.
    col = L + T * vec3(0.015, 0.02, 0.03);
  } else {
    col = L * (1.0 - over) + T * (space + sun + halo);
  }
  gl_FragColor = vec4(col, 1.0);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}`;

const starVertex = /* glsl */ `
${PLANET_GLSL}
${ATMOS_GLSL}
attribute vec3 aColor;
attribute vec2 aStar; // size px, twinkle phase
uniform float uPx;
varying vec3 vColor;
void main() {
  vec3 d = normalize(position);
  vec3 L, T;
  atmIntegrate(cameraPosition, d, 1e9, 6, L, T);
  L = atmPaint(cameraPosition, d, L, 1.0);
  float skyLum = dot(L, vec3(0.2126, 0.7152, 0.0722));
  float vis = clamp(1.0 - skyLum * 28.0, 0.0, 1.0);
  vis *= vis;
  float tw = 1.0 + 0.13 * sin(uTime * (1.1 + 2.3 * fract(aStar.y * 7.3)) + aStar.y * 40.0)
                 + 0.07 * sin(uTime * (3.7 + 1.9 * fract(aStar.y * 3.1)) + aStar.y * 13.0);
  vColor = aColor * T * vis * tw;
  gl_PointSize = max(aStar.x * uPx, 1.6);
  vec4 p = projectionMatrix * viewMatrix * vec4(cameraPosition + d * 1500.0, 1.0);
  if (vis <= 0.001) p = vec4(2.0, 2.0, 2.0, 1.0);
  gl_Position = p;
}`;

const starFragment = /* glsl */ `
varying vec3 vColor;
void main() {
  vec2 q = gl_PointCoord * 2.0 - 1.0;
  float r2 = dot(q, q);
  float a = exp(-r2 * 4.5) * (1.0 - smoothstep(0.7, 1.0, r2));
  gl_FragColor = vec4(vColor * a, 1.0);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}`;

/** Black-body-ish star tint for t in [0,1] (0 = hot blue, 1 = cool orange). */
function starTint(t: number, out: THREE.Color) {
  const stops: [number, number, number][] = [
    [0.66, 0.76, 1.0],
    [0.86, 0.9, 1.0],
    [1.0, 0.98, 0.94],
    [1.0, 0.9, 0.74],
    [1.0, 0.76, 0.52],
  ];
  const x = Math.min(0.9999, Math.max(0, t)) * (stops.length - 1);
  const i = Math.floor(x);
  const f = x - i;
  const a = stops[i];
  const b = stops[i + 1];
  return out.setRGB(a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f, a[2] + (b[2] - a[2]) * f);
}

function makeStars(count: number): THREE.BufferGeometry {
  const rand = rng(90210);
  const pos = new Float32Array(count * 3);
  const col = new Float32Array(count * 3);
  const star = new Float32Array(count * 2);
  const c = new THREE.Color();
  const d = new THREE.Vector3();
  const u = new THREE.Vector3();
  const v = new THREE.Vector3();
  u.crossVectors(GALAXY_N, new THREE.Vector3(1, 0, 0)).normalize();
  v.crossVectors(GALAXY_N, u);
  for (let i = 0; i < count; i++) {
    if (rand() < 0.35) {
      // concentrated in the milky band
      const a = rand() * Math.PI * 2;
      const g = (rand() + rand() + rand() - 1.5) * 0.16;
      d.copy(u).multiplyScalar(Math.cos(a)).addScaledVector(v, Math.sin(a)).addScaledVector(GALAXY_N, g).normalize();
    } else {
      const z = rand() * 2 - 1;
      const a = rand() * Math.PI * 2;
      const s = Math.sqrt(1 - z * z);
      d.set(s * Math.cos(a), z, s * Math.sin(a));
    }
    pos.set([d.x, d.y, d.z], i * 3);
    // brightness: steep power law, a handful of bright ones
    const m = Math.pow(rand(), 5.5);
    const bright = 0.05 + 1.6 * m + (rand() < 0.004 ? 1.6 : 0);
    starTint(Math.min(1, Math.max(0, 0.45 + (rand() - 0.5) * 0.9 + (rand() - 0.5) * 0.4)), c);
    col.set([c.r * bright, c.g * bright, c.b * bright], i * 3);
    star[i * 2] = 1.7 + 2.6 * Math.sqrt(m) + rand() * 0.5;
    star[i * 2 + 1] = rand();
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setAttribute('aColor', new THREE.BufferAttribute(col, 3));
  g.setAttribute('aStar', new THREE.BufferAttribute(star, 2));
  return g;
}

export default function createSky(ctx: Ctx): System {
  ctx.scene.background = new THREE.Color(0x000000);

  const shared = { ...planetUniforms, ...atmosUniforms };

  // ---- background ----
  const tri = new THREE.BufferGeometry();
  tri.setAttribute('position', new THREE.BufferAttribute(new Float32Array([-1, -1, 0, 3, -1, 0, -1, 3, 0]), 3));
  const bgMat = new THREE.ShaderMaterial({
    name: 'sky-background',
    uniforms: { ...shared, uGalN: { value: GALAXY_N } },
    vertexShader: bgVertex,
    fragmentShader: bgFragment,
    depthWrite: false,
    depthTest: true,
    depthFunc: THREE.LessEqualDepth,
  });
  const bg = new THREE.Mesh(tri, bgMat);
  bg.frustumCulled = false;
  bg.renderOrder = 1000; // after opaque geometry (early-z rejects covered pixels), before transparents
  bg.name = 'sky';
  ctx.scene.add(bg);

  // ---- stars ----
  const starUniforms = { ...shared, uPx: { value: 1 } };
  const starMat = new THREE.ShaderMaterial({
    name: 'sky-stars',
    uniforms: starUniforms,
    vertexShader: starVertex,
    fragmentShader: starFragment,
    depthWrite: false,
    depthTest: true,
    transparent: false,
    blending: THREE.AdditiveBlending,
  });
  const stars = new THREE.Points(makeStars(7000), starMat);
  stars.frustumCulled = false;
  stars.renderOrder = 1001;
  stars.name = 'stars';
  ctx.scene.add(stars);

  const size = new THREE.Vector2();

  return {
    update(c) {
      updateMoonDir(c.sunDir);
      c.renderer.getDrawingBufferSize(size);
      starUniforms.uPx.value = size.y / 1080;
    },
  };
}
