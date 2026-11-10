// Shared, memoised bake of heightAt() on an equal-angle cube-sphere grid.
// Used by the terrain mesh (vertex positions / normals / cavity) and by the ocean (a height atlas
// texture sampled in the water shader for depth, shoreline foam and transparency).
//
// Layout: 6 faces, each sampled at (N+1) x (N+1) points with angles alpha_i = -pi/4 + i * (pi/2) / N,
// plus an apron of PAD samples on every side (the same mapping continued past +-45 degrees), so that
// central differences and texture filtering never have to cross a face edge.
import * as THREE from 'three';
import { heightAtXYZ } from '../core/terrain';

/** Grid cells per cube face edge. 192 -> ~0.5 unit vertex spacing at R = 60. */
export const GRID_N = 192;
/** Apron samples on each side of every face. */
export const GRID_PAD = 6;
/** Samples per face row including the apron. */
export const GRID_W = GRID_N + 1 + 2 * GRID_PAD;

/** Face frames: F (face normal), U (+i), V (+j). cross(U, V) = F, so CCW (i, j) quads face outward. */
export const FACES: [number[], number[], number[]][] = [
  [[1, 0, 0], [0, 0, -1], [0, 1, 0]],
  [[-1, 0, 0], [0, 0, 1], [0, 1, 0]],
  [[0, 1, 0], [1, 0, 0], [0, 0, -1]],
  [[0, -1, 0], [1, 0, 0], [0, 0, 1]],
  [[0, 0, 1], [1, 0, 0], [0, 1, 0]],
  [[0, 0, -1], [-1, 0, 0], [0, 1, 0]],
];

export interface PlanetGrid {
  /** Unit directions, 3 floats per sample, index ((f * GRID_W + jj) * GRID_W + ii) with padded ii, jj. */
  dirs: Float32Array;
  /** heightAt per sample. */
  heights: Float32Array;
  /** Bake time in ms (for the report / stats). */
  ms: number;
}

let grid: PlanetGrid | null = null;

/** Padded-grid index of face f, padded column ii, padded row jj. */
export const gidx = (f: number, ii: number, jj: number) => (f * GRID_W + jj) * GRID_W + ii;

/** Bakes once (about 0.25 s), then returns the cached grid. */
export function getPlanetGrid(): PlanetGrid {
  if (grid) return grid;
  const t0 = performance.now();
  const total = 6 * GRID_W * GRID_W;
  const dirs = new Float32Array(total * 3);
  const heights = new Float32Array(total);
  const tan = new Float64Array(GRID_W);
  for (let k = 0; k < GRID_W; k++) {
    const i = k - GRID_PAD;
    // exact +-1 at the face edges so neighbouring faces produce bit-identical edge vertices
    tan[k] = i === 0 ? -1 : i === GRID_N ? 1 : i * 2 === GRID_N ? 0 : Math.tan(-Math.PI / 4 + (i * Math.PI) / 2 / GRID_N);
  }
  for (let f = 0; f < 6; f++) {
    const [F, U, V] = FACES[f];
    for (let jj = 0; jj < GRID_W; jj++) {
      const b = tan[jj];
      for (let ii = 0; ii < GRID_W; ii++) {
        const a = tan[ii];
        let x = F[0] + a * U[0] + b * V[0];
        let y = F[1] + a * U[1] + b * V[1];
        let z = F[2] + a * U[2] + b * V[2];
        const l = 1 / Math.hypot(x, y, z);
        x *= l;
        y *= l;
        z *= l;
        const g = gidx(f, ii, jj);
        dirs[g * 3] = x;
        dirs[g * 3 + 1] = y;
        dirs[g * 3 + 2] = z;
        heights[g] = heightAtXYZ(x, y, z);
      }
    }
  }
  grid = { dirs, heights, ms: performance.now() - t0 };
  return grid;
}

let heightTex: THREE.DataTexture | null = null;

/**
 * The grid as a half-float atlas texture: width GRID_W, height 6 * GRID_W (face f occupies rows
 * f*GRID_W .. f*GRID_W + GRID_W - 1). Sample it with HEIGHT_TEX_GLSL.
 */
export function getHeightTexture(): THREE.DataTexture {
  if (heightTex) return heightTex;
  const { heights } = getPlanetGrid();
  const data = new Uint16Array(heights.length);
  for (let i = 0; i < heights.length; i++) data[i] = THREE.DataUtils.toHalfFloat(heights[i]);
  const tex = new THREE.DataTexture(data, GRID_W, 6 * GRID_W, THREE.RedFormat, THREE.HalfFloatType);
  tex.magFilter = THREE.LinearFilter;
  tex.minFilter = THREE.LinearFilter;
  tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;
  tex.generateMipmaps = false;
  tex.colorSpace = THREE.NoColorSpace;
  tex.needsUpdate = true;
  heightTex = tex;
  return tex;
}

/**
 * GLSL: `float planetHeight(sampler2D tex, vec3 dir)` (bilinear) and `planetHeightSmooth` (cubic
 * B-spline, C2-smooth contours: use it for shoreline effects). Needs uniform uHeightTex.
 */
export const HEIGHT_TEX_GLSL = /* glsl */ `
const float HT_N = ${GRID_N.toFixed(1)};
const float HT_PAD = ${GRID_PAD.toFixed(1)};
const float HT_W = ${GRID_W.toFixed(1)};
// texel-space coordinate (x in [0, HT_W), y in [0, 6*HT_W)) of a unit direction
vec2 htTexel(vec3 d) {
  vec3 a = abs(d);
  float f; vec3 F; vec3 U; vec3 V;
  if (a.x >= a.y && a.x >= a.z) {
    if (d.x > 0.0) { f = 0.0; F = vec3(1,0,0); U = vec3(0,0,-1); V = vec3(0,1,0); }
    else           { f = 1.0; F = vec3(-1,0,0); U = vec3(0,0,1); V = vec3(0,1,0); }
  } else if (a.y >= a.z) {
    if (d.y > 0.0) { f = 2.0; F = vec3(0,1,0); U = vec3(1,0,0); V = vec3(0,0,-1); }
    else           { f = 3.0; F = vec3(0,-1,0); U = vec3(1,0,0); V = vec3(0,0,1); }
  } else {
    if (d.z > 0.0) { f = 4.0; F = vec3(0,0,1); U = vec3(1,0,0); V = vec3(0,1,0); }
    else           { f = 5.0; F = vec3(0,0,-1); U = vec3(-1,0,0); V = vec3(0,1,0); }
  }
  float df = dot(d, F);
  vec2 ang = atan(vec2(dot(d, U), dot(d, V)) / df);           // [-pi/4, pi/4]
  vec2 g = (ang / 1.5707963 + 0.5) * HT_N + HT_PAD;             // padded grid coordinate
  return vec2(g.x + 0.5, f * HT_W + g.y + 0.5);
}
float planetHeight(sampler2D tex, vec3 d) {
  vec2 t = htTexel(d);
  return texture(tex, t / vec2(HT_W, 6.0 * HT_W)).r;
}
// cubic B-spline filtering from 4 bilinear taps (GPU Gems 2, ch. 20)
float planetHeightSmooth(sampler2D tex, vec3 d) {
  vec2 t = htTexel(d) - 0.5;
  vec2 fi = floor(t);
  vec2 fr = t - fi;
  vec2 one = 1.0 - fr;
  vec2 w0 = one * one * one / 6.0;
  vec2 w1 = (4.0 - 6.0 * fr * fr + 3.0 * fr * fr * fr) / 6.0;
  vec2 w2 = (4.0 - 6.0 * one * one + 3.0 * one * one * one) / 6.0;
  vec2 w3 = fr * fr * fr / 6.0;
  vec2 g0 = w0 + w1;
  vec2 g1 = w2 + w3;
  vec2 h0 = fi - 1.0 + w1 / g0 + 0.5;   // tap positions (+0.5: texel k's centre is at k + 0.5)
  vec2 h1 = fi + 1.0 + w3 / g1 + 0.5;
  vec2 sz = vec2(HT_W, 6.0 * HT_W);
  float a = texture(tex, vec2(h0.x, h0.y) / sz).r;
  float b = texture(tex, vec2(h1.x, h0.y) / sz).r;
  float c = texture(tex, vec2(h0.x, h1.y) / sz).r;
  float e = texture(tex, vec2(h1.x, h1.y) / sz).r;
  return g0.y * (g0.x * a + g1.x * b) + g1.y * (g0.x * c + g1.x * e);
}
`;
