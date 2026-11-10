// Clouds orbiting overhead.
// ~45 stylised cumulus clouds, each a cluster of soft "puffs". A puff is a camera-facing quad that
// ray-traces a half-ellipsoid (round top, squashed flat-ish bottom) in the fragment shader, so it has
// an exact silhouette, exact depth (gl_FragDepth, so hills and the lighthouse cut it correctly) and
// a smooth normal that is blended with the cloud's overall shape, which hides puff intersections.
// Edges are eroded with noise and fade to zero at the silhouette, so there are no hard polygon edges.
//
// Motion: every cloud rotates rigidly about its own orbit axis at its own rate: a pure function of
// ctx.time, evaluated in the vertex shader. The only CPU work per frame is a back-to-front sort of
// ~500 puffs (blending order) and a camera-inside-cloud fog estimate for post.
//
// Shadows: the mesh casts into ctx.sun's shadow map through a light-facing, noise-eroded,
// alpha-tested depth material.
import * as THREE from 'three';
import type { Ctx, System } from '../core/context';
import { PLANET_GLSL, planetUniforms } from '../core/lighting';
import { R } from '../core/terrain';
import { rng } from '../core/noise';
import { atmosUniforms, cloudFog, skyAmbientCPU, sunTintCPU, updateMoonDir } from '../sky/atmosphere';

export const order = 60;

interface Puff {
  p: THREE.Vector3; // centre at t=0
  r: number; // lateral radius
  ryT: number; // top radius factor
  ryB: number; // bottom radius factor
  cloud: number;
}
interface Cloud {
  centre: THREE.Vector3; // body centre at t=0
  axis: THREE.Vector3;
  omega: number;
  base: number; // radius of the cloud base
  size: number;
  seed: number;
  first: number;
  count: number;
}

function buildClouds() {
  const rand = rng(777);
  const clouds: Cloud[] = [];
  const puffs: Puff[] = [];
  const prevailing = new THREE.Vector3(0.12, 1, 0.18).normalize();

  const randomDir = (out: THREE.Vector3) => {
    const z = rand() * 2 - 1;
    const a = rand() * Math.PI * 2;
    const s = Math.sqrt(1 - z * z);
    return out.set(s * Math.cos(a), z, s * Math.sin(a));
  };
  const jitterAxis = (amt: number) =>
    prevailing
      .clone()
      .add(new THREE.Vector3(rand() - 0.5, rand() - 0.5, rand() - 0.5).multiplyScalar(amt))
      .normalize();

  // Banks: groups of clouds sharing an orbit, so they drift together.
  interface Seed { dir: THREE.Vector3; size: number; axis: THREE.Vector3; omega: number }
  const seeds: Seed[] = [];
  const NB = 9;
  for (let b = 0; b < NB; b++) {
    // bank 0 drifts past just east of the village, so there is weather over the main location
    const centre = b === 0 ? new THREE.Vector3(0.38, 0.05, 0.92).normalize() : randomDir(new THREE.Vector3());
    // keep banks away from the orbit poles so they actually travel
    if (Math.abs(centre.dot(prevailing)) > 0.8) centre.addScaledVector(prevailing, -centre.dot(prevailing) * 0.6).normalize();
    const axis = jitterAxis(0.3);
    const omega = 0.0045 + rand() * 0.0035;
    const n = b < 3 ? 6 + Math.floor(rand() * 3) : 3 + Math.floor(rand() * 3);
    const spread = b < 3 ? 0.32 : 0.24;
    for (let i = 0; i < n; i++) {
      const d = centre
        .clone()
        .add(new THREE.Vector3(rand() - 0.5, rand() - 0.5, rand() - 0.5).multiplyScalar(spread * 2))
        .normalize();
      seeds.push({ dir: d, size: i === 0 && b < 3 ? 11 + rand() * 3 : 5 + rand() * 6, axis, omega: omega * (0.96 + rand() * 0.08) });
    }
  }
  // Scattered singles (fair-weather cumulus), mostly the prevailing drift, a few odd ones.
  while (seeds.length < 80) {
    const d = randomDir(new THREE.Vector3());
    const odd = rand() < 0.12;
    seeds.push({ dir: d, size: 4 + rand() * 5.5, axis: odd ? jitterAxis(1.6) : jitterAxis(0.35), omega: 0.004 + rand() * 0.005 });
  }
  // Drop seeds that overlap an earlier one too much (banks merge, but do not stack).
  const kept: Seed[] = [];
  for (const s of seeds) {
    let ok = true;
    for (const k of kept) {
      const dist = s.dir.angleTo(k.dir) * (R + 25);
      if (dist < (s.size + k.size) * 0.75) ok = false;
    }
    if (ok && kept.length < 48) kept.push(s);
  }

  const e = new THREE.Vector3();
  const n = new THREE.Vector3();
  const tmp = new THREE.Vector3();
  for (const s of kept) {
    const U = s.dir;
    e.crossVectors(s.axis, U);
    if (e.lengthSq() < 1e-4) e.set(1, 0, 0).cross(U);
    e.normalize(); // direction of motion: clouds are elongated along it
    n.crossVectors(U, e);
    const base = R + 21.5 + rand() * 4.5 + (s.size > 10 ? 1.0 : 0);
    const size = s.size;
    const cloud: Cloud = {
      centre: U.clone().multiplyScalar(base + size * 0.35),
      axis: s.axis,
      omega: s.omega,
      base,
      size,
      seed: rand(),
      first: puffs.length,
      count: 0,
    };
    const count = Math.round(3 + size * 1.0);
    const width = 0.42 + rand() * 0.18;
    for (let k = 0; k < count; k++) {
      let u = count === 1 ? 0 : (k / (count - 1)) * 2 - 1;
      u = Math.max(-1, Math.min(1, u + (rand() - 0.5) * 0.25));
      const prof = 1 - u * u;
      const x = u * size * 0.82;
      const z = (rand() * 2 - 1) * size * width * (1 - 0.45 * Math.abs(u));
      let r = (0.28 + 0.34 * prof) * size * (0.8 + 0.4 * rand()) + 0.7;
      const lift = prof * size * 0.22 * rand() * (rand() < 0.5 ? 1 : 0.4);
      // One ellipsoid per puff (a split top/bottom shape gives see-through crescents at the seam):
      // squashed puffs sit on the base so the cloud bottom is flat-ish, lifted ones are rounder.
      const ry = (lift > 0 ? 0.78 : 0.58) + rand() * 0.08 + rand() * 0.06;
      const ryB = ry;
      const ryT = ry;
      r = Math.max(r, 1.2);
      tmp.copy(U).multiplyScalar(base).addScaledVector(e, x).addScaledVector(n, z).normalize();
      const p = tmp.clone().multiplyScalar(base + r * ryB + lift);
      puffs.push({ p, r, ryT, ryB, cloud: clouds.length });
    }
    // a couple of small cap puffs on top of the bigger clouds
    if (size > 6) {
      const caps = 1 + Math.floor(rand() * 2);
      for (let k = 0; k < caps; k++) {
        const x = (rand() - 0.5) * size * 0.6;
        const z = (rand() - 0.5) * size * 0.3;
        const r = size * (0.28 + rand() * 0.12) + 0.5;
        tmp.copy(U).multiplyScalar(base).addScaledVector(e, x).addScaledVector(n, z).normalize();
        const p = tmp.clone().multiplyScalar(base + size * (0.42 + rand() * 0.15) + r * 0.3);
        puffs.push({ p, r, ryT: 0.85, ryB: -0.85, cloud: clouds.length }); // ryB < 0: cap (not a shadow caster)
      }
    }
    cloud.count = puffs.length - cloud.first;
    clouds.push(cloud);
  }
  return { clouds, puffs };
}

const COMMON_GLSL = /* glsl */ `
uniform sampler2D uData;
vec3 rotAxis(vec3 v, vec3 a, float ang) {
  float c = cos(ang), s = sin(ang);
  return v * c + cross(a, v) * s + a * dot(a, v) * (1.0 - c);
}
float cHash(vec3 p) { p = fract(p * 0.3183099 + 0.1); p *= 17.0; return fract(p.x * p.y * p.z * (p.x + p.y + p.z)); }
float cNoise(vec3 x) {
  vec3 i = floor(x); vec3 f = fract(x); f = f * f * (3.0 - 2.0 * f);
  return mix(mix(mix(cHash(i), cHash(i + vec3(1,0,0)), f.x), mix(cHash(i + vec3(0,1,0)), cHash(i + vec3(1,1,0)), f.x), f.y),
             mix(mix(cHash(i + vec3(0,0,1)), cHash(i + vec3(1,0,1)), f.x), mix(cHash(i + vec3(0,1,1)), cHash(i + vec3(1,1,1)), f.x), f.y), f.z);
}
// Puff state at uTime: centre, radius, cloud body centre.
void puffState(int i, out vec3 c, out float r, out vec3 cc, out vec4 shape, out float seed) {
  vec4 d0 = texelFetch(uData, ivec2(i, 0), 0);
  vec4 d1 = texelFetch(uData, ivec2(i, 1), 0);
  vec4 d2 = texelFetch(uData, ivec2(i, 2), 0);
  shape = texelFetch(uData, ivec2(i, 3), 0); // ryTop, ryBot, cloud size, base radius
  float ang = d1.w * uTime;
  seed = d2.w;
  c = rotAxis(d0.xyz, d2.xyz, ang);
  cc = rotAxis(d1.xyz, d2.xyz, ang);
  // slow billow
  r = d0.w * (1.0 + 0.05 * sin(uTime * 0.31 + seed * 6.283));
  c += normalize(c) * (0.1 * d0.w * sin(uTime * 0.23 + seed * 17.0));
}
`;

const vertex = /* glsl */ `
${PLANET_GLSL}
${COMMON_GLSL}
attribute float aIdx;
varying vec3 vWorld;
varying vec3 vC;
varying vec3 vCC;
varying vec4 vShape;
varying float vR;
varying float vSeed;
varying float vFade;
// per-puff lighting terms (constant across a puff, so computed here instead of per pixel)
varying vec3 vSunC;
varying vec3 vSky;
varying vec3 vUnder;
varying vec3 vRimC;
varying vec2 vDN; // dusk, night
void main() {
  vec3 c, cc; float r, seed; vec4 shape;
  puffState(int(aIdx), c, r, cc, shape, seed);
  float rb = r * max(shape.x, 1.0);
  float dist = length(cameraPosition - c);
  // fade puffs the camera is about to enter (post takes over with in-cloud fog)
  vFade = smoothstep(0.95 * rb, 1.9 * rb, dist);
  // Screen-space bounding box of the puff's bounding sphere (view-space AABB corners projected).
  // If the sphere reaches the near plane, cover the whole screen. Depth comes from gl_FragDepth.
  vec3 cv = (viewMatrix * vec4(c, 1.0)).xyz;
  float nearZ = projectionMatrix[3][2] / (projectionMatrix[2][2] - 1.0);
  vec2 lo = vec2(1e9), hi = vec2(-1e9);
  if (cv.z - rb * 1.05 > -nearZ) {
    vFade = 0.0; // entirely behind the camera
  } else if (cv.z + rb * 1.05 > -nearZ * 1.5) {
    lo = vec2(-1.0); hi = vec2(1.0);
  } else {
    for (int k = 0; k < 8; k++) {
      vec3 q = cv + rb * 1.03 * vec3((k & 1) == 0 ? -1.0 : 1.0, (k & 2) == 0 ? -1.0 : 1.0, (k & 4) == 0 ? -1.0 : 1.0);
      vec4 pc = projectionMatrix * vec4(q, 1.0);
      vec2 nd = pc.xy / pc.w;
      lo = min(lo, nd); hi = max(hi, nd);
    }
    lo = max(lo, vec2(-1.0)); hi = min(hi, vec2(1.0));
  }
  vec2 ndc = mix(lo, hi, position.xy * 0.5 + 0.5);
  vec4 vp = inverse(projectionMatrix) * vec4(ndc, 0.0, 1.0);
  vWorld = (inverse(viewMatrix) * vec4(vp.xyz / vp.w, 1.0)).xyz;
  vC = c; vCC = cc; vShape = shape; vR = r; vSeed = seed;
  gl_Position = vec4(ndc, 0.0, 1.0);
  if (hi.x <= lo.x || hi.y <= lo.y) vFade = 0.0;
  if (vFade <= 0.0) gl_Position = vec4(2.0, 2.0, 2.0, 1.0);

  // lighting at the cloud's place on the planet
  float h = dot(normalize(cc), uSunDir) + 0.06;   // clouds stay lit a little after ground sunset
  float night = planetNight(h);
  float dusk = smoothstep(-0.3, 0.03, h) * (1.0 - smoothstep(0.08, 0.4, h));
  // art direction: near the terminator the sun-facing sides burn orange-pink
  vSunC = mix(planetSunTint(h), vec3(1.35, 0.50, 0.30) * smoothstep(-0.27, 0.02, h), dusk * 0.85);
  vSky = planetAmbient(h, 1.0) * 1.05;
  vUnder = (mix(vec3(0.42, 0.50, 0.66), vec3(1.25, 0.50, 0.62), dusk) * (1.0 - 0.6 * night) * smoothstep(-0.34, 0.05, h)
          + vec3(0.06, 0.08, 0.14) * night) * 0.62;
  vRimC = vSunC * mix(vec3(1.0), vec3(1.0, 0.75, 0.45), dusk) * mix(1.0, 2.2, dusk); // gold lining at dusk
  vDN = vec2(dusk, night);
}`;

const fragment = /* glsl */ `
${PLANET_GLSL}
${COMMON_GLSL}
uniform vec3 uMoonDir;
uniform mat4 projectionMatrix;
varying vec3 vWorld;
varying vec3 vC;
varying vec3 vCC;
varying vec4 vShape;
varying float vR;
varying float vSeed;
varying float vFade;
varying vec3 vSunC;
varying vec3 vSky;
varying vec3 vUnder;
varying vec3 vRimC;
varying vec2 vDN;

void main() {
  vec3 ro = cameraPosition;
  vec3 rd = normalize(vWorld - ro);
  vec3 U = normalize(vC);
  float sy = vShape.x;
  // ray vs ellipsoid (lateral radius r, vertical r*sy): scale the vertical axis to a unit sphere
  vec3 q = (ro - vC) / vR;
  float qy = dot(q, U);
  float dy = dot(rd, U);
  vec3 Q = q + U * (qy / sy - qy);
  vec3 D = rd + U * (dy / sy - dy);
  float a = dot(D, D);
  float b = dot(Q, D);
  float c = dot(Q, Q) - 1.0;
  float disc = b * b - a * c;
  if (disc <= 0.0) discard;
  float t = (-b - sqrt(disc)) / a;
  if (t < 0.0) discard;
  float edge = disc / (a * 1.0);                  // = 1 - closest-approach^2: 0 at the silhouette
  float alpha = 1.0;
  if (edge < 0.4) {
    // soft, noise-eroded edge (only evaluated in the edge band)
    vec3 hs0 = q + rd * t;
    vec3 np = hs0 * 2.2 + vec3(vSeed * 31.0, vSeed * 17.0, uTime * 0.03);
    float nz = cNoise(np) * 0.6 + cNoise(np * 2.7 + 5.0) * 0.4;
    alpha = smoothstep(0.0, 0.13, edge - (nz - 0.35) * 0.22);
  }
  alpha *= vFade;
  if (alpha < 0.004) discard;

  vec3 hs = q + rd * t;                         // hit in puff space (units of r)
  vec3 hit = vC + hs * vR;
  float hy = dot(hs, U);
  vec3 nE = normalize(hs + U * (hy / (sy * sy) - hy));

  // ---- lighting ----
  float dusk = vDN.x, night = vDN.y;
  vec3 Nc = normalize(hit - vCC);               // whole-cloud normal: smooth across puffs
  vec3 N = normalize(mix(nE, Nc, 0.82));
  float ndl = dot(N, uSunDir);
  float hf = clamp((length(hit) - vShape.w) / (vShape.z * 0.9), 0.0, 1.0); // height in the cloud
  // wrapped diffuse; at dusk the light comes in flat under the cloud so wrap more
  float wrap = mix(0.45, 0.8, dusk);
  float lit = smoothstep(-wrap, 0.85, ndl) * mix(mix(0.55, 0.8, dusk), 1.0, hf);
  float upness = dot(N, U) * 0.5 + 0.5;
  vec3 amb = mix(vUnder, vSky, upness * 0.55 + hf * 0.45);
  // dusk: the glowing horizon lights the bellies and the shadowed sides pink-orange
  amb += vSunC * dusk * (0.55 * (1.0 - upness) + 0.25);
  // (full noon sun is held a little below white so cloud form still reads from orbit)
  vec3 col = vec3(1.0, 0.985, 0.96) * (vSunC * lit * mix(1.22, 1.5, dusk) + amb * mix(0.82, 0.95, dusk));

  // silver lining: thin edges glow, strongly when looking toward the sun
  float nv = 1.0 - clamp(dot(Nc, -rd), 0.0, 1.0);
  float rim = nv * nv * nv;
  float fwd = clamp(dot(rd, uSunDir), 0.0, 1.0);
  fwd *= fwd; fwd *= fwd; fwd *= fwd;
  col += vRimC * rim * (0.25 + 1.6 * fwd) * (1.0 - 0.5 * lit);
  // moonlit edge at night
  if (night > 0.0) {
    float md = dot(N, uMoonDir);
    col += vec3(0.35, 0.45, 0.75) * 0.22 * night * (nv * nv * smoothstep(-0.2, 0.8, md) + 0.2 * smoothstep(-0.3, 1.0, md));
  }

  gl_FragColor = vec4(col, 1.0);

  vec4 cp = projectionMatrix * viewMatrix * vec4(hit, 1.0);
  gl_FragDepth = clamp((cp.z / cp.w) * 0.5 + 0.5, 0.0, 1.0);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
  gl_FragColor = vec4(gl_FragColor.rgb * alpha, alpha); // premultiplied, after tone mapping (--nopost)
}`;

// Shadow caster: quads face the light (view space of the shadow camera), alpha-tested, eroded.
const depthVertex = /* glsl */ `
${PLANET_GLSL}
${COMMON_GLSL}
attribute float aIdx;
varying vec2 vQ;
varying vec3 vP;
varying float vSeed;
void main() {
  vec3 c, cc; float r, seed; vec4 shape;
  puffState(int(aIdx), c, r, cc, shape, seed);
  vec4 mv = viewMatrix * vec4(c, 1.0);
  float s = r * 0.92;
  if (shape.y < 0.0) s = 0.0;  // cap puffs sit inside the cloud's shadow anyway
  mv.xy += position.xy * s;
  vQ = position.xy;
  vP = c / 7.0;
  vSeed = seed;
  gl_Position = projectionMatrix * mv;
}`;

const depthFragment = /* glsl */ `
${PLANET_GLSL}
${COMMON_GLSL}
varying vec2 vQ;
varying vec3 vP;
varying float vSeed;
void main() {
  float d = 1.0 - dot(vQ, vQ);
  if (d < 0.12) discard;
  float nz = cNoise(vec3(vQ * 1.6, vSeed * 23.0) + vP);
  if (d - (nz - 0.5) * 0.5 < 0.3) discard;
  gl_FragColor = vec4(1.0);
}`;

/** Public API (ctx.systems.clouds as CloudsSystem): where the clouds are, e.g. to aim a camera dive. */
export interface CloudsSystem extends System {
  /** Body centres (world) and half-lengths of every cloud at time t. Allocates; not for per-frame use. */
  cloudsAt(t: number): { centre: THREE.Vector3; size: number; baseRadius: number }[];
}

export default function createClouds(ctx: Ctx): CloudsSystem {
  const { clouds, puffs } = buildClouds();
  const N = puffs.length;

  // ---- static per-puff data texture (4 rows) ----
  const data = new Float32Array(N * 4 * 4);
  const row = (r: number, i: number) => (r * N + i) * 4;
  for (let i = 0; i < N; i++) {
    const p = puffs[i];
    const c = clouds[p.cloud];
    data.set([p.p.x, p.p.y, p.p.z, p.r], row(0, i));
    data.set([c.centre.x, c.centre.y, c.centre.z, c.omega], row(1, i));
    data.set([c.axis.x, c.axis.y, c.axis.z, c.seed], row(2, i));
    data.set([p.ryT, p.ryB, c.size, c.base], row(3, i));
  }
  const tex = new THREE.DataTexture(data, N, 4, THREE.RGBAFormat, THREE.FloatType);
  tex.minFilter = THREE.NearestFilter;
  tex.magFilter = THREE.NearestFilter;
  tex.needsUpdate = true;

  // ---- geometry: one quad, instanced; aIdx is the (sorted) puff index ----
  const geo = new THREE.InstancedBufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array([-1, -1, 0, 1, -1, 0, 1, 1, 0, -1, 1, 0]), 3));
  geo.setIndex([0, 1, 2, 0, 2, 3]);
  const idx = new Float32Array(N);
  for (let i = 0; i < N; i++) idx[i] = i;
  const idxAttr = new THREE.InstancedBufferAttribute(idx, 1);
  idxAttr.setUsage(THREE.DynamicDrawUsage);
  geo.setAttribute('aIdx', idxAttr);
  geo.instanceCount = N;

  const uniforms = { ...planetUniforms, uData: { value: tex }, uMoonDir: atmosUniforms.uMoonDir };
  const mat = new THREE.ShaderMaterial({
    name: 'clouds',
    uniforms,
    vertexShader: vertex,
    fragmentShader: fragment,
    transparent: true,
    // Puffs are sorted back to front every frame, so writing (ray-traced) depth is safe, and it gives
    // post's aerial perspective the cloud's own distance instead of the terrain/sky behind it.
    depthWrite: true,
    depthTest: true,
    premultipliedAlpha: true,
    blending: THREE.NormalBlending,
    side: THREE.DoubleSide,
  });
  mat.shadowSide = THREE.DoubleSide;
  const mesh = new THREE.Mesh(geo, mat);
  mesh.frustumCulled = false;
  mesh.castShadow = true;
  mesh.receiveShadow = false;
  mesh.name = 'clouds';
  mesh.customDepthMaterial = new THREE.ShaderMaterial({
    name: 'clouds-shadow',
    uniforms: { ...planetUniforms, uData: { value: tex } },
    vertexShader: depthVertex,
    fragmentShader: depthFragment,
    side: THREE.DoubleSide,
  });
  ctx.scene.add(mesh);

  // ---- per-frame: sort back to front + camera-in-cloud fog ----
  const px = new Float32Array(N);
  const py = new Float32Array(N);
  const pz = new Float32Array(N);
  const pr = new Float32Array(N);
  const p0x = new Float32Array(N), p0y = new Float32Array(N), p0z = new Float32Array(N);
  for (let i = 0; i < N; i++) {
    p0x[i] = puffs[i].p.x; p0y[i] = puffs[i].p.y; p0z[i] = puffs[i].p.z;
    pr[i] = puffs[i].r * Math.max(puffs[i].ryT, 1);
  }
  const key = new Float32Array(N);
  const order: number[] = Array.from({ length: N }, (_, i) => i);
  const byKey = (a: number, b: number) => key[b] - key[a];
  const ambC = new THREE.Color();
  const tint = new THREE.Color();

  return {
    cloudsAt(t: number) {
      return clouds.map((cl) => ({
        centre: cl.centre.clone().applyAxisAngle(cl.axis, cl.omega * t),
        size: cl.size,
        baseRadius: cl.base,
      }));
    },
    update(c) {
      const t = c.time;
      const cam = c.camera.position;
      let fog = 0;
      for (const cl of clouds) {
        const ang = cl.omega * t;
        const co = Math.cos(ang), si = Math.sin(ang), k1 = 1 - co;
        const ax = cl.axis.x, ay = cl.axis.y, az = cl.axis.z;
        for (let i = cl.first; i < cl.first + cl.count; i++) {
          const vx = p0x[i], vy = p0y[i], vz = p0z[i];
          const d = ax * vx + ay * vy + az * vz;
          const x = vx * co + (ay * vz - az * vy) * si + ax * d * k1;
          const y = vy * co + (az * vx - ax * vz) * si + ay * d * k1;
          const z = vz * co + (ax * vy - ay * vx) * si + az * d * k1;
          px[i] = x; py[i] = y; pz[i] = z;
          const dx = x - cam.x, dy = y - cam.y, dz = z - cam.z;
          const d2 = dx * dx + dy * dy + dz * dz;
          key[i] = d2;
          const q = Math.sqrt(d2) / pr[i];
          if (q < 1.25) fog += 1 - Math.min(1, Math.max(0, (q - 0.5) / 0.75));
        }
      }
      order.sort(byKey);
      for (let i = 0; i < N; i++) idx[i] = order[i];
      idxAttr.needsUpdate = true;

      // fog colour ~ a mid-lit cloud at the camera's position on the planet
      const camLen = cam.length() || 1;
      const h = (cam.x * c.sunDir.x + cam.y * c.sunDir.y + cam.z * c.sunDir.z) / camLen + 0.06;
      sunTintCPU(h, tint);
      skyAmbientCPU(h, ambC);
      cloudFog.color.setRGB(tint.r * 1.15 + ambC.r * 0.9, tint.g * 1.15 + ambC.g * 0.9, tint.b * 1.15 + ambC.b * 0.9);
      const f = Math.min(1, fog);
      cloudFog.amount = f * f * (3 - 2 * f) * 0.97;
      updateMoonDir(c.sunDir);
    },
  };
}
