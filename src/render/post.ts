// Final image. HDR pipeline:
//   scene -> MSAA x4 half-float target (+ depth texture)
//   bloom: threshold + 13-tap downsample chain (1/2 .. 1/64) and tent upsample, half float
//   final full-screen pass: aerial perspective from depth (same atmosphere integral as the sky),
//   in-cloud fog, + bloom, exposure, ACES (once; matches renderer.toneMapping for --nopost),
//   gentle grade (warm highlights, cool shadows, a touch of saturation), vignette, sRGB, static dither.
// No per-frame allocation.
import * as THREE from 'three';
import type { Ctx, Post } from '../core/context';
import { PLANET_GLSL, planetUniforms } from '../core/lighting';
import { ATMOS_GLSL, atmosUniforms, cloudFog } from '../sky/atmosphere';

const LEVELS = 6;

const fsVertex = /* glsl */ `
varying vec2 vUv;
void main() { vUv = position.xy * 0.5 + 0.5; gl_Position = vec4(position.xy, 0.0, 1.0); }`;

const downFragment = /* glsl */ `
uniform sampler2D tSrc;
uniform vec2 uTexel;
uniform float uFirst;
uniform vec2 uThreshold; // threshold, knee
varying vec2 vUv;
vec3 S(float x, float y) { return texture2D(tSrc, vUv + vec2(x, y) * uTexel).rgb; }
float lum(vec3 c) { return dot(c, vec3(0.2126, 0.7152, 0.0722)); }
vec3 karis(vec3 a, vec3 b, vec3 c, vec3 d) {
  vec3 s = (a + b + c + d) * 0.25;
  return s / (1.0 + lum(s) * 0.25);
}
void main() {
  vec3 a = S(-2.0, 2.0), b = S(0.0, 2.0), c = S(2.0, 2.0);
  vec3 d = S(-2.0, 0.0), e = S(0.0, 0.0), f = S(2.0, 0.0);
  vec3 g = S(-2.0, -2.0), h = S(0.0, -2.0), i = S(2.0, -2.0);
  vec3 j = S(-1.0, 1.0), k = S(1.0, 1.0), l = S(-1.0, -1.0), m = S(1.0, -1.0);
  vec3 col;
  if (uFirst > 0.5) {
    // Karis average per group kills fireflies (sun glitter) before they smear into blobs.
    col = karis(j, k, l, m) * 0.5 + karis(a, b, d, e) * 0.125 + karis(b, c, e, f) * 0.125
        + karis(d, e, g, h) * 0.125 + karis(e, f, h, i) * 0.125;
    col /= max(1.0 - lum(col) * 0.25, 0.05); // undo the Karis compression on the average
    float br = max(col.r, max(col.g, col.b));
    float rq = clamp(br - uThreshold.x + uThreshold.y, 0.0, 2.0 * uThreshold.y);
    rq = rq * rq / (4.0 * uThreshold.y + 1e-4);
    col *= max(rq, br - uThreshold.x) / max(br, 1e-4);
    col = min(col, vec3(60.0));
  } else {
    col = e * 0.125 + (a + c + g + i) * 0.03125 + (b + d + f + h) * 0.0625 + (j + k + l + m) * 0.125;
  }
  gl_FragColor = vec4(col, 1.0);
}`;

const upFragment = /* glsl */ `
uniform sampler2D tSrc;
uniform vec2 uTexel;
uniform float uWeight;
varying vec2 vUv;
vec3 S(float x, float y) { return texture2D(tSrc, vUv + vec2(x, y) * uTexel).rgb; }
void main() {
  vec3 c = S(0.0, 0.0) * 4.0 + (S(-1.0, 0.0) + S(1.0, 0.0) + S(0.0, -1.0) + S(0.0, 1.0)) * 2.0
         + S(-1.0, -1.0) + S(1.0, -1.0) + S(-1.0, 1.0) + S(1.0, 1.0);
  gl_FragColor = vec4(c / 16.0 * uWeight, 1.0);
}`;

const finalFragment = /* glsl */ `
${PLANET_GLSL}
${ATMOS_GLSL}
uniform sampler2D tColor;
uniform sampler2D tDepth;
uniform sampler2D tBloom;
uniform mat4 uProjInv;
uniform mat4 uCamWorld;
uniform vec3 uCamPos;
uniform float uBloom;
uniform float uExposure;
uniform vec3 uFogCol;
uniform float uFogAmt;
uniform float uAerial;
uniform vec2 uAspect;
varying vec2 vUv;

vec3 RRTAndODTFit(vec3 v) {
  vec3 a = v * (v + 0.0245786) - 0.000090537;
  vec3 b = v * (0.983729 * v + 0.4329510) + 0.238081;
  return a / b;
}
// three.js' ACESFilmicToneMapping (same curve as renderer.toneMapping, so --nopost matches).
vec3 acesFilmic(vec3 color) {
  const mat3 ACESInputMat = mat3(vec3(0.59719, 0.07600, 0.02840), vec3(0.35458, 0.90834, 0.13383), vec3(0.04823, 0.01566, 0.83777));
  const mat3 ACESOutputMat = mat3(vec3(1.60475, -0.10208, -0.00327), vec3(-0.53108, 1.10813, -0.07276), vec3(-0.07367, -0.00605, 1.07602));
  color *= 1.0 / 0.6;
  color = ACESInputMat * color;
  color = RRTAndODTFit(color);
  color = ACESOutputMat * color;
  return clamp(color, 0.0, 1.0);
}
vec3 toSRGB(vec3 c) {
  return mix(c * 12.92, pow(c, vec3(0.41666)) * 1.055 - 0.055, step(0.0031308, c));
}
float hash12(vec2 p) { vec3 p3 = fract(vec3(p.xyx) * 0.1031); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.x + p3.y) * p3.z); }

void main() {
  vec3 c = texture2D(tColor, vUv).rgb;
  float d = texture2D(tDepth, vUv).x;
  if (d < 1.0 && uAerial > 0.0) {
    vec4 vp = uProjInv * vec4(vUv * 2.0 - 1.0, d * 2.0 - 1.0, 1.0);
    vp.xyz /= vp.w;
    float dist = length(vp.xyz);
    vec3 rd = normalize((uCamWorld * vec4(vp.xyz, 0.0)).xyz);
    vec3 L, T;
    atmIntegrate(uCamPos, rd, dist, 10, L, T);
    L = atmPaint(uCamPos, rd, L, 1.0 - exp(-dist / 30.0)); // painted haze grows with path length
    L *= atmSpaceGain(uCamPos);
    // Full strength at orbital distances (seamless with the sky at the limb), gentle up close.
    float k = uAerial * (0.08 + 0.34 * smoothstep(10.0, 140.0, dist));
    c = c * mix(vec3(1.0), T, k) + L * k;
  }
  c = mix(c, uFogCol, uFogAmt);
  c += texture2D(tBloom, vUv).rgb * uBloom;
  c *= uExposure;
  c = acesFilmic(c);

  // grade (display-referred, linear)
  float l = dot(c, vec3(0.2126, 0.7152, 0.0722));
  c = mix(vec3(l), c, 1.07);
  c *= mix(vec3(0.96, 0.99, 1.06), vec3(1.0), smoothstep(0.02, 0.4, l));
  c *= mix(vec3(1.0), vec3(1.03, 1.0, 0.955), smoothstep(0.35, 1.0, l));
  // vignette
  vec2 v = (vUv - 0.5) * uAspect;
  float vig = 1.0 - smoothstep(0.35, 1.05, length(v));
  c *= mix(0.78, 1.0, vig);
  c = toSRGB(clamp(c, 0.0, 1.0));
  // static triangular dither (+-1 LSB) against banding in sky gradients
  float n = hash12(gl_FragCoord.xy) + hash12(gl_FragCoord.xy + 17.17) - 1.0;
  c += n / 255.0;
  gl_FragColor = vec4(c, 1.0);
}`;

export function createPost(ctx: Ctx): Post {
  const renderer = ctx.renderer;

  const scene = new THREE.WebGLRenderTarget(1, 1, {
    type: THREE.HalfFloatType,
    samples: 4,
    depthBuffer: true,
    minFilter: THREE.LinearFilter,
    magFilter: THREE.LinearFilter,
  });
  scene.depthTexture = new THREE.DepthTexture(1, 1, THREE.UnsignedIntType);
  scene.depthTexture.minFilter = THREE.NearestFilter;
  scene.depthTexture.magFilter = THREE.NearestFilter;

  const levels: THREE.WebGLRenderTarget[] = [];
  for (let i = 0; i < LEVELS; i++) {
    levels.push(
      new THREE.WebGLRenderTarget(1, 1, {
        type: THREE.HalfFloatType,
        depthBuffer: false,
        minFilter: THREE.LinearFilter,
        magFilter: THREE.LinearFilter,
        wrapS: THREE.ClampToEdgeWrapping,
        wrapT: THREE.ClampToEdgeWrapping,
      }),
    );
  }

  const tri = new THREE.BufferGeometry();
  tri.setAttribute('position', new THREE.BufferAttribute(new Float32Array([-1, -1, 0, 3, -1, 0, -1, 3, 0]), 3));
  const quad = new THREE.Mesh(tri);
  quad.frustumCulled = false;
  const cam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);

  const common = { depthTest: false, depthWrite: false, toneMapped: false };
  const down = new THREE.ShaderMaterial({
    ...common,
    name: 'post-down',
    uniforms: { tSrc: { value: null }, uTexel: { value: new THREE.Vector2() }, uFirst: { value: 0 }, uThreshold: { value: new THREE.Vector2(3.0, 1.5) } },
    vertexShader: fsVertex,
    fragmentShader: downFragment,
  });
  const up = new THREE.ShaderMaterial({
    ...common,
    name: 'post-up',
    uniforms: { tSrc: { value: null }, uTexel: { value: new THREE.Vector2() }, uWeight: { value: 1 } },
    vertexShader: fsVertex,
    fragmentShader: upFragment,
    blending: THREE.CustomBlending,
    blendSrc: THREE.OneFactor,
    blendDst: THREE.OneFactor,
    blendEquation: THREE.AddEquation,
  });
  const fin = new THREE.ShaderMaterial({
    ...common,
    name: 'post-final',
    uniforms: {
      ...planetUniforms,
      ...atmosUniforms,
      tColor: { value: scene.texture },
      tDepth: { value: scene.depthTexture },
      tBloom: { value: levels[0].texture },
      uProjInv: { value: new THREE.Matrix4() },
      uCamWorld: { value: new THREE.Matrix4() },
      uCamPos: { value: new THREE.Vector3() },
      uBloom: { value: 0.08 },
      uExposure: { value: 1.0 },
      uFogCol: { value: cloudFog.color },
      uFogAmt: { value: 0 },
      uAerial: { value: 1 },
      uAspect: { value: new THREE.Vector2(1, 1) },
    },
    vertexShader: fsVertex,
    fragmentShader: finalFragment,
  });

  const pass = (mat: THREE.Material, target: THREE.WebGLRenderTarget | null) => {
    quad.material = mat;
    renderer.setRenderTarget(target);
    renderer.render(quad, cam);
  };

  const u = fin.uniforms;
  const post: Post = {
    render(c: Ctx) {
      const prevAuto = renderer.autoClear;
      renderer.autoClear = true;
      renderer.setRenderTarget(scene);
      renderer.render(c.scene, c.camera);
      renderer.autoClear = false;

      // bloom chain
      let src: THREE.Texture = scene.texture;
      let sw = scene.width, sh = scene.height;
      for (let i = 0; i < LEVELS; i++) {
        down.uniforms.tSrc.value = src;
        down.uniforms.uTexel.value.set(1 / sw, 1 / sh);
        down.uniforms.uFirst.value = i === 0 ? 1 : 0;
        pass(down, levels[i]);
        src = levels[i].texture;
        sw = levels[i].width;
        sh = levels[i].height;
      }
      for (let i = LEVELS - 1; i > 0; i--) {
        up.uniforms.tSrc.value = levels[i].texture;
        up.uniforms.uTexel.value.set(1 / levels[i].width, 1 / levels[i].height);
        up.uniforms.uWeight.value = 1.0;
        pass(up, levels[i - 1]);
      }

      // final
      u.uProjInv.value.copy(c.camera.projectionMatrixInverse);
      u.uCamWorld.value.copy(c.camera.matrixWorld);
      u.uCamPos.value.setFromMatrixPosition(c.camera.matrixWorld);
      u.uFogAmt.value = cloudFog.amount;
      u.uExposure.value = renderer.toneMappingExposure;
      pass(fin, null);
      renderer.autoClear = prevAuto;
    },
    resize(w: number, h: number, pixelRatio: number) {
      const W = Math.max(1, Math.round(w * pixelRatio));
      const H = Math.max(1, Math.round(h * pixelRatio));
      scene.setSize(W, H);
      let lw = W, lh = H;
      for (let i = 0; i < LEVELS; i++) {
        lw = Math.max(1, lw >> 1);
        lh = Math.max(1, lh >> 1);
        levels[i].setSize(lw, lh);
      }
      const a = W / H;
      u.uAspect.value.set(a, 1);
    },
  };
  const size = renderer.getSize(new THREE.Vector2());
  post.resize(size.x, size.y, renderer.getPixelRatio());
  return post;
}
