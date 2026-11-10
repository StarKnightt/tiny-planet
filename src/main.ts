import * as THREE from 'three';
import { createContext, sunDirFromAngle, syncEnvironment, type Ctx, type Mode, type Post, type System } from './core/context';
import { heightAt, R, tangentFrame } from './core/terrain';

// ---------------------------------------------------------------------------------------------
// URL parameters
//   (none)          play the game
//   ?cinematic=1    watch the fly-in in real time
//   ?shot=1         tool mode: nothing runs until window.__tp is told to render (see tools/shot.mjs)
//   ?only=a,b       load only these systems (file names in src/systems, without .ts)
//   ?nopost=1       skip post-processing
//   ?debug=1        log the GPU adapter
// ---------------------------------------------------------------------------------------------
const params = new URLSearchParams(location.search);
const mode: Mode = params.has('shot') ? 'shot' : params.has('cinematic') ? 'cinematic' : 'play';
const only = params.get('only')?.split(',').filter(Boolean);

/** Length of a full day in seconds of play. */
const DAY_LENGTH = 300;
/** Sun angle at time 0: late golden afternoon over the village. */
const SUN_START = 0.95;

const errors: string[] = [];
const fail = (msg: string) => {
  errors.push(msg);
  console.error('[tiny-planet]', msg);
};
window.addEventListener('error', (e) => fail(`error: ${e.message}`));
window.addEventListener('unhandledrejection', (e) => fail(`rejection: ${e.reason?.stack ?? e.reason}`));

// The page credit is for players only; keep it out of tool screenshots and the cinematic.
if (mode !== 'play') document.getElementById('credit')?.remove();

const canvas = document.getElementById('game') as HTMLCanvasElement;
const ctx = createContext(canvas, mode);
ctx.renderer.debug.onShaderError = (gl, program, vs, fs) => {
  const log = (s: WebGLShader) => gl.getShaderInfoLog(s) || '';
  fail(`shader error: ${gl.getProgramInfoLog(program)}\nVS: ${log(vs)}\nFS: ${log(fs)}`);
};

const systems: { name: string; order: number; sys: System }[] = [];
let post: Post | null = null;
let cinematic: { DURATION: number; applyCinematic(t: number, ctx: Ctx): void } | null = null;

function resize() {
  const w = window.innerWidth;
  const h = window.innerHeight;
  const pr = mode === 'play' ? Math.min(window.devicePixelRatio, 2) : 1;
  ctx.renderer.setPixelRatio(pr);
  ctx.renderer.setSize(w, h, false);
  ctx.camera.aspect = w / h;
  ctx.camera.updateProjectionMatrix();
  post?.resize(w, h, pr);
  for (const s of systems) s.sys.resize?.(w, h);
}

function frame(dt: number) {
  ctx.dt = dt;
  syncEnvironment(ctx);
  for (const s of systems) s.sys.update?.(ctx);
  if (post) post.render(ctx);
  else ctx.renderer.render(ctx.scene, ctx.camera);
}

async function boot() {
  // Systems: every file in src/systems default-exports `(ctx) => System | Promise<System>`,
  // optionally with `export const order = n` (lower updates first; default 0).
  const mods = import.meta.glob('./systems/*.ts');
  const loaded = await Promise.all(
    Object.entries(mods)
      .map(([path, load]) => ({ name: path.slice('./systems/'.length, -3), load }))
      .filter((m) => !only || only.includes(m.name))
      .map(async (m) => {
        try {
          const mod = (await m.load()) as { default: (ctx: Ctx) => System | Promise<System>; order?: number };
          const sys = (await mod.default(ctx)) ?? {};
          ctx.systems[m.name] = sys;
          return { name: m.name, order: mod.order ?? 0, sys };
        } catch (e) {
          fail(`system "${m.name}" failed to load: ${(e as Error)?.stack ?? e}`);
          return null;
        }
      }),
  );
  for (const l of loaded) if (l) systems.push(l);
  systems.sort((a, b) => a.order - b.order);

  if (!params.has('nopost')) {
    const postMods = import.meta.glob('./render/post.ts');
    const load = postMods['./render/post.ts'];
    if (load) {
      try {
        post = ((await load()) as { createPost(ctx: Ctx): Post }).createPost(ctx);
      } catch (e) {
        fail(`post failed to load: ${(e as Error)?.stack ?? e}`);
      }
    }
  }
  const cineMods = import.meta.glob('./cinematic.ts');
  if (cineMods['./cinematic.ts']) {
    try {
      cinematic = (await cineMods['./cinematic.ts']()) as typeof cinematic;
    } catch (e) {
      fail(`cinematic failed to load: ${(e as Error)?.stack ?? e}`);
    }
  }

  resize();
  window.addEventListener('resize', resize);

  if (params.has('debug')) {
    const gl = ctx.renderer.getContext();
    const dbg = gl.getExtension('WEBGL_debug_renderer_info');
    console.log('[gpu]', dbg ? gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : 'unknown');
  }

  sunDirFromAngle(SUN_START, ctx.sunDir);

  if (mode === 'shot') return; // tools drive everything through __tp

  const clock = new THREE.Clock();
  ctx.renderer.setAnimationLoop(() => {
    const dt = Math.min(clock.getDelta(), 0.05);
    ctx.time += dt;
    if (mode === 'cinematic' && cinematic) cinematic.applyCinematic(ctx.time % cinematic.DURATION, ctx);
    else sunDirFromAngle(SUN_START + (ctx.time / DAY_LENGTH) * Math.PI * 2, ctx.sunDir);
    frame(dt);
  });
}

// ---------------------------------------------------------------------------------------------
// Tool API (screenshots + video capture). Everything is deterministic: a frame depends only on
// (time, sunDir, camera).
// ---------------------------------------------------------------------------------------------
const _e = new THREE.Vector3();
const _n = new THREE.Vector3();
const tp = {
  ctx,
  errors,
  ready: null as unknown as Promise<void>,
  get duration() {
    return cinematic?.DURATION ?? 0;
  },
  setTime(t: number) {
    ctx.time = t;
  },
  setSunAngle(a: number) {
    sunDirFromAngle(a, ctx.sunDir);
  },
  setSunDir(x: number, y: number, z: number) {
    ctx.sunDir.set(x, y, z).normalize();
  },
  /** Free camera: world position and look-at target. Up is the local "away from the planet". */
  setCamera(px: number, py: number, pz: number, tx: number, ty: number, tz: number, fov = 55) {
    const cam = ctx.camera;
    cam.position.set(px, py, pz);
    cam.up.copy(cam.position).normalize();
    const view = new THREE.Vector3(tx - px, ty - py, tz - pz).normalize();
    if (Math.abs(view.dot(cam.up)) > 0.995) cam.up.set(0, 1, 0);
    cam.lookAt(tx, ty, tz);
    cam.fov = fov;
    cam.updateProjectionMatrix();
  },
  /**
   * Stand on the planet: unit-ish direction (dx,dy,dz), eye `height` above the terrain (or the sea),
   * heading `yawDeg` clockwise from north, `pitchDeg` up (+) / down (-).
   */
  setGroundView(dx: number, dy: number, dz: number, height = 1.7, yawDeg = 0, pitchDeg = 0, fov = 55) {
    const dir = new THREE.Vector3(dx, dy, dz).normalize();
    const cam = ctx.camera;
    cam.position.copy(dir).multiplyScalar(R + Math.max(heightAt(dir), 0) + height);
    tangentFrame(dir, _e, _n);
    const yaw = THREE.MathUtils.degToRad(yawDeg);
    const pitch = THREE.MathUtils.degToRad(pitchDeg);
    const fwd = _n.multiplyScalar(Math.cos(yaw)).addScaledVector(_e, Math.sin(yaw));
    const look = fwd.multiplyScalar(Math.cos(pitch)).addScaledVector(dir, Math.sin(pitch));
    cam.up.copy(dir);
    cam.lookAt(cam.position.clone().add(look));
    cam.fov = fov;
    cam.updateProjectionMatrix();
  },
  /** Render one frame with the current camera/time/sun. */
  render(dt = 1 / 60) {
    frame(dt);
  },
  /** Render cinematic frame at time t (seconds). Returns false if there is no cinematic. */
  cinematicFrame(t: number, dt = 1 / 60) {
    if (!cinematic) return false;
    ctx.time = t;
    cinematic.applyCinematic(t, ctx);
    frame(dt);
    return true;
  },
  info() {
    const i = ctx.renderer.info;
    return { calls: i.render.calls, triangles: i.render.triangles, programs: i.programs?.length ?? 0, geometries: i.memory.geometries, textures: i.memory.textures };
  },
};
tp.ready = boot();
(window as unknown as { __tp: typeof tp }).__tp = tp;
export type ToolApi = typeof tp;
