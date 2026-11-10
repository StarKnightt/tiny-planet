import * as THREE from 'three';
import { MAX_GLOWS, planetUniforms } from './lighting';
import { R } from './terrain';

export type Mode = 'play' | 'shot' | 'cinematic';

export interface System {
  /** Called once per frame before rendering. Read ctx.time / ctx.dt / ctx.sunDir. */
  update?(ctx: Ctx): void;
  resize?(w: number, h: number): void;
}

export interface Post {
  /** Render the frame (replaces renderer.render(scene, camera)). */
  render(ctx: Ctx): void;
  /** w,h in CSS pixels; pixelRatio is the renderer's. */
  resize(w: number, h: number, pixelRatio: number): void;
}

export interface Ctx {
  renderer: THREE.WebGLRenderer;
  scene: THREE.Scene;
  camera: THREE.PerspectiveCamera;
  canvas: HTMLCanvasElement;
  /** The one real light: a shadow-casting DirectionalLight that follows ctx.sunDir. White; colour comes from the planet shader. */
  sun: THREE.DirectionalLight;
  /** World time in seconds. Drives ALL animation, so a frame is a pure function of (time, sunDir, camera). */
  time: number;
  /** Seconds since the previous frame (fixed 1/60 during capture). */
  dt: number;
  /** Unit vector toward the sun. Written by the day/night clock or by the cinematic. Treat as read-only. */
  sunDir: THREE.Vector3;
  /**
   * play      = interactive, the player system owns the camera.
   * shot      = a tool drives camera/time through window.__tp (no input, no UI).
   * cinematic = src/cinematic.ts drives camera + sun (no input, no UI).
   */
  mode: Mode;
  /** Same objects as planetUniforms (uTime, uSunDir, glows). */
  uniforms: typeof planetUniforms;
  /** Add a warm night-time light pool on nearby surfaces (max 12). Returns its slot. */
  registerGlow(position: THREE.Vector3, radius: number, color: THREE.ColorRepresentation, intensity?: number): number;
  /** Systems by file name (e.g. ctx.systems.player), filled in as they load. */
  systems: Record<string, System>;
}

/** Direction of the sun for a day-cycle angle (radians). The sun circles the planet's tilted equator. */
export function sunDirFromAngle(angle: number, out = new THREE.Vector3()): THREE.Vector3 {
  return out.set(Math.sin(angle), 0.18 * Math.cos(angle + 0.6), Math.cos(angle)).normalize();
}

export function createContext(canvas: HTMLCanvasElement, mode: Mode): Ctx {
  const renderer = new THREE.WebGLRenderer({
    canvas,
    antialias: true,
    powerPreference: 'high-performance',
    preserveDrawingBuffer: mode !== 'play', // lets tools read the canvas back
  });
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.0;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x05070d);

  const camera = new THREE.PerspectiveCamera(55, 16 / 9, 0.15, 3000);
  camera.position.set(0, 40, 190);
  camera.lookAt(0, 0, 0);

  const sun = new THREE.DirectionalLight(0xffffff, 2.7);
  sun.castShadow = true;
  sun.shadow.mapSize.set(4096, 4096);
  const ext = R + 14;
  const sc = sun.shadow.camera;
  sc.left = -ext;
  sc.right = ext;
  sc.top = ext;
  sc.bottom = -ext;
  sc.near = 10;
  sc.far = 420;
  sun.shadow.bias = -0.0006;
  sun.shadow.normalBias = 0.06;
  sun.shadow.radius = 2.5;
  scene.add(sun);
  scene.add(sun.target);

  let glowCount = 0;
  const ctx: Ctx = {
    renderer,
    scene,
    camera,
    canvas,
    sun,
    time: 0,
    dt: 1 / 60,
    sunDir: planetUniforms.uSunDir.value,
    mode,
    uniforms: planetUniforms,
    systems: {},
    registerGlow(position, radius, color, intensity = 1) {
      if (glowCount >= MAX_GLOWS) {
        console.warn('[tiny-planet] out of glow slots');
        return -1;
      }
      const i = glowCount++;
      planetUniforms.uGlowPos.value[i].set(position.x, position.y, position.z, radius);
      planetUniforms.uGlowCol.value[i].set(color).multiplyScalar(intensity);
      return i;
    },
  };
  return ctx;
}

/** Push ctx.time / ctx.sunDir into the uniforms and the shadow light. Call once per frame before systems update. */
export function syncEnvironment(ctx: Ctx): void {
  ctx.uniforms.uTime.value = ctx.time;
  ctx.sunDir.normalize();
  ctx.sun.position.copy(ctx.sunDir).multiplyScalar(220);
  ctx.sun.target.position.set(0, 0, 0);
  ctx.sun.target.updateMatrixWorld();
}
