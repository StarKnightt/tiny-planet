// Seeded 3D simplex noise + fbm. Deterministic: same seed -> same world.

function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Deterministic PRNG. Use this instead of Math.random for anything in the world. */
export function rng(seed: number): () => number {
  return mulberry32(seed);
}

const GRAD = [
  1, 1, 0, -1, 1, 0, 1, -1, 0, -1, -1, 0, 1, 0, 1, -1, 0, 1, 1, 0, -1, -1, 0, -1, 0, 1, 1, 0, -1, 1, 0, 1, -1, 0, -1,
  -1,
];

const perm = new Uint8Array(512);
const permMod12 = new Uint8Array(512);
{
  const r = mulberry32(1337);
  const p = new Uint8Array(256);
  for (let i = 0; i < 256; i++) p[i] = i;
  for (let i = 255; i > 0; i--) {
    const j = Math.floor(r() * (i + 1));
    const t = p[i];
    p[i] = p[j];
    p[j] = t;
  }
  for (let i = 0; i < 512; i++) {
    perm[i] = p[i & 255];
    permMod12[i] = perm[i] % 12;
  }
}

const F3 = 1 / 3;
const G3 = 1 / 6;

/** 3D simplex noise, range about [-1, 1]. */
export function simplex3(x: number, y: number, z: number): number {
  const s = (x + y + z) * F3;
  const i = Math.floor(x + s);
  const j = Math.floor(y + s);
  const k = Math.floor(z + s);
  const t = (i + j + k) * G3;
  const x0 = x - (i - t);
  const y0 = y - (j - t);
  const z0 = z - (k - t);
  let i1, j1, k1, i2, j2, k2;
  if (x0 >= y0) {
    if (y0 >= z0) {
      i1 = 1; j1 = 0; k1 = 0; i2 = 1; j2 = 1; k2 = 0;
    } else if (x0 >= z0) {
      i1 = 1; j1 = 0; k1 = 0; i2 = 1; j2 = 0; k2 = 1;
    } else {
      i1 = 0; j1 = 0; k1 = 1; i2 = 1; j2 = 0; k2 = 1;
    }
  } else {
    if (y0 < z0) {
      i1 = 0; j1 = 0; k1 = 1; i2 = 0; j2 = 1; k2 = 1;
    } else if (x0 < z0) {
      i1 = 0; j1 = 1; k1 = 0; i2 = 0; j2 = 1; k2 = 1;
    } else {
      i1 = 0; j1 = 1; k1 = 0; i2 = 1; j2 = 1; k2 = 0;
    }
  }
  const x1 = x0 - i1 + G3, y1 = y0 - j1 + G3, z1 = z0 - k1 + G3;
  const x2 = x0 - i2 + 2 * G3, y2 = y0 - j2 + 2 * G3, z2 = z0 - k2 + 2 * G3;
  const x3 = x0 - 1 + 3 * G3, y3 = y0 - 1 + 3 * G3, z3 = z0 - 1 + 3 * G3;
  const ii = i & 255, jj = j & 255, kk = k & 255;
  let n = 0;
  let tt = 0.6 - x0 * x0 - y0 * y0 - z0 * z0;
  if (tt > 0) {
    const g = permMod12[ii + perm[jj + perm[kk]]] * 3;
    tt *= tt;
    n += tt * tt * (GRAD[g] * x0 + GRAD[g + 1] * y0 + GRAD[g + 2] * z0);
  }
  tt = 0.6 - x1 * x1 - y1 * y1 - z1 * z1;
  if (tt > 0) {
    const g = permMod12[ii + i1 + perm[jj + j1 + perm[kk + k1]]] * 3;
    tt *= tt;
    n += tt * tt * (GRAD[g] * x1 + GRAD[g + 1] * y1 + GRAD[g + 2] * z1);
  }
  tt = 0.6 - x2 * x2 - y2 * y2 - z2 * z2;
  if (tt > 0) {
    const g = permMod12[ii + i2 + perm[jj + j2 + perm[kk + k2]]] * 3;
    tt *= tt;
    n += tt * tt * (GRAD[g] * x2 + GRAD[g + 1] * y2 + GRAD[g + 2] * z2);
  }
  tt = 0.6 - x3 * x3 - y3 * y3 - z3 * z3;
  if (tt > 0) {
    const g = permMod12[ii + 1 + perm[jj + 1 + perm[kk + 1]]] * 3;
    tt *= tt;
    n += tt * tt * (GRAD[g] * x3 + GRAD[g + 1] * y3 + GRAD[g + 2] * z3);
  }
  return 32 * n;
}

/** Fractal noise, range about [-1, 1]. */
export function fbm3(x: number, y: number, z: number, octaves = 4, lacunarity = 2, gain = 0.5): number {
  let amp = 1, freq = 1, sum = 0, norm = 0;
  for (let o = 0; o < octaves; o++) {
    sum += amp * simplex3(x * freq + o * 17.3, y * freq - o * 9.1, z * freq + o * 4.7);
    norm += amp;
    amp *= gain;
    freq *= lacunarity;
  }
  return sum / norm;
}
