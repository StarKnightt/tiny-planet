// Procedural ambient sound bed for the cinematic, synthesised entirely in code (no samples, no downloads).
//
//   node tools/audio-bed.mjs --out bed.wav [--duration 20] [--seed 7]
//   import { renderAudioBed, writeAudioBed } from './audio-bed.mjs'
//
// Output: 48 kHz stereo 24-bit PCM WAV, loudness-normalised to about -19 LUFS (ITU BS.1770 measured here,
// gated), sample peak <= -1 dBFS, deterministic for a given seed.
//
// CPU on purpose: this is a one-shot ~1 M-sample-per-channel job that finishes in about a second in
// plain JS; GPU setup would cost more than the whole render, and pure JS keeps it bit-reproducible.
//
// The film (see src/cinematic.ts): space -> cloud dive -> low over the sea / beach / hills -> village at dusk.
// RETIME HERE: every layer follows these cues (seconds of film time). Envelopes are smooth ramps between
// the listed points, so moving a number never creates a click.
export const CUES = {
  master: { fadeIn: 1.2, fadeOut: 1.8 },
  /** thin, airy high wind of altitude / space */
  spaceWind: [[0, 0.75], [3.5, 1], [6.5, 0.55], [9, 0.12], [12, 0.06]],
  /** the dive through the cloud layer: a swelling whoosh, peaking as the clouds rush past */
  whoosh: { start: 3.6, peak: 6.3, end: 8.6 },
  /** low gentle breeze once we are near the ground */
  breeze: [[0, 0], [6.5, 0], [9, 0.75], [14, 0.9], [20, 0.7]],
  /** ocean: swells with foam on each wash; strongest over the sea, a distant murmur over the village */
  waves: { env: [[0, 0], [6.8, 0], [8.2, 1], [12, 0.95], [14.5, 0.42], [17, 0.22], [20, 0.2]], first: 7.2, period: [3.3, 4.8] },
  /** birds over the hills and the village, thinning out as dusk falls */
  birds: { from: 10.6, to: 18.2, thinFrom: 15.2, gap: [0.35, 1.1] },
  /** warm pad underneath the whole film */
  pad: [[0, 0.55], [4, 0.8], [8, 0.55], [14, 0.7], [20, 0.95]],
  /** crickets for the last few seconds of dusk */
  crickets: [[0, 0], [16.6, 0], [19.2, 1], [20, 1]],
};

import fs from 'node:fs';

const SR = 48000;
const TAU = Math.PI * 2;

// ---------------------------------------------------------------------------------------------
// DSP building blocks
// ---------------------------------------------------------------------------------------------
function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** White noise in [-1, 1) from a seeded PRNG. */
const noiseGen = (rand) => () => rand() * 2 - 1;

/** Smooth random signal (cosine-interpolated value noise) with ~`rate` new values per second, range [-1, 1]. */
function smoothNoise(rand, rate) {
  let a = rand() * 2 - 1, b = rand() * 2 - 1, phase = 0;
  const step = rate / SR;
  return () => {
    phase += step;
    if (phase >= 1) { phase -= 1; a = b; b = rand() * 2 - 1; }
    const w = 0.5 - 0.5 * Math.cos(Math.PI * phase);
    return a + (b - a) * w;
  };
}

/** RBJ biquad, transposed direct form II (well behaved with slowly varying coefficients). */
class Biquad {
  constructor() { this.b0 = 1; this.b1 = 0; this.b2 = 0; this.a1 = 0; this.a2 = 0; this.z1 = 0; this.z2 = 0; }
  set(type, f, q = 0.707, gainDb = 0) {
    const w = (TAU * Math.min(Math.max(f, 10), SR * 0.45)) / SR;
    const cw = Math.cos(w), sw = Math.sin(w), alpha = sw / (2 * q);
    let b0, b1, b2, a0, a1, a2;
    const A = Math.pow(10, gainDb / 40);
    switch (type) {
      case 'lp': b0 = (1 - cw) / 2; b1 = 1 - cw; b2 = b0; a0 = 1 + alpha; a1 = -2 * cw; a2 = 1 - alpha; break;
      case 'hp': b0 = (1 + cw) / 2; b1 = -(1 + cw); b2 = b0; a0 = 1 + alpha; a1 = -2 * cw; a2 = 1 - alpha; break;
      case 'bp': b0 = alpha; b1 = 0; b2 = -alpha; a0 = 1 + alpha; a1 = -2 * cw; a2 = 1 - alpha; break; // 0 dB peak
      case 'hs': {
        const s = 2 * Math.sqrt(A) * alpha;
        b0 = A * (A + 1 + (A - 1) * cw + s); b1 = -2 * A * (A - 1 + (A + 1) * cw); b2 = A * (A + 1 + (A - 1) * cw - s);
        a0 = A + 1 - (A - 1) * cw + s; a1 = 2 * (A - 1 - (A + 1) * cw); a2 = A + 1 - (A - 1) * cw - s; break;
      }
      default: throw new Error(type);
    }
    this.b0 = b0 / a0; this.b1 = b1 / a0; this.b2 = b2 / a0; this.a1 = a1 / a0; this.a2 = a2 / a0;
    return this;
  }
  process(x) {
    const y = this.b0 * x + this.z1;
    this.z1 = this.b1 * x - this.a1 * y + this.z2;
    this.z2 = this.b2 * x - this.a2 * y;
    return y;
  }
}

/** Smooth envelope through [t, value] points (smoothstep between points; constant outside). */
function envelope(points) {
  return (t) => {
    if (t <= points[0][0]) return points[0][1];
    for (let i = 1; i < points.length; i++) {
      if (t <= points[i][0]) {
        const [t0, v0] = points[i - 1], [t1, v1] = points[i];
        const s = (t - t0) / (t1 - t0);
        return v0 + (v1 - v0) * s * s * (3 - 2 * s);
      }
    }
    return points[points.length - 1][1];
  };
}
const smoothstep = (a, b, x) => { const s = Math.min(Math.max((x - a) / (b - a), 0), 1); return s * s * (3 - 2 * s); };
const panGains = (p) => { const a = ((p + 1) * Math.PI) / 4; return [Math.cos(a), Math.sin(a)]; }; // equal power, p in [-1, 1]
const dbToGain = (db) => Math.pow(10, db / 20);
const lerp = (a, b, s) => a + (b - a) * s;

/** Freeverb-style stereo reverb (8 damped combs + 4 allpasses per side, decorrelated L/R). */
function reverb(inL, inR, { room = 0.78, damp = 0.45, wet = 1 } = {}) {
  const sc = SR / 44100;
  const combT = [1116, 1188, 1277, 1356, 1422, 1491, 1557, 1617];
  const apT = [556, 441, 341, 225];
  const mk = (spread) => ({
    combs: combT.map((d) => ({ buf: new Float32Array(Math.round((d + spread) * sc)), i: 0, store: 0 })),
    aps: apT.map((d) => ({ buf: new Float32Array(Math.round((d + spread) * sc)), i: 0 })),
  });
  const sides = [mk(0), mk(23)];
  const outL = new Float32Array(inL.length), outR = new Float32Array(inL.length);
  const n = inL.length;
  for (let s = 0; s < 2; s++) {
    const { combs, aps } = sides[s];
    const out = s ? outR : outL;
    for (let k = 0; k < n; k++) {
      const x = (inL[k] + inR[k]) * 0.015;
      let y = 0;
      for (const c of combs) {
        const o = c.buf[c.i];
        c.store = o * (1 - damp) + c.store * damp;
        c.buf[c.i] = x + c.store * room;
        if (++c.i >= c.buf.length) c.i = 0;
        y += o;
      }
      for (const a of aps) {
        const b = a.buf[a.i];
        a.buf[a.i] = y + b * 0.5;
        if (++a.i >= a.buf.length) a.i = 0;
        y = b - y;
      }
      out[k] = y * wet;
    }
  }
  return [outL, outR];
}

// ---------------------------------------------------------------------------------------------
// Layers. Each adds into (L, R) buffers.
// ---------------------------------------------------------------------------------------------
function layerSpaceWind(L, R, rand, cues) {
  const env = envelope(cues.spaceWind);
  for (let ch = 0; ch < 2; ch++) {
    const out = ch ? R : L;
    const nz = noiseGen(rand);
    const wobble = smoothNoise(rand, 0.35), wobble2 = smoothNoise(rand, 0.9), gust = smoothNoise(rand, 0.25);
    const bp1 = new Biquad(), bp2 = new Biquad(), hp = new Biquad().set('hp', 900, 0.6);
    for (let i = 0; i < out.length; i++) {
      if ((i & 31) === 0) {
        bp1.set('bp', 3400 + 1300 * wobble() + 300 * wobble2(), 2.4);
        bp2.set('bp', 1350 + 380 * wobble2(), 4.5);
      }
      const x = nz();
      const t = i / SR;
      const g = env(t) * (0.75 + 0.25 * gust());
      out[i] += g * (hp.process(bp1.process(x)) * 0.11 + bp2.process(x) * 0.05);
    }
  }
}

function layerWhoosh(L, R, rand, cues) {
  const { start, peak, end } = cues.whoosh;
  const i0 = Math.floor(start * SR), i1 = Math.min(L.length, Math.ceil(end * SR));
  const common = noiseGen(rand);
  const ind = [noiseGen(rand), noiseGen(rand)];
  const flutter = smoothNoise(rand, 7);
  const filt = [[new Biquad(), new Biquad()], [new Biquad(), new Biquad()]];
  const rumble = [new Biquad().set('lp', 110, 0.8), new Biquad().set('lp', 120, 0.8)];
  for (let i = i0; i < i1; i++) {
    const t = i / SR;
    // swell: slow rise (power curve) to the peak, faster fall after it
    const up = smoothstep(start, peak, t), down = 1 - smoothstep(peak, end, t);
    const a = Math.pow(up, 2.2) * down;
    const pan = lerp(-0.45, 0.5, smoothstep(start, end, t)); // drifts across as we fall through
    const [gl, gr] = panGains(pan);
    const fc = 260 + 1500 * Math.pow(up, 1.6) * (0.4 + 0.6 * down);
    if ((i & 15) === 0) for (let c = 0; c < 2; c++) { filt[c][0].set('bp', fc * (c ? 1.07 : 0.94), 0.9); filt[c][1].set('lp', fc * 2.2, 0.7); }
    const cn = common();
    const f = 1 + 0.18 * flutter();
    for (let c = 0; c < 2; c++) {
      const x = 0.6 * cn + 0.8 * ind[c]();
      const band = filt[c][1].process(filt[c][0].process(x));
      const low = rumble[c].process(x);
      const s = a * f * (band * 0.55 + low * 0.9);
      if (c) R[i] += s * gr * 1.2; else L[i] += s * gl * 1.2;
    }
  }
}

function layerBreeze(L, R, rand, cues) {
  const env = envelope(cues.breeze);
  for (let ch = 0; ch < 2; ch++) {
    const out = ch ? R : L;
    const nz = noiseGen(rand), gust = smoothNoise(rand, 0.22), shimmer = smoothNoise(rand, 1.3);
    const lp = new Biquad(), lp2 = new Biquad(), hp = new Biquad().set('hp', 70, 0.7);
    for (let i = 0; i < out.length; i++) {
      const g = gust();
      if ((i & 31) === 0) { lp.set('lp', 380 + 260 * g + 60 * shimmer(), 0.6); lp2.set('lp', 900 + 300 * g, 0.5); }
      const a = env(i / SR) * (0.55 + 0.45 * (0.5 + 0.5 * g));
      out[i] += a * hp.process(lp2.process(lp.process(nz()))) * 0.32;
    }
  }
}

function layerWaves(L, R, rand, cues) {
  const { env: envPts, first, period } = cues.waves;
  const env = envelope(envPts);
  const n = L.length;
  // a soft continuous roar under the individual swells
  for (let ch = 0; ch < 2; ch++) {
    const out = ch ? R : L;
    const nz = noiseGen(rand), sw = smoothNoise(rand, 0.18);
    const lp = new Biquad(), hp = new Biquad().set('hp', 60, 0.7);
    for (let i = 0; i < n; i++) {
      const t = i / SR;
      const far = smoothstep(12, 16, t); // muffled with distance
      if ((i & 31) === 0) lp.set('lp', lerp(520, 300, far) + 80 * sw(), 0.6);
      out[i] += env(t) * (0.6 + 0.4 * sw()) * hp.process(lp.process(nz())) * 0.18;
    }
  }
  // individual swells: band-passed body rising into a wash, then a hiss of foam
  let ts = first;
  while (ts < n / SR) {
    const P = lerp(period[0], period[1], rand());
    const rise = P * lerp(0.42, 0.55, rand());
    const wash = P * lerp(0.75, 1.0, rand());
    const pan = (rand() * 2 - 1) * 0.6;
    const strength = lerp(0.7, 1.0, rand());
    const [gl, gr] = panGains(pan);
    const crash = ts + rise;
    const i0 = Math.floor(ts * SR), i1 = Math.min(n, Math.ceil((crash + wash) * SR));
    const nzC = noiseGen(rand), nzL = noiseGen(rand), nzR = noiseGen(rand), fizz = smoothNoise(rand, 45), fizz2 = smoothNoise(rand, 13);
    const body = [new Biquad(), new Biquad()], foam = [new Biquad(), new Biquad()], foamHp = [new Biquad().set('hp', 2200, 0.6), new Biquad().set('hp', 2400, 0.6)];
    for (let i = Math.max(0, i0); i < i1; i++) {
      const t = i / SR;
      const e = env(t);
      if (e <= 1e-4) continue;
      const far = smoothstep(12, 16, t);
      const up = smoothstep(ts, crash, t);
      const bodyA = t < crash ? Math.pow(up, 1.8) : Math.exp(-(t - crash) / (wash * 0.32));
      const foamA = t < crash ? 0 : (1 - Math.exp(-(t - crash) / 0.06)) * Math.exp(-(t - crash) / (wash * 0.42));
      if ((i & 15) === 0) {
        const fc = lerp(230, 820, up) * (t < crash ? 1 : 1 + 0.5 * Math.exp(-(t - crash) / 0.4));
        for (let c = 0; c < 2; c++) {
          body[c].set('bp', fc * (c ? 1.05 : 0.95) * lerp(1, 0.7, far), 0.8);
          foam[c].set('lp', lerp(7500, 2800, far), 0.6);
        }
      }
      const cn = nzC();
      const sizzle = 0.55 + 0.45 * Math.abs(fizz()) + 0.2 * fizz2();
      for (let c = 0; c < 2; c++) {
        const x = 0.65 * cn + 0.75 * (c ? nzR() : nzL());
        const b = body[c].process(x) * bodyA * 0.75;
        const f = foam[c].process(foamHp[c].process(x)) * foamA * sizzle * lerp(0.45, 0.12, far);
        const s = e * strength * (b + f);
        if (c) R[i] += s * gr; else L[i] += s * gl;
      }
    }
    ts += P * lerp(0.62, 0.85, rand()); // overlapping swells
  }
}

/** One bird call (mono) at sample offset `at` into dryL/R and the reverb send. */
function birdCall(kind, rand, at, pan, gain, dry, send) {
  const [gl, gr] = panGains(pan);
  const add = (startS, durS, f0, f1, opts = {}) => {
    const { vib = 0, vibRate = 0, shape = 0.5, fm = 0, fmRate = 0, harm = 0.12 } = opts;
    const i0 = Math.floor((at + startS) * SR), len = Math.floor(durS * SR);
    let ph = rand() * TAU;
    for (let k = 0; k < len; k++) {
      const s = k / len;
      // glide with a curved shape, light vibrato / FM
      const f = f0 + (f1 - f0) * Math.pow(s, shape) + vib * Math.sin(TAU * vibRate * (k / SR)) + fm * Math.sin(TAU * fmRate * (k / SR));
      ph += (TAU * f) / SR;
      // raised-cosine attack/decay (no clicks), slightly front-loaded
      const a = Math.sin(Math.PI * Math.min(1, s / 0.15) * 0.5) ** 2 * Math.cos(Math.PI * 0.5 * Math.max(0, (s - 0.35) / 0.65)) ** 2;
      const i = i0 + k;
      if (i < 0 || i >= dry[0].length) continue;
      const v = gain * a * (Math.sin(ph) + harm * Math.sin(2 * ph));
      dry[0][i] += v * gl; dry[1][i] += v * gr;
      send[0][i] += v * gl; send[1][i] += v * gr;
    }
  };
  if (kind === 0) {
    // chirp-trill: 3-6 quick falling chirps
    const n = 3 + Math.floor(rand() * 4);
    const top = lerp(3900, 4700, rand());
    let t = 0;
    for (let j = 0; j < n; j++) {
      const d = lerp(0.045, 0.07, rand());
      add(t, d, top * lerp(0.98, 1.03, rand()), top * 0.72, { shape: 0.6, vib: 40, vibRate: 70 });
      t += d + lerp(0.045, 0.085, rand());
    }
  } else if (kind === 1) {
    // sweet two-note whistle "tee-yoo"
    const b = lerp(2300, 2800, rand());
    add(0, lerp(0.2, 0.28, rand()), b * 0.86, b * 1.18, { shape: 1.4, vib: 18, vibRate: 9, harm: 0.05 });
    const g = lerp(0.04, 0.08, rand());
    add(0.24 + g, lerp(0.26, 0.36, rand()), b * 1.08, b * 0.8, { shape: 0.8, vib: 22, vibRate: 7, harm: 0.05 });
  } else {
    // warble: FM trill
    const c = lerp(3200, 3800, rand());
    add(0, lerp(0.35, 0.55, rand()), c, c * lerp(0.9, 1.08, rand()), { fm: lerp(350, 600, rand()), fmRate: lerp(22, 32, rand()), harm: 0.08 });
  }
}

function layerBirds(L, R, rand, cues) {
  const { from, to, thinFrom, gap } = cues.birds;
  const n = L.length;
  const dL = new Float32Array(n), dR = new Float32Array(n), sL = new Float32Array(n), sR = new Float32Array(n);
  // three birds with fixed character and position, plus a far one
  const birds = [
    { kind: 0, pan: -0.55, gain: 0.036 },
    { kind: 1, pan: 0.45, gain: 0.04 },
    { kind: 2, pan: 0.1, gain: 0.022 },
    { kind: 1, pan: -0.8, gain: 0.016 },
  ];
  let t = from;
  while (t < to) {
    const thin = smoothstep(thinFrom, to, t); // dusk: fewer, quieter, further
    const b = birds[Math.floor(rand() * birds.length)];
    if (rand() > thin * 0.85) {
      const g = b.gain * lerp(1, 0.45, thin) * lerp(0.75, 1.1, rand());
      birdCall(b.kind, rand, t, Math.max(-0.9, Math.min(0.9, b.pan + (rand() - 0.5) * 0.25)), g, [dL, dR], [sL, sR]);
      // a natural answer now and then
      if (rand() < 0.3) birdCall(b.kind, rand, t + lerp(0.5, 0.9, rand()), b.pan * 0.9, g * 0.8, [dL, dR], [sL, sR]);
    }
    t += lerp(gap[0], gap[1], rand()) * (1 + 1.5 * thin) + (rand() < 0.15 ? lerp(0.6, 1.4, rand()) : 0);
  }
  // soften (outdoor air absorption) and add a light reverb + a short slap echo for space
  const lpL = new Biquad().set('lp', 7000, 0.7), lpR = new Biquad().set('lp', 7000, 0.7);
  for (let i = 0; i < n; i++) { dL[i] = lpL.process(dL[i]); dR[i] = lpR.process(dR[i]); }
  const [rL, rR] = reverb(sL, sR, { room: 0.8, damp: 0.5 });
  const eL = Math.round(0.19 * SR), eR = Math.round(0.26 * SR);
  for (let i = 0; i < n; i++) {
    L[i] += dL[i] + rL[i] * 0.55 + (i >= eR ? dR[i - eR] * 0.16 : 0);
    R[i] += dR[i] + rR[i] * 0.55 + (i >= eL ? dL[i - eL] * 0.16 : 0);
  }
}

function layerPad(L, R, rand, cues) {
  const env = envelope(cues.pad);
  // D major add9-ish, low and warm: D2 A2 D3 F#3 A3 E4
  const notes = [[73.42, 0.5], [110.0, 0.42], [146.83, 0.3], [185.0, 0.2], [220.0, 0.16], [329.63, 0.06]];
  const voices = [];
  for (const [f, a] of notes) {
    for (let side = 0; side < 2; side++) {
      voices.push({ f: f * (1 + (side ? 0.0018 : -0.0018)), a, side, ph: rand() * TAU, breathe: smoothNoise(rand, 0.12) });
    }
  }
  const n = L.length;
  for (let i = 0; i < n; i++) {
    const t = i / SR;
    const e = env(t);
    let l = 0, r = 0;
    for (const v of voices) {
      v.ph += (TAU * v.f) / SR;
      if (v.ph > TAU) v.ph -= TAU;
      const s = v.a * (0.8 + 0.2 * v.breathe()) * (Math.sin(v.ph) + 0.12 * Math.sin(2 * v.ph) + 0.03 * Math.sin(3 * v.ph));
      if (v.side) r += s; else l += s;
    }
    L[i] += e * l * 0.011;
    R[i] += e * r * 0.011;
  }
}

function layerCrickets(L, R, rand, cues) {
  const env = envelope(cues.crickets);
  const n = L.length;
  // first chirps one second before the envelope starts to rise (they are silent until then)
  const pts = cues.crickets;
  const rising = pts.findIndex(([, v]) => v > 0);
  const startT = rising > 0 ? pts[rising - 1][0] : 0;
  const crickets = [
    { fc: 4400, pan: -0.6, rate: 0.62, pulses: 3, gain: 0.05 },
    { fc: 4850, pan: 0.55, rate: 0.71, pulses: 4, gain: 0.04 },
    { fc: 4150, pan: 0.15, rate: 0.83, pulses: 3, gain: 0.026 },
  ];
  for (const c of crickets) {
    const [gl, gr] = panGains(c.pan);
    let t = Math.max(0, startT - 1 + rand() * c.rate);
    while (t < n / SR) {
      for (let p = 0; p < c.pulses; p++) {
        const p0 = Math.floor((t + p * 0.032) * SR), len = Math.floor(0.02 * SR);
        let ph = rand() * TAU;
        for (let k = 0; k < len && p0 + k < n; k++) {
          ph += (TAU * c.fc * (1 + 0.01 * Math.sin(k * 0.002))) / SR;
          const a = Math.sin((Math.PI * k) / len) ** 2;
          const s = env((p0 + k) / SR) * c.gain * a * Math.sin(ph);
          L[p0 + k] += s * gl; R[p0 + k] += s * gr;
        }
      }
      t += c.rate * lerp(0.9, 1.12, rand());
    }
  }
}

// ---------------------------------------------------------------------------------------------
// Loudness (ITU-R BS.1770-4 integrated, gated) at 48 kHz
// ---------------------------------------------------------------------------------------------
export function integratedLufs(L, R) {
  const kw = () => {
    // K-weighting filter coefficients for 48 kHz from BS.1770
    const s1 = { b: [1.53512485958697, -2.69169618940638, 1.19839281085285], a: [-1.69065929318241, 0.73248077421585] };
    const s2 = { b: [1.0, -2.0, 1.0], a: [-1.99004745483398, 0.99007225036621] };
    const st = [[0, 0], [0, 0]];
    return (x) => {
      let y = s1.b[0] * x + st[0][0];
      st[0][0] = s1.b[1] * x - s1.a[0] * y + st[0][1];
      st[0][1] = s1.b[2] * x - s1.a[1] * y;
      const x2 = y;
      y = s2.b[0] * x2 + st[1][0];
      st[1][0] = s2.b[1] * x2 - s2.a[0] * y + st[1][1];
      st[1][1] = s2.b[2] * x2 - s2.a[1] * y;
      return y;
    };
  };
  const fl = kw(), fr = kw();
  const n = L.length;
  const sq = new Float64Array(n);
  for (let i = 0; i < n; i++) { const a = fl(L[i]), b = fr(R[i]); sq[i] = a * a + b * b; }
  const block = Math.round(0.4 * SR), hop = Math.round(0.1 * SR);
  const cum = new Float64Array(n + 1);
  for (let i = 0; i < n; i++) cum[i + 1] = cum[i] + sq[i];
  const blocks = [];
  for (let s = 0; s + block <= n; s += hop) blocks.push((cum[s + block] - cum[s]) / block);
  const lk = (z) => -0.691 + 10 * Math.log10(z);
  const abs = blocks.filter((z) => lk(z) > -70);
  if (!abs.length) return -Infinity;
  const rel = lk(abs.reduce((a, b) => a + b, 0) / abs.length) - 10;
  const gated = abs.filter((z) => lk(z) > rel);
  return lk(gated.reduce((a, b) => a + b, 0) / gated.length);
}

// ---------------------------------------------------------------------------------------------
// Render + write
// ---------------------------------------------------------------------------------------------
/**
 * @param {{ duration?: number, seed?: number, targetLufs?: number, peakDb?: number, cues?: typeof CUES, solo?: string[] }} opts
 * @returns {{ L: Float32Array, R: Float32Array, stats: { seconds: number, sampleRate: number, lufs: number, peakDb: number, gainDb: number } }}
 */
export function renderAudioBed(opts = {}) {
  const { duration = 20, seed = 7, targetLufs = -19, peakDb = -1.2, cues = CUES } = opts;
  const n = Math.round(duration * SR);
  const L = new Float32Array(n), R = new Float32Array(n);
  const rand = mulberry32(seed);
  // each layer gets its own deterministic stream, so retiming one layer does not reshuffle the others
  const sub = () => mulberry32(Math.floor(rand() * 2 ** 32));
  const layers = { pad: layerPad, spaceWind: layerSpaceWind, whoosh: layerWhoosh, breeze: layerBreeze, waves: layerWaves, birds: layerBirds, crickets: layerCrickets };
  for (const [name, fn] of Object.entries(layers)) {
    const r = sub(); // drawn even when soloing, so a solo sounds exactly like it does in the mix
    if (!opts.solo || opts.solo.includes(name)) fn(L, R, r, cues);
  }

  // master: DC/sub cut, gentle top-end softening (no harshness), master fades
  const hpL = new Biquad().set('hp', 28, 0.7), hpR = new Biquad().set('hp', 28, 0.7);
  const hsL = new Biquad().set('hs', 9000, 0.7, -3), hsR = new Biquad().set('hs', 9000, 0.7, -3);
  const { fadeIn, fadeOut } = cues.master;
  for (let i = 0; i < n; i++) {
    const t = i / SR;
    const f = smoothstep(0, fadeIn, t) * (1 - smoothstep(duration - fadeOut, duration, t));
    L[i] = hsL.process(hpL.process(L[i])) * f;
    R[i] = hsR.process(hpR.process(R[i])) * f;
  }

  // loudness normalise, then make sure the peak stays under the ceiling
  const lufs0 = integratedLufs(L, R);
  let gain = dbToGain(targetLufs - lufs0);
  let peak = 0;
  for (let i = 0; i < n; i++) peak = Math.max(peak, Math.abs(L[i]), Math.abs(R[i]));
  const ceiling = dbToGain(peakDb);
  if (peak * gain > ceiling) gain = ceiling / peak;
  for (let i = 0; i < n; i++) { L[i] *= gain; R[i] *= gain; }
  const peakOut = peak * gain;
  return { L, R, stats: { seconds: duration, sampleRate: SR, lufs: integratedLufs(L, R), peakDb: 20 * Math.log10(peakOut), gainDb: 20 * Math.log10(gain) } };
}

/** 24-bit PCM stereo WAV (little endian), hand-written header. */
export function encodeWav24(L, R) {
  const n = L.length;
  const dataBytes = n * 2 * 3;
  const buf = Buffer.alloc(44 + dataBytes);
  buf.write('RIFF', 0); buf.writeUInt32LE(36 + dataBytes, 4); buf.write('WAVE', 8);
  buf.write('fmt ', 12); buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20); buf.writeUInt16LE(2, 22);
  buf.writeUInt32LE(SR, 24); buf.writeUInt32LE(SR * 2 * 3, 28); buf.writeUInt16LE(2 * 3, 32); buf.writeUInt16LE(24, 34);
  buf.write('data', 36); buf.writeUInt32LE(dataBytes, 40);
  let o = 44;
  for (let i = 0; i < n; i++) {
    for (const ch of [L, R]) {
      const v = Math.max(-8388608, Math.min(8388607, Math.round(ch[i] * 8388607)));
      buf.writeIntLE(v, o, 3);
      o += 3;
    }
  }
  return buf;
}

/** Render and write the bed to `file`. Returns the stats. */
export function writeAudioBed(file, opts = {}) {
  const { L, R, stats } = renderAudioBed(opts);
  fs.writeFileSync(file, encodeWav24(L, R));
  return stats;
}

// CLI
const isMain = (() => {
  try {
    return import.meta.url === new URL(`file:///${process.argv[1].replace(/\\/g, '/')}`).href;
  } catch {
    return false;
  }
})();
if (isMain) {
  const args = process.argv.slice(2);
  const one = (f, d) => { const i = args.indexOf(f); return i >= 0 ? args[i + 1] : d; };
  const out = one('--out', null);
  if (!out) {
    console.error('usage: node tools/audio-bed.mjs --out <file.wav> [--duration 20] [--seed 7]');
    process.exit(2);
  }
  const t0 = performance.now();
  const solo = one('--solo', null)?.split(','); // e.g. --solo waves,birds (debugging; normalisation still applies)
  const stats = writeAudioBed(out, { duration: Number(one('--duration', '20')), seed: Number(one('--seed', '7')), solo });
  console.log(`[audio-bed] ${out}: ${stats.seconds}s ${stats.sampleRate} Hz stereo 24-bit, ${stats.lufs.toFixed(1)} LUFS (internal BS.1770), peak ${stats.peakDb.toFixed(2)} dBFS, gain ${stats.gainDb.toFixed(1)} dB, ${((performance.now() - t0) / 1000).toFixed(2)}s`);
}
