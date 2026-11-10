// Planet lighting: the sun is one global direction, but its COLOUR depends on where you stand.
// At the sub-solar point it is noon-white, along the terminator it is sunset orange, and behind
// that it is night. That is what makes "one side of the planet is always sunset" work.
//
// Rules for every material in the world:
//   - Built-in lit materials (Standard / Lambert / Phong / Toon): wrap with applyPlanetLighting().
//   - Hand-written ShaderMaterials: include PLANET_GLSL, add `...planetUniforms` to uniforms and use
//     planetSunTint / planetAmbient / planetNight yourself.
//   - Do NOT add AmbientLight / HemisphereLight / PointLight / SpotLight to the scene. The only real
//     light is ctx.sun (a DirectionalLight with shadows). Ambient comes from planetAmbient(), and
//     warm night-time light pools come from ctx.registerGlow().
import * as THREE from 'three';

export const MAX_GLOWS = 12;

/** Shared uniform objects. The same object instances are handed to every material, so one write updates all. */
export const planetUniforms = {
  /** Seconds. Drives all shader animation. */
  uTime: { value: 0 },
  /** Unit vector from the planet centre toward the sun. */
  uSunDir: { value: new THREE.Vector3(1, 0, 0) },
  /** xyz = world position, w = radius of a warm night-time light pool. */
  uGlowPos: { value: Array.from({ length: MAX_GLOWS }, () => new THREE.Vector4(0, 0, 0, 0)) },
  uGlowCol: { value: Array.from({ length: MAX_GLOWS }, () => new THREE.Color(0, 0, 0)) },
};

/** GLSL: uniforms + helper functions. Works in vertex and fragment shaders. */
export const PLANET_GLSL = /* glsl */ `
#ifndef PLANET_GLSL
#define PLANET_GLSL
uniform float uTime;
uniform vec3 uSunDir;
uniform vec4 uGlowPos[${MAX_GLOWS}];
uniform vec3 uGlowCol[${MAX_GLOWS}];

// Sine of the local sun elevation at world position wp: 1 = noon, 0 = sun on the horizon, <0 = night.
float planetSunH(vec3 wp) { return dot(normalize(wp), uSunDir); }

// Colour * intensity multiplier for direct sunlight at local sun height h.
vec3 planetSunTint(float h) {
  float vis = smoothstep(-0.14, 0.06, h);
  vec3 c = mix(vec3(1.0, 0.40, 0.15), vec3(1.0, 0.68, 0.30), smoothstep(-0.06, 0.14, h));
  c = mix(c, vec3(1.0, 0.95, 0.88), smoothstep(0.16, 0.55, h));
  return c * vis * mix(0.92, 1.0, smoothstep(0.0, 0.4, h));
}

// 0 by day, 1 at night. Ramps through dusk. Use it to switch on windows, lamps, stars.
float planetNight(float h) { return 1.0 - smoothstep(-0.20, 0.06, h); }

// Sky / bounce light. upness: 1 = surface faces away from the planet centre, 0 = faces the ground.
vec3 planetAmbient(float h, float upness) {
  float day = smoothstep(-0.05, 0.35, h);
  float dusk = 1.0 - abs(clamp((h - 0.02) / 0.22, -1.0, 1.0));
  float night = planetNight(h);
  // dusk ambient: warm orange-pink while the sun is up, sliding to a cool mauve after it sets
  float warm = smoothstep(-0.12, 0.04, h);
  vec3 duskSky = mix(vec3(0.30, 0.20, 0.36), vec3(0.56, 0.33, 0.27), warm);
  vec3 duskGnd = mix(vec3(0.16, 0.11, 0.14), vec3(0.30, 0.16, 0.10), warm);
  vec3 sky = vec3(0.34, 0.47, 0.66) * day + duskSky * dusk * 0.75 + vec3(0.050, 0.075, 0.150) * night;
  vec3 ground = vec3(0.26, 0.24, 0.16) * day + duskGnd * dusk * 0.6 + vec3(0.020, 0.028, 0.055) * night;
  return mix(ground, sky, upness);
}

// Warm light pools from registered glows (lit windows, lamps). Fades in with night.
vec3 planetGlow(vec3 wp, float h) {
  vec3 g = vec3(0.0);
  for (int i = 0; i < ${MAX_GLOWS}; i++) {
    float r = uGlowPos[i].w;
    if (r > 0.0) {
      float a = max(0.0, 1.0 - distance(wp, uGlowPos[i].xyz) / r);
      g += uGlowCol[i] * a * a;
    }
  }
  return g * planetNight(h);
}
#endif
`;

export interface PlanetLightingOptions {
  /** Multiply the material's emissive by planetNight(), so emissive only shows from dusk on (lit windows, lamps). */
  nightEmissive?: boolean;
  /** Extra uniforms for your own shader edits. */
  uniforms?: Record<string, THREE.IUniform>;
  /** Your own onBeforeCompile edits (wind sway etc). Runs after the planet patch. */
  patch?: (shader: THREE.WebGLProgramParametersWithUniforms) => void;
  /** Must be unique per distinct `patch` so three does not share programs wrongly. */
  key?: string;
}

/**
 * Patch a built-in lit material (Standard, Physical, Lambert, Phong, Toon) for planet lighting.
 * Adds varying `vPlanetPos` (world position, valid in both stages after <project_vertex>).
 * Returns the same material.
 */
export function applyPlanetLighting<T extends THREE.Material>(material: T, opts: PlanetLightingOptions = {}): T {
  material.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, planetUniforms, opts.uniforms ?? {});
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>\n${PLANET_GLSL}\nvarying vec3 vPlanetPos;`)
      .replace(
        '#include <project_vertex>',
        /* glsl */ `#include <project_vertex>
        {
          vec4 pw = vec4(transformed, 1.0);
          #ifdef USE_BATCHING
            pw = batchingMatrix * pw;
          #endif
          #ifdef USE_INSTANCING
            pw = instanceMatrix * pw;
          #endif
          vPlanetPos = (modelMatrix * pw).xyz;
        }`,
      );
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>\n${PLANET_GLSL}\nvarying vec3 vPlanetPos;`)
      .replace(
        '#include <lights_fragment_end>',
        /* glsl */ `#include <lights_fragment_end>
        {
          float pH = planetSunH(vPlanetPos);
          vec3 pTint = planetSunTint(pH);
          reflectedLight.directDiffuse *= pTint;
          reflectedLight.directSpecular *= pTint;
          vec3 pUp = normalize((viewMatrix * vec4(normalize(vPlanetPos), 0.0)).xyz);
          vec3 pAmb = planetAmbient(pH, dot(normal, pUp) * 0.5 + 0.5) + planetGlow(vPlanetPos, pH);
          reflectedLight.indirectDiffuse += pAmb * material.diffuseColor;
        }`,
      );
    if (opts.nightEmissive) {
      shader.fragmentShader = shader.fragmentShader.replace(
        '#include <emissivemap_fragment>',
        /* glsl */ `#include <emissivemap_fragment>
        totalEmissiveRadiance *= planetNight(planetSunH(vPlanetPos));`,
      );
    }
    opts.patch?.(shader);
  };
  const key = `planet:${opts.nightEmissive ? 'n' : ''}:${opts.key ?? (opts.patch ? opts.patch.toString().length + ':' + hash(opts.patch.toString()) : '')}`;
  material.customProgramCacheKey = () => key;
  return material;
}

function hash(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (Math.imul(h, 31) + s.charCodeAt(i)) | 0;
  return h;
}

// ---- CPU mirrors (for game logic: audio, UI, anything that needs "is it night here?") ----
const ss = (a: number, b: number, x: number) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};
/** Local sun height at a world position / direction. */
export function sunHeightAt(pos: THREE.Vector3, sunDir: THREE.Vector3): number {
  return pos.dot(sunDir) / (pos.length() || 1);
}
/** CPU mirror of planetNight(). */
export function nightAt(pos: THREE.Vector3, sunDir: THREE.Vector3): number {
  return 1 - ss(-0.2, 0.06, sunHeightAt(pos, sunDir));
}
