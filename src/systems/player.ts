// The player: first-person walking / swimming / flying on the round planet, the title + pause
// screens, the HUD and the ambient soundscape. Only does anything in ctx.mode === 'play'.
//
// Public (ctx.systems.player): position (feet, world), flying, altitude (feet above ground/sea).
//
// Test hooks: ?autoplay=1 skips the title card and plays without pointer lock (drag to look);
// `ctx.systems.player.debug` drives the controller with fixed steps (see tools/player-test.mjs).
import * as THREE from 'three';
import type { Ctx, System } from '../core/context';
import { nightAt, sunHeightAt } from '../core/lighting';
import { biomeAt, heightAtXYZ } from '../core/terrain';
import { Controller, type MoveInput } from '../player/controller';
import { ColliderSet } from '../player/colliders';
import { Input } from '../player/input';
import { applyPose, blendPose, makePose, orbitPose } from '../player/orbit';
import { Hud } from '../ui/hud';
import { Ambience } from '../audio/ambience';

export const order = -10;

const BLEND_TIME = 2.2;
/** Title framing: planet slides right on wide screens, up on narrow ones (room for the title card). */
const SHIFT = 0.42;
const SHIFT_Y = 0.42;

export interface PlayerSystem extends System {
  position: THREE.Vector3;
  flying: boolean;
  altitude: number;
  debug?: PlayerDebug;
}

export interface PlayerDebug {
  /** When true, the frame loop stops stepping the controller (tests step it themselves). */
  freeze: boolean;
  start(): void;
  step(dt: number, n: number, input?: Partial<MoveInput>, lookPerStep?: [number, number]): ReturnType<PlayerDebug['state']>;
  look(dx: number, dy: number): void;
  setFlying(on: boolean): void;
  /** Turn to face a world point / direction (projected onto the local tangent plane). */
  face(x: number, y: number, z: number): void;
  teleport(x: number, y: number, z: number): void;
  /** All known colliders as [x, y, z, radius]. */
  colliderList(): number[][];
  /** AudioContext state ('none' before the first click). */
  audio(): string;
  state(): {
    pos: number[]; up: number[]; fwd: number[]; eye: number[]; camUp: number[]; camFwd: number[];
    pitch: number; flying: boolean; grounded: boolean; swimming: boolean; altitude: number; speed: number;
    terrain: number; colliders: number; screen: string;
  };
}

export default function createPlayer(ctx: Ctx): PlayerSystem {
  const ctl = new Controller();
  const sys: PlayerSystem = { position: ctl.pos, flying: false, altitude: 0 };
  if (ctx.mode !== 'play') return sys; // inert in shot / cinematic: no DOM, no listeners, no audio, no camera

  const params = new URLSearchParams(location.search);
  const autoplay = params.has('autoplay');
  const cam = ctx.camera;
  const colliders = new ColliderSet(import.meta.glob(['./village.ts', './forest.ts']));
  ctl.colliders = colliders.near;

  type Screen = 'title' | 'blend' | 'play' | 'pause';
  let screen: Screen = 'title';
  let blendT = 0;
  let audio: Ambience | null = null;
  let muted = false;
  let clock = 0;
  let wide = true;
  let lockRefused = false;
  const orbitFrom = makePose();
  const eyePose = makePose();
  const move: MoveInput = { x: 0, y: 0, z: 0, run: false, jump: false };
  const idle: MoveInput = { x: 0, y: 0, z: 0, run: false, jump: false };

  const host = document.getElementById('ui') ?? document.body;
  const hud = new Hud(host, () => start());
  const input = new Input(ctx.canvas, {
    onFly() {
      ctl.setFlying(!ctl.flying);
    },
    onMute() {
      muted = !muted;
      audio?.setMuted(muted);
      hud.mutedToast(muted);
    },
    onLockChange(locked) {
      if (locked) {
        lockRefused = false;
        input.dragLook = false;
        if (screen === 'pause') setScreen('play');
      } else if ((screen === 'play' || screen === 'blend') && !input.dragLook) {
        setScreen('pause');
      }
    },
    onLockError() {
      if (screen === 'pause') {
        // Chrome refuses a re-lock for ~1 s after Esc.
        hud.pauseMessage('One moment, then click again');
        return;
      }
      // Lock not available at all: play with drag-to-look instead.
      lockRefused = true;
      input.dragLook = true;
      hud.toast('Drag with the mouse to look around', 3.5);
    },
  });
  // Silence the soundscape while the tab is hidden (the frame loop stops, so it would just drone on).
  document.addEventListener('visibilitychange', () => {
    if (!audio) return;
    if (document.hidden) void audio.ac.suspend();
    else audio.resume();
  });
  window.addEventListener('keydown', (e) => {
    if (e.code === 'Escape' && input.dragLook && (screen === 'play' || screen === 'blend')) setScreen('pause');
  });

  function setScreen(s: Screen) {
    screen = s;
    input.enabled = s === 'play' || s === 'blend';
    if (s !== 'play' && s !== 'blend') input.release();
    hud.setScreen(s);
    if (s === 'pause') hud.pauseMessage(muted ? 'Sound is off  ·  press M to turn it on' : '');
  }

  function startAudio() {
    if (audio) return audio.resume();
    // Created inside the click gesture so the browser lets it start.
    try {
      audio = new Ambience();
      audio.setMuted(muted);
      audio.resume();
    } catch (e) {
      console.warn('[player] audio unavailable', e);
    }
  }

  function start() {
    if (screen === 'title') {
      orbitFrom.pos.copy(cam.position); // the title camera exactly as it was on screen
      orbitPose(ctx.time, wide ? SHIFT : 0, orbitFrom, wide ? 0 : SHIFT_Y);
      orbitFrom.pos.setLength(cam.position.length());
      blendT = 0;
      setScreen('blend');
    } else if (screen === 'pause') {
      hud.pauseMessage('');
      if (input.dragLook) setScreen('play');
    }
    startAudio();
    if (!lockRefused) input.requestLock();
  }

  // ---- environment sampling (a few times a second, not every frame) ----
  let envT = 0;
  let coast = 0;
  let foliage = 0;
  const env = new THREE.Vector3();
  const prevSun = ctx.sunDir.clone();
  let rising = false;
  function sampleEnv() {
    const p = ctl.pos;
    const u = ctl.up;
    // Distance to water: rings of samples around the player.
    let d = Infinity;
    if (heightAtXYZ(u.x, u.y, u.z) < 0.15) d = 0;
    else {
      const e = env.set(-u.y, u.x, 0);
      if (e.lengthSq() < 1e-4) e.set(1, 0, 0);
      e.normalize();
      const n = new THREE.Vector3().crossVectors(u, e);
      outer: for (const r of [4, 9, 16, 26, 38]) {
        for (let i = 0; i < 12; i++) {
          const a = (i / 12) * Math.PI * 2 + r;
          const x = p.x + (e.x * Math.cos(a) + n.x * Math.sin(a)) * r;
          const y = p.y + (e.y * Math.cos(a) + n.y * Math.sin(a)) * r;
          const z = p.z + (e.z * Math.cos(a) + n.z * Math.sin(a)) * r;
          const l = Math.hypot(x, y, z);
          if (heightAtXYZ(x / l, y / l, z / l) < 0) {
            d = r;
            break outer;
          }
        }
      }
    }
    coast = d === Infinity ? 0 : 1 - THREE.MathUtils.smoothstep(d, 0, 40);
    const b = biomeAt(u);
    foliage = Math.min(1, b.forest + 0.45 * b.grass);
  }

  // ---- debug / test hooks ----
  const v3 = (v: THREE.Vector3) => [v.x, v.y, v.z];
  const _cu = new THREE.Vector3();
  const _cf = new THREE.Vector3();
  const debug: PlayerDebug = {
    freeze: false,
    start() {
      orbitPose(ctx.time, 0, orbitFrom);
      lockRefused = true;
      input.dragLook = true;
      setScreen('play');
    },
    step(dt, n, inp = {}, lookPerStep) {
      const m: MoveInput = { x: 0, y: 0, z: 0, run: false, jump: false, ...inp };
      for (let i = 0; i < n; i++) {
        if (lookPerStep) ctl.look(lookPerStep[0], lookPerStep[1]);
        ctl.step(dt, m);
        m.jump = false;
        colliders.update(ctx, (clock += dt), ctl.pos);
      }
      sys.flying = ctl.flying;
      sys.altitude = Math.max(0, ctl.altitude);
      cam.position.copy(ctl.eye);
      cam.quaternion.copy(ctl.quat);
      return debug.state();
    },
    look(dx, dy) {
      ctl.look(dx, dy);
    },
    colliderList() {
      return colliders.list.map((c) => [c.p.x, c.p.y, c.p.z, c.r]);
    },
    audio() {
      return audio ? audio.ac.state : 'none';
    },
    setFlying(on) {
      ctl.setFlying(on);
    },
    face(x, y, z) {
      const t = new THREE.Vector3(x, y, z).sub(ctl.pos);
      t.addScaledVector(ctl.up, -t.dot(ctl.up));
      if (t.lengthSq() > 1e-8) ctl.fwd.copy(t.normalize());
      ctl.look(0, 0);
    },
    teleport(x, y, z) {
      const d = new THREE.Vector3(x, y, z).normalize();
      ctl.reset();
      ctl.pos.copy(d).multiplyScalar(ctl.floorRadius(d.x, d.y, d.z));
      ctl.up.copy(d);
      ctl.fwd.addScaledVector(d, -ctl.fwd.dot(d)).normalize();
    },
    state() {
      _cu.set(0, 1, 0).applyQuaternion(ctl.quat);
      _cf.set(0, 0, -1).applyQuaternion(ctl.quat);
      const u = ctl.up;
      return {
        pos: v3(ctl.pos), up: v3(ctl.up), fwd: v3(ctl.fwd), eye: v3(ctl.eye), camUp: v3(_cu), camFwd: v3(_cf),
        pitch: ctl.pitch, flying: ctl.flying, grounded: ctl.grounded, swimming: ctl.swimming,
        altitude: ctl.altitude, speed: ctl.speed, terrain: heightAtXYZ(u.x, u.y, u.z), colliders: colliders.count, screen,
      };
    },
  };
  sys.debug = debug;

  if (autoplay) debug.start();

  sys.resize = (w, h) => {
    wide = w > 760 && w / h > 1;
  };
  sys.resize(window.innerWidth, window.innerHeight);

  let lastMode = '';
  sys.update = (c) => {
    const dt = Math.min(Math.max(c.dt, 0), 0.05);
    clock += dt;
    hud.tick(dt);

    if (screen === 'title') {
      // Slow orbit, a pure function of time.
      orbitPose(c.time, wide ? SHIFT : 0, eyePose, wide ? 0 : SHIFT_Y);
      // Narrow / portrait windows: back off so the whole planet fits across.
      const aspect = cam.aspect;
      if (aspect < 1.25) eyePose.pos.multiplyScalar(Math.pow(1.25 / aspect, 0.9));
      applyPose(eyePose, cam);
      cam.updateProjectionMatrix();
      return;
    }

    const [lx, ly] = input.takeLook();
    if (!debug.freeze && screen !== 'pause') {
      if (screen === 'play' || screen === 'blend') ctl.look(lx, ly);
      ctl.step(dt, screen === 'play' || (screen === 'blend' && blendT > BLEND_TIME * 0.8) ? input.read(move) : idle);
      colliders.update(c, clock, ctl.pos);
    }
    sys.flying = ctl.flying;
    sys.altitude = Math.max(0, ctl.altitude);

    if (screen === 'blend') {
      blendT += dt;
      const u = Math.min(1, blendT / BLEND_TIME);
      eyePose.pos.copy(ctl.eye);
      ctl.viewDir(eyePose.target).multiplyScalar(10).add(ctl.eye);
      eyePose.up.copy(ctl.up);
      eyePose.fov = ctl.fov;
      blendPose(orbitFrom, eyePose, ctl.fwd, u, cam);
      if (u >= 1) setScreen('play');
    } else {
      cam.position.copy(ctl.eye);
      cam.quaternion.copy(ctl.quat);
      cam.fov = ctl.fov;
    }
    cam.updateProjectionMatrix();

    // HUD
    const modeName = ctl.flying ? 'Flying' : ctl.swimming ? 'Swimming' : 'Walking';
    if (modeName !== lastMode) {
      lastMode = modeName;
      hud.setMode(modeName);
    }
    hud.setAltitude(ctl.flying ? Math.max(0, ctl.altitude) : null);
    const sh = sunHeightAt(ctl.pos, c.sunDir);
    const dSun = ctl.up.dot(c.sunDir) - ctl.up.dot(prevSun);
    if (Math.abs(dSun) > 1e-7) rising = dSun > 0;
    prevSun.copy(c.sunDir);
    hud.setSun(sh, rising);

    // Audio
    envT -= dt;
    if (envT <= 0) {
      envT = 0.4;
      sampleEnv();
    }
    const steps = ctl.takeSteps();
    if (audio) {
      audio.update(dt, {
        coast,
        foliage,
        night: nightAt(ctl.pos, c.sunDir),
        altitude: Math.max(0, ctl.altitude),
        speed: ctl.speed,
        flying: ctl.flying,
        paused: screen === 'pause',
      });
      if (steps.n) audio.footstep(steps.surface, ctl.speed / 4.2);
    }
  };

  return sys;
}
