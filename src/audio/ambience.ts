// Synthesised ambient soundscape (Web Audio API, no assets). Created on the first user click.
//   wind      : band-passed noise, louder/brighter with altitude and flight speed, slow gusts
//   ocean     : two low-passed noise layers with slow swell envelopes, louder near the coast
//   birds     : little FM chirp phrases by day near trees / grass
//   crickets  : pulsed high sines at night
//   footsteps : short filtered noise bursts (grass / sand / water)
// All parameter changes use setTargetAtTime so nothing clicks.
import { rng } from '../core/noise';

export interface AmbienceState {
  /** 0..1 how close the coast is (1 = standing in / at the water). */
  coast: number;
  /** 0..1 trees / grass around (birds). */
  foliage: number;
  /** 0..1 night. */
  night: number;
  /** metres above ground / sea. */
  altitude: number;
  /** m/s */
  speed: number;
  flying: boolean;
  /** UI paused: duck everything. */
  paused: boolean;
}

const MASTER = 0.42;

export class Ambience {
  readonly ac: AudioContext;
  private master: GainNode;
  private noise: AudioBuffer;
  private windGain: GainNode;
  private windBand: BiquadFilterNode;
  private oceanGain: GainNode;
  private surfGains: GainNode[] = [];
  private natureBus: GainNode;
  private stepBus: GainNode;
  private rand = rng(9071);
  muted = false;
  private t = 0;
  private nextBird = 2;
  private nextCricket = 1;
  private nextSurf: number[] = [0, 3.7];
  private st: AmbienceState = { coast: 0, foliage: 0, night: 0, altitude: 0, speed: 0, flying: false, paused: false };

  constructor() {
    const AC = window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    const ac = (this.ac = new AC({ latencyHint: 'playback' }));
    const comp = ac.createDynamicsCompressor();
    comp.threshold.value = -18;
    comp.ratio.value = 3;
    comp.connect(ac.destination);
    this.master = ac.createGain();
    this.master.gain.value = 0;
    this.master.connect(comp);
    this.master.gain.setTargetAtTime(MASTER, ac.currentTime + 0.05, 1.2); // gentle fade-in

    // 4 s of pink-ish noise (deterministic seed; looped).
    const len = ac.sampleRate * 4;
    this.noise = ac.createBuffer(1, len, ac.sampleRate);
    const d = this.noise.getChannelData(0);
    let b0 = 0, b1 = 0, b2 = 0;
    for (let i = 0; i < len; i++) {
      const w = this.rand() * 2 - 1;
      b0 = 0.997 * b0 + w * 0.029591;
      b1 = 0.985 * b1 + w * 0.032534;
      b2 = 0.95 * b2 + w * 0.048056;
      d[i] = (b0 + b1 + b2 + w * 0.05) * 2.2;
    }
    // crossfade the loop seam
    const fade = 2048;
    for (let i = 0; i < fade; i++) {
      const a = i / fade;
      d[len - fade + i] = d[len - fade + i] * (1 - a) + d[i] * a;
    }

    // ---- wind ----
    const wind = this.loop(0);
    this.windBand = ac.createBiquadFilter();
    this.windBand.type = 'bandpass';
    this.windBand.frequency.value = 420;
    this.windBand.Q.value = 0.8;
    const windGust = ac.createGain();
    windGust.gain.value = 0.75;
    const gustLfo = ac.createOscillator();
    gustLfo.frequency.value = 0.11;
    const gustDepth = ac.createGain();
    gustDepth.gain.value = 0.25;
    gustLfo.connect(gustDepth).connect(windGust.gain);
    gustLfo.start();
    const whistleLfo = ac.createOscillator();
    whistleLfo.frequency.value = 0.07;
    const whistleDepth = ac.createGain();
    whistleDepth.gain.value = 90;
    whistleLfo.connect(whistleDepth).connect(this.windBand.frequency);
    whistleLfo.start();
    this.windGain = ac.createGain();
    this.windGain.gain.value = 0.0;
    wind.connect(this.windBand).connect(windGust).connect(this.windGain).connect(this.master);

    // ---- ocean: a constant low wash + swells scheduled as envelopes ----
    this.oceanGain = ac.createGain();
    this.oceanGain.gain.value = 0;
    this.oceanGain.connect(this.master);
    const washLp = ac.createBiquadFilter();
    washLp.type = 'lowpass';
    washLp.frequency.value = 380;
    const washG = ac.createGain();
    washG.gain.value = 0.35;
    this.loop(1.3).connect(washLp).connect(washG).connect(this.oceanGain);
    for (let i = 0; i < 2; i++) {
      const lp = ac.createBiquadFilter();
      lp.type = 'lowpass';
      lp.frequency.value = 700 + i * 300;
      lp.Q.value = 0.3;
      const g = ac.createGain();
      g.gain.value = 0.05;
      this.loop(2.1 + i * 0.9).connect(lp).connect(g).connect(this.oceanGain);
      this.surfGains.push(g);
    }

    this.natureBus = ac.createGain();
    this.natureBus.gain.value = 0.5;
    this.natureBus.connect(this.master);
    this.stepBus = ac.createGain();
    this.stepBus.gain.value = 0.55;
    this.stepBus.connect(this.master);
  }

  private loop(offset: number) {
    const s = this.ac.createBufferSource();
    s.buffer = this.noise;
    s.loop = true;
    s.start(0, offset % 4);
    return s;
  }

  resume() {
    if (this.ac.state === 'suspended') void this.ac.resume();
  }

  setMuted(m: boolean) {
    this.muted = m;
    this.applyMaster();
  }

  private applyMaster() {
    const target = this.muted ? 0 : this.st.paused ? MASTER * 0.3 : MASTER;
    this.master.gain.setTargetAtTime(target, this.ac.currentTime, 0.25);
  }

  /** Call every frame with the play dt. Cheap: only a few param ramps per frame. */
  update(dt: number, s: AmbienceState) {
    const pausedChanged = s.paused !== this.st.paused;
    this.st = s;
    if (pausedChanged) this.applyMaster();
    this.t += dt;
    const now = this.ac.currentTime;
    if (this.ac.state !== 'running') return;

    // wind
    const alt = Math.min(1, s.altitude / 120);
    const fly = s.flying ? Math.min(1, s.speed / 60) : 0;
    const windVol = 0.05 + 0.1 * Math.min(1, s.altitude / 25) + 0.28 * alt + 0.35 * fly + (s.flying ? 0.04 : 0);
    this.windGain.gain.setTargetAtTime(windVol, now, 0.4);
    this.windBand.frequency.setTargetAtTime(380 + 900 * alt + 1100 * fly, now, 0.5);

    // ocean (fades away with altitude)
    const oceanVol = s.coast * s.coast * 0.85 * (1 - Math.min(1, s.altitude / 60)) + 0.02;
    this.oceanGain.gain.setTargetAtTime(oceanVol, now, 0.8);
    for (let i = 0; i < this.surfGains.length; i++) {
      if (this.t >= this.nextSurf[i]) {
        // one swell: rise 2-3 s, wash out 3-4 s
        const rise = 1.8 + this.rand() * 1.2;
        const fall = 2.6 + this.rand() * 1.6;
        const peak = 0.5 + this.rand() * 0.5;
        const g = this.surfGains[i].gain;
        g.cancelScheduledValues(now);
        g.setTargetAtTime(peak, now, rise / 3);
        g.setTargetAtTime(0.05, now + rise, fall / 3);
        this.nextSurf[i] = this.t + rise + fall * 0.8 + this.rand() * 2;
      }
    }

    // birds by day, crickets by night (not from the sky, not underwater)
    const ground = Math.max(0, 1 - s.altitude / 30);
    const day = 1 - s.night;
    if (this.t >= this.nextBird) {
      const p = day * day * (0.25 + 0.75 * s.foliage) * ground;
      if (p > 0.08 && this.rand() < p) this.birdPhrase(now, 0.3 + 0.7 * p);
      this.nextBird = this.t + 1.2 + this.rand() * 3.5;
    }
    if (this.t >= this.nextCricket) {
      const p = s.night * (0.3 + 0.7 * Math.max(s.foliage, 1 - s.coast)) * ground;
      if (p > 0.1) this.cricket(now, p);
      this.nextCricket = this.t + 0.35 + this.rand() * 0.9;
    }
  }

  private birdPhrase(at: number, vol: number) {
    const ac = this.ac;
    const base = 2600 + this.rand() * 1800;
    const notes = 2 + Math.floor(this.rand() * 4);
    const pan = ac.createStereoPanner();
    pan.pan.value = this.rand() * 1.6 - 0.8;
    pan.connect(this.natureBus);
    let t = at + 0.02;
    for (let i = 0; i < notes; i++) {
      const o = ac.createOscillator();
      const g = ac.createGain();
      const f0 = base * (0.85 + this.rand() * 0.35);
      const dur = 0.06 + this.rand() * 0.1;
      o.type = 'sine';
      o.frequency.setValueAtTime(f0, t);
      o.frequency.exponentialRampToValueAtTime(f0 * (this.rand() < 0.5 ? 1.35 : 0.72), t + dur);
      // a little vibrato via FM
      const lfo = ac.createOscillator();
      const lg = ac.createGain();
      lfo.frequency.value = 28 + this.rand() * 20;
      lg.gain.value = f0 * 0.04;
      lfo.connect(lg).connect(o.frequency);
      g.gain.setValueAtTime(0, t);
      g.gain.linearRampToValueAtTime(0.09 * vol, t + 0.012);
      g.gain.setTargetAtTime(0, t + dur * 0.6, dur * 0.25);
      o.connect(g).connect(pan);
      o.start(t);
      lfo.start(t);
      o.stop(t + dur + 0.15);
      lfo.stop(t + dur + 0.15);
      t += dur + 0.03 + this.rand() * 0.08;
    }
  }

  private cricket(at: number, vol: number) {
    const ac = this.ac;
    const o = ac.createOscillator();
    const g = ac.createGain();
    const pan = ac.createStereoPanner();
    pan.pan.value = this.rand() * 1.8 - 0.9;
    o.type = 'sine';
    o.frequency.value = 4300 + this.rand() * 900;
    g.gain.value = 0;
    const pulses = 2 + Math.floor(this.rand() * 3);
    const amp = 0.02 * vol * (0.5 + this.rand() * 0.5);
    for (let i = 0; i < pulses; i++) {
      const t = at + i * 0.045;
      g.gain.setValueAtTime(0, t);
      g.gain.linearRampToValueAtTime(amp, t + 0.008);
      g.gain.linearRampToValueAtTime(0, t + 0.03);
    }
    o.connect(g).connect(pan).connect(this.natureBus);
    o.start(at);
    o.stop(at + pulses * 0.045 + 0.05);
  }

  footstep(surface: 'grass' | 'sand' | 'water' | 'rock', intensity: number) {
    if (this.ac.state !== 'running' || this.muted) return;
    const ac = this.ac;
    const now = ac.currentTime + 0.005;
    const src = ac.createBufferSource();
    src.buffer = this.noise;
    const f = ac.createBiquadFilter();
    const g = ac.createGain();
    let dur = 0.09;
    let vol = 0.32;
    if (surface === 'grass') {
      f.type = 'bandpass';
      f.frequency.value = 1500 + this.rand() * 700;
      f.Q.value = 0.9;
      dur = 0.1;
    } else if (surface === 'sand') {
      f.type = 'lowpass';
      f.frequency.value = 900 + this.rand() * 300;
      dur = 0.13;
      vol = 0.42;
    } else if (surface === 'water') {
      f.type = 'bandpass';
      f.frequency.value = 600 + this.rand() * 500;
      f.Q.value = 0.6;
      dur = 0.26;
      vol = 0.5;
    } else {
      f.type = 'bandpass';
      f.frequency.value = 2400;
      f.Q.value = 1.5;
      dur = 0.06;
    }
    vol *= Math.min(1.3, 0.5 + intensity * 0.5);
    g.gain.setValueAtTime(0, now);
    g.gain.linearRampToValueAtTime(vol, now + 0.012);
    g.gain.setTargetAtTime(0, now + 0.02, dur / 3);
    src.connect(f).connect(g).connect(this.stepBus);
    src.start(now, this.rand() * 3.5);
    src.stop(now + dur * 2 + 0.05);
  }

  dispose() {
    void this.ac.close();
  }
}
