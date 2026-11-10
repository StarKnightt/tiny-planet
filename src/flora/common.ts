// Small helpers shared by the flora systems.
import * as THREE from 'three';

/** Stats the flora systems publish for tools (window.__flora). */
export function floraStat(key: string, value: unknown): void {
  const w = window as unknown as { __flora?: Record<string, unknown> };
  (w.__flora ??= {})[key] = value;
}

/** True when running in shot mode with `?only=` that excludes the real terrain (use a stand-in ground). */
export function wantsDebugGround(ctxMode: string): boolean {
  if (ctxMode !== 'shot') return false;
  const only = new URLSearchParams(location.search).get('only');
  return !!only && !only.split(',').includes('terrain');
}

/** Which flora system should add the stand-in ground (only one of them). */
export function onlyHas(name: string): boolean {
  const only = new URLSearchParams(location.search).get('only');
  return !only || only.split(',').includes(name);
}

/** GLSL: sRGB-ish authoring colour -> linear. */
export const SRGB_GLSL = /* glsl */ `
vec3 flLin(vec3 c) { return pow(c, vec3(2.2)); }
`;

export const tmpV = () => new THREE.Vector3();
