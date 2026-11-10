import * as THREE from 'three';
import { applyPlanetLighting, PLANET_GLSL, planetUniforms } from '../core/lighting';

/**
 * The one material for everything built by people. Vertex colours carry albedo + baked AO.
 * Attribute aGlow (rgb = emissive * intensity, w = local sun height below which it is lit) gives each
 * window / lamp its own switch-on moment, so lights come on one by one as the terminator passes.
 */
export function villageMaterial(): THREE.MeshStandardMaterial {
  const mat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.88, metalness: 0 });
  return applyPlanetLighting(mat, {
    key: 'village-glow-v1',
    patch: (shader) => {
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', '#include <common>\nattribute vec4 aGlow;\nvarying vec4 vGlow;')
        .replace('#include <begin_vertex>', '#include <begin_vertex>\nvGlow = aGlow;');
      shader.fragmentShader = shader.fragmentShader
        .replace('#include <common>', '#include <common>\nvarying vec4 vGlow;')
        .replace(
          '#include <emissivemap_fragment>',
          /* glsl */ `#include <emissivemap_fragment>
          {
            float vsh = planetSunH(vPlanetPos);
            float on = smoothstep(vGlow.w + 0.018, vGlow.w - 0.018, vsh);
            // a slow, gentle candle-like breathing, different per window
            float fl = 0.93 + 0.07 * sin(uTime * 2.3 + vGlow.w * 517.0) * sin(uTime * 3.7 + vGlow.w * 211.0);
            totalEmissiveRadiance += vGlow.rgb * on * fl;
            // a lit pane is not also a dark shiny glass: lift its albedo a little so it reads warm
            diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.9, 0.6, 0.3), on * step(0.001, dot(vGlow.rgb, vec3(1.0))) * 0.5);
          }`,
        );
    },
  });
}

/**
 * Soft volumetric light-house beams. The cone mesh is only a bounding volume (back faces, so each
 * pixel is shaded once even from inside it); the brightness is the analytic line integral of a
 * Gaussian beam along the view ray, so there are no polygon edges or ends to see.
 * Attribute aAxis = the cone's axis in object space. Uniform uLen = beam length, uR0/uR1 = widths.
 */
export function beamMaterial(): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    uniforms: {
      uNight: { value: 0 },
      uColor: { value: new THREE.Color(1.0, 0.84, 0.6).multiplyScalar(0.3) },
      uLen: { value: 55 },
      uR0: { value: 0.35 },
      uR1: { value: 4.2 },
    },
    vertexShader: /* glsl */ `
      attribute vec3 aAxis;
      varying vec3 vWorld;
      varying vec3 vApex;
      varying vec3 vAxis;
      void main() {
        vec4 wp = modelMatrix * vec4(position, 1.0);
        vWorld = wp.xyz;
        vApex = (modelMatrix * vec4(0.0, 0.0, 0.0, 1.0)).xyz;
        vAxis = normalize(mat3(modelMatrix) * aAxis);
        gl_Position = projectionMatrix * viewMatrix * wp;
      }`,
    fragmentShader: /* glsl */ `
      uniform float uNight;
      uniform vec3 uColor;
      uniform float uLen, uR0, uR1;
      varying vec3 vWorld;
      varying vec3 vApex;
      varying vec3 vAxis;
      void main() {
        vec3 O = cameraPosition;
        vec3 toF = vWorld - O;
        float L = length(toF);
        vec3 D = toF / L;
        vec3 U = normalize(vAxis);
        vec3 w0 = O - vApex;
        float b = dot(D, U), d = dot(D, w0), e = dot(U, w0);
        float den = max(1.0 - b * b, 1e-4);
        float s = clamp((b * e - d) / den, 0.0, L);
        vec3 P = O + D * s;
        float t = dot(P - vApex, U);
        float dist = length(P - (vApex + U * t));
        float tn = t / uLen;
        float w = mix(uR0, uR1, clamp(tn, 0.0, 1.0));
        float g = exp(-dist * dist / (w * w));
        // path length through the beam grows as the view lines up with it; keep it bounded
        float path = min(inversesqrt(den), 5.0);
        float along = smoothstep(-0.01, 0.03, tn) * pow(clamp(1.0 - tn, 0.0, 1.0), 2.2);
        float core = 1.0 + 3.0 * exp(-max(t, 0.0) * 0.35);
        // fade when the camera itself is very close to the closest-approach point
        float cam = smoothstep(0.3, 3.0, s + dist * 2.0);
        vec3 c = uColor * g * path * along * core * cam * uNight;
        gl_FragColor = vec4(c, 1.0);
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
      }`,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    side: THREE.BackSide,
  });
}

/** Camera-facing soft halo (lamp core flare). Quad corners in uv; centre from the mesh position. */
export function haloMaterial(color: THREE.Color, size: number): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    uniforms: { uNight: { value: 0 }, uColor: { value: color }, uSize: { value: size } },
    vertexShader: /* glsl */ `
      uniform float uSize;
      varying vec2 vUv;
      void main() {
        vUv = uv * 2.0 - 1.0;
        vec4 mv = modelViewMatrix * vec4(0.0, 0.0, 0.0, 1.0);
        mv.xy += vUv * uSize;
        gl_Position = projectionMatrix * mv;
      }`,
    fragmentShader: /* glsl */ `
      uniform float uNight;
      uniform vec3 uColor;
      varying vec2 vUv;
      void main() {
        float r = length(vUv);
        float a = exp(-r * r * 9.0) * 1.6 + exp(-r * 3.2) * 0.35;
        a *= smoothstep(1.0, 0.7, r);
        gl_FragColor = vec4(uColor * a * uNight, 1.0);
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
      }`,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
  });
}

/**
 * Chimney smoke: each puff is a quad expanded to face the camera in the vertex shader; it rises,
 * drifts, grows and fades as a pure function of uTime. Lit with the planet sun/ambient colours.
 */
export function smokeMaterial(): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    uniforms: { ...planetUniforms },
    vertexShader: /* glsl */ `
      ${PLANET_GLSL}
      attribute vec3 aBase;
      attribute vec3 aWind;
      attribute float aSeed;
      varying vec2 vUv;
      varying float vAlpha;
      varying vec3 vWorld;
      void main() {
        vec3 up = normalize(aBase);
        float ph = fract(uTime * 0.085 + aSeed);
        float rise = ph * 5.5;
        vec3 side = normalize(cross(up, aWind));
        vec3 c = aBase + up * rise + aWind * (ph * ph * 3.2)
               + side * sin(ph * 6.0 + aSeed * 40.0) * 0.35 * ph;
        float size = 0.28 + ph * 1.25;
        vAlpha = smoothstep(0.0, 0.12, ph) * pow(1.0 - ph, 1.6) * 0.55;
        vUv = uv * 2.0 - 1.0;
        vWorld = c;
        vec4 mv = viewMatrix * vec4(c, 1.0);
        float rot = aSeed * 6.28 + ph * 1.5;
        vec2 q = mat2(cos(rot), -sin(rot), sin(rot), cos(rot)) * vUv;
        mv.xy += q * size;
        gl_Position = projectionMatrix * mv;
      }`,
    fragmentShader: /* glsl */ `
      ${PLANET_GLSL}
      varying vec2 vUv;
      varying float vAlpha;
      varying vec3 vWorld;
      void main() {
        float r2 = dot(vUv, vUv);
        // lumpy edge
        float lump = 0.82 + 0.18 * sin(atan(vUv.y, vUv.x) * 5.0 + vAlpha * 30.0);
        float a = smoothstep(lump, lump * 0.25, sqrt(r2)) * vAlpha;
        if (a < 0.003) discard;
        float h = planetSunH(vWorld);
        vec3 lit = vec3(0.82, 0.8, 0.8) * (planetSunTint(h) * 0.75 + planetAmbient(h, 0.8) * 1.3) + planetGlow(vWorld, h) * 0.6;
        gl_FragColor = vec4(lit, a);
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
      }`,
    transparent: true,
    depthWrite: false,
  });
}
