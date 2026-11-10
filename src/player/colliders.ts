// Defensive collider gathering from other systems (village buildings, forest trees).
// Neither module is required: if they are absent, or export something unexpected, we just get
// fewer colliders. Accepted shapes per entry:
//   THREE.Vector3 (world pos, or a unit direction -> placed on the surface)
//   { position | pos | center | p | dir: Vector3, radius? | r?, height? | h? }
//   { x, y, z, radius? | r? }
import * as THREE from 'three';
import type { Ctx } from '../core/context';
import { surfacePoint } from '../core/terrain';
import type { Circle } from './controller';

type Loader = () => Promise<unknown>;
type AnyRec = Record<string, unknown>;

const isVec = (v: unknown): v is THREE.Vector3 =>
  !!v && typeof v === 'object' && typeof (v as AnyRec).x === 'number' && typeof (v as AnyRec).y === 'number' && typeof (v as AnyRec).z === 'number';

function toCircle(e: unknown, defR: number, defH: number): Circle | null {
  if (!e || typeof e !== 'object') return null;
  const o = e as AnyRec;
  let p: THREE.Vector3 | null = null;
  let isDir = false;
  for (const k of ['position', 'pos', 'center', 'p']) if (isVec(o[k])) { p = new THREE.Vector3().copy(o[k] as THREE.Vector3); break; }
  if (!p && isVec(o.dir)) { p = new THREE.Vector3().copy(o.dir as THREE.Vector3); isDir = true; }
  if (!p && isVec(o)) p = new THREE.Vector3(o.x as number, o.y as number, o.z as number);
  if (!p || !Number.isFinite(p.x + p.y + p.z)) return null;
  if (isDir || Math.abs(p.length() - 1) < 1e-3) surfacePoint(p, p);
  const num = (...ks: string[]) => { for (const k of ks) if (typeof o[k] === 'number' && Number.isFinite(o[k])) return o[k] as number; return undefined; };
  const r = num('radius', 'r') ?? defR;
  const h = num('height', 'h') ?? defH;
  if (!(r > 0)) return null;
  return { p, r, h };
}

function toList(v: unknown, defR: number, defH: number): Circle[] {
  let arr: unknown = v;
  if (arr && typeof arr === 'object' && !Array.isArray(arr) && Symbol.iterator in (arr as object)) arr = Array.from(arr as Iterable<unknown>);
  if (!Array.isArray(arr)) return [];
  const out: Circle[] = [];
  // Flat numeric buffer: xyz triples (or xyzr quads when the length is not a multiple of 3).
  if (arr.length && typeof arr[0] === 'number') {
    const stride = arr.length % 3 === 0 ? 3 : arr.length % 4 === 0 ? 4 : 0;
    for (let i = 0; stride && i + stride <= arr.length; i += stride) {
      const c = toCircle({ x: arr[i], y: arr[i + 1], z: arr[i + 2], r: stride === 4 ? arr[i + 3] : undefined }, defR, defH);
      if (c) out.push(c);
    }
    return out;
  }
  for (const e of arr) {
    const c = toCircle(e, defR, defH);
    if (c) out.push(c);
  }
  return out;
}

interface Source { name: string; fn: string; load?: Loader; defR: number; defH: number; got: Circle[] | null }

/** Polls the sources for a while (they build asynchronously), then keeps a near-list for the player. */
export class ColliderSet {
  private sources: Source[];
  private all: Circle[] = [];
  private tries = 0;
  private nextPoll = 0;
  private nextNear = 0;
  near: Circle[] = [];

  constructor(loaders: Record<string, Loader>) {
    this.sources = [
      { name: 'village', fn: 'getColliders', load: loaders['./village.ts'], defR: 2.5, defH: 9, got: null },
      { name: 'forest', fn: 'getTreePositions', load: loaders['./forest.ts'], defR: 0.45, defH: 9, got: null },
    ];
  }

  get count() {
    return this.all.length;
  }

  get list(): readonly Circle[] {
    return this.all;
  }

  /** Call every frame with the play clock; cheap. */
  update(ctx: Ctx, t: number, pos: THREE.Vector3) {
    if (t >= this.nextPoll && this.tries < 30 && this.sources.some((s) => !s.got?.length)) {
      this.nextPoll = t + 1.5;
      this.tries++;
      void this.poll(ctx);
    }
    if (t >= this.nextNear) {
      this.nextNear = t + 0.25;
      this.near.length = 0;
      for (const c of this.all) if (c.p.distanceToSquared(pos) < (c.r + 14) * (c.r + 14)) this.near.push(c);
    }
  }

  private async poll(ctx: Ctx) {
    for (const s of this.sources) {
      if (s.got?.length) continue;
      if (!(s.name in ctx.systems)) continue; // only use systems that main actually loaded
      try {
        const sys = ctx.systems[s.name] as unknown as AnyRec;
        let f = sys?.[s.fn];
        if (typeof f !== 'function' && s.load) f = ((await s.load()) as AnyRec)?.[s.fn];
        if (typeof f !== 'function') continue;
        s.got = toList((f as () => unknown).call(sys), s.defR, s.defH);
      } catch {
        s.got = null;
      }
    }
    this.all = this.sources.flatMap((s) => s.got ?? []);
    this.nextNear = 0;
  }
}
