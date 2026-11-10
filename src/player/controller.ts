// First-person controller on a spherical planet.
//
// Orientation is never derived from a world axis. The player carries a tangent `fwd` vector that is
// parallel-transported (rotated by the minimal rotation old-up -> new-up) every time the position
// moves, then re-orthonormalised against the new up. Yaw rotates `fwd` about the local up; pitch is
// a scalar. So there is no pole, no flip, no gimbal lock anywhere on the sphere.
//
// This is the one place in the game that accumulates state with dt (allowed by the brief).
import * as THREE from 'three';
import { heightAtXYZ, LANDMARKS, R, tangentFrame } from '../core/terrain';

export const EYE = 1.7;
/** Eye stays at least this far above sea level while swimming. */
const SWIM_EYE = 0.45;
/** Feet radius of a swimmer floating on the surface. */
const SWIM_FEET = R + SWIM_EYE - EYE;
const GRAVITY = 18;
const JUMP_V = 6.4; // ~1.15 m hop
const WALK = 4.2;
const RUN = 7.6;
const COYOTE = 0.13;
const JUMP_BUFFER = 0.14;
const PITCH_MAX = THREE.MathUtils.degToRad(85);
const FLY_CEIL = R + 220;
const PLAYER_RADIUS = 0.38;

export interface MoveInput {
  /** -1..1 strafe (right +) */
  x: number;
  /** -1..1 forward + */
  z: number;
  /** -1..1 fly up/down */
  y: number;
  run: boolean;
  /** true on the frame Space went down */
  jump: boolean;
}

export interface Circle {
  p: THREE.Vector3;
  r: number;
  /** top height above its base */
  h: number;
}

export type Surface = 'grass' | 'sand' | 'water' | 'rock';

const _q = new THREE.Quaternion();
const _v = new THREE.Vector3();
const _w = new THREE.Vector3();
const _d = new THREE.Vector3();
const _wish = new THREE.Vector3();
const _m = new THREE.Matrix4();
const _x = new THREE.Vector3(1, 0, 0);

export class Controller {
  /** Feet position (world). */
  readonly pos = new THREE.Vector3();
  /** normalize(pos) */
  readonly up = new THREE.Vector3();
  /** Unit tangent heading (no pitch). */
  readonly fwd = new THREE.Vector3();
  readonly right = new THREE.Vector3();
  readonly vel = new THREE.Vector3();
  pitch = 0;
  flying = false;
  grounded = true;
  swimming = false;
  /** Water depth at the feet (0 on land). */
  wade = 0;
  /** Height of the feet above max(terrain, sea). */
  altitude = 0;
  /** Horizontal (tangent) speed, m/s. */
  speed = 0;
  /** Eye world position and camera orientation after the last step. */
  readonly eye = new THREE.Vector3();
  readonly quat = new THREE.Quaternion();
  fov = 70;

  private coyote = 0;
  private jumpBuf = 0;
  private bobPhase = 0;
  private bobAmp = 0;
  private dip = 0;
  private dipVel = 0;
  private swimT = 0;
  private fovTarget = 70;
  /** Footstep events since the last call to takeSteps(). */
  private steps = 0;
  private lastSurface: Surface = 'grass';
  colliders: Circle[] = [];

  constructor() {
    this.reset();
  }

  reset() {
    const d = LANDMARKS.spawn.clone().normalize();
    this.pos.copy(d).multiplyScalar(this.floorRadius(d.x, d.y, d.z));
    this.up.copy(d);
    const to = LANDMARKS.village.clone().sub(d);
    this.fwd.copy(to).addScaledVector(d, -to.dot(d)).normalize();
    this.right.crossVectors(this.fwd, this.up).normalize();
    this.vel.set(0, 0, 0);
    this.pitch = 0;
    this.flying = false;
    this.grounded = true;
    this.updateCamera(0, false);
  }

  /** Radius the feet rest at: terrain, or the floating swimmer level over deep water. */
  floorRadius(x: number, y: number, z: number): number {
    return Math.max(R + heightAtXYZ(x, y, z), SWIM_FEET);
  }

  look(dx: number, dy: number) {
    if (dx) this.fwd.applyAxisAngle(this.up, -dx).normalize();
    this.pitch = THREE.MathUtils.clamp(this.pitch - dy, -PITCH_MAX, PITCH_MAX);
    this.right.crossVectors(this.fwd, this.up).normalize();
  }

  setFlying(on: boolean) {
    if (on === this.flying) return;
    this.flying = on;
    if (on) {
      // A little lift-off so toggling on the ground feels like taking off.
      this.grounded = false;
      if (this.vel.dot(this.up) < 3) this.vel.addScaledVector(this.up, 3 - this.vel.dot(this.up));
    } else {
      // Keep momentum but cap it so a boosted dive does not fling you across the planet.
      const tv = _v.copy(this.vel).addScaledVector(this.up, -this.vel.dot(this.up));
      if (tv.length() > RUN * 1.5) tv.setLength(RUN * 1.5);
      const vr = THREE.MathUtils.clamp(this.vel.dot(this.up), -12, 4);
      this.vel.copy(tv).addScaledVector(this.up, vr);
    }
  }

  takeSteps(): { n: number; surface: Surface } {
    const n = this.steps;
    this.steps = 0;
    return { n, surface: this.lastSurface };
  }

  /** Advance by dt (seconds). Splits into fixed-ish substeps for stability. */
  step(dt: number, input: MoveInput) {
    dt = Math.min(Math.max(dt, 0), 0.1);
    if (input.jump) this.jumpBuf = JUMP_BUFFER;
    const n = Math.max(1, Math.ceil(dt / (1 / 90)));
    const h = dt / n;
    for (let i = 0; i < n; i++) {
      if (this.flying) this.stepFly(h, input);
      else this.stepWalk(h, input);
    }
    this.updateCamera(dt, input.run);
  }

  private stepWalk(dt: number, input: MoveInput) {
    const up = this.up;
    this.right.crossVectors(this.fwd, up).normalize();
    _wish.copy(this.fwd).multiplyScalar(input.z).addScaledVector(this.right, input.x);
    const wl = _wish.length();
    if (wl > 1) _wish.multiplyScalar(1 / wl);

    // Water: wading slows you, swimming slows you more.
    let speed = input.run ? RUN : WALK;
    if (this.swimming) speed = input.run ? 3.4 : 2.6;
    else if (this.wade > 0) speed *= THREE.MathUtils.lerp(1, 0.55, Math.min(1, this.wade / 1.2));

    // Steep uphill: look 0.6 m ahead along the wish direction and slow down with the grade.
    if (wl > 0.01 && this.grounded && !this.swimming) {
      _d.copy(this.pos).addScaledVector(_wish, 0.6 / Math.max(wl, 1e-3)).normalize();
      const r0 = R + heightAtXYZ(up.x, up.y, up.z);
      const r1 = R + heightAtXYZ(_d.x, _d.y, _d.z);
      const grade = (r1 - r0) / 0.6;
      if (grade > 0.3) speed *= THREE.MathUtils.clamp(1 - (grade - 0.3) / 0.9, 0.22, 1);
    }

    let vr = this.vel.dot(up);
    const tv = _v.copy(this.vel).addScaledVector(up, -vr);
    const k = this.grounded ? (wl > 0.01 ? 9 : 11) : 1.6;
    tv.lerp(_wish.multiplyScalar(speed), 1 - Math.exp(-k * dt));

    // Jump (coyote time + input buffer). No jumping out of deep water.
    this.coyote = this.grounded ? COYOTE : this.coyote - dt;
    this.jumpBuf -= dt;
    if (this.jumpBuf > 0 && this.coyote > 0 && !this.swimming) {
      vr = JUMP_V;
      this.jumpBuf = 0;
      this.coyote = 0;
      this.grounded = false;
    }
    vr = Math.max(vr - GRAVITY * dt, -30); // gentle terminal velocity: no fall damage, ever

    const wasGrounded = this.grounded;
    _w.copy(this.pos).addScaledVector(tv, dt).addScaledVector(up, vr * dt);
    this.pushOut(_w);
    let r = _w.length();
    _d.copy(_w).multiplyScalar(1 / r);
    const floor = this.floorRadius(_d.x, _d.y, _d.z);
    // Snap down slopes while walking instead of skipping off them.
    const snap = 0.08 + tv.length() * dt * 1.4;
    if (r <= floor) {
      if (vr < -3) this.land(-vr);
      r = floor;
      if (vr < 0) vr = 0;
      this.grounded = vr === 0;
    } else if (wasGrounded && vr <= 0 && r - floor < snap) {
      r = floor;
      vr = 0;
      this.grounded = true;
    } else {
      this.grounded = false;
    }
    _w.copy(_d).multiplyScalar(r);
    this.moveTo(_w, tv, vr);

    const hT = heightAtXYZ(_d.x, _d.y, _d.z);
    this.wade = Math.max(0, -hT);
    this.swimming = hT < SWIM_FEET - R + 0.001 && r <= floor + 0.01;
    this.altitude = r - (R + Math.max(hT, 0));

    // Head bob + footsteps.
    const hs = this.vel.length() - Math.abs(this.vel.dot(this.up));
    this.speed = Math.max(0, hs);
    if (this.grounded && !this.swimming && this.speed > 0.3) {
      const stride = input.run ? 1.05 : 0.8;
      const before = Math.floor(this.bobPhase / Math.PI);
      this.bobPhase += (this.speed * dt * Math.PI) / stride;
      if (Math.floor(this.bobPhase / Math.PI) !== before) {
        this.steps++;
        this.lastSurface = this.wade > 0.05 ? 'water' : hT < 1.0 ? 'sand' : 'grass';
      }
    }
    if (this.swimming) {
      this.swimT += dt * (1 + this.speed * 0.3);
      const before = Math.floor(this.swimT / 1.4);
      if (this.speed > 0.6 && Math.floor((this.swimT + dt) / 1.4) !== before) {
        this.steps++;
        this.lastSurface = 'water';
      }
    }
    const ampT = this.grounded && !this.swimming ? Math.min(this.speed / WALK, 1.6) : 0;
    this.bobAmp += (ampT - this.bobAmp) * (1 - Math.exp(-8 * dt));
    this.fovTarget = 70 + (input.run && this.speed > WALK + 0.5 ? 6 : 0);
  }

  private stepFly(dt: number, input: MoveInput) {
    const up = this.up;
    this.right.crossVectors(this.fwd, up).normalize();
    const cp = Math.cos(this.pitch);
    const sp = Math.sin(this.pitch);
    _wish
      .copy(this.fwd)
      .multiplyScalar(cp * input.z)
      .addScaledVector(up, sp * input.z + input.y)
      .addScaledVector(this.right, input.x);
    const wl = _wish.length();
    if (wl > 1) _wish.multiplyScalar(1 / wl);

    // Speed grows with altitude so orbit (~150 up) is a few seconds away.
    const alt = Math.max(0, this.altitude);
    let speed = Math.min(12 * (1 + alt / 16), 120);
    if (input.run) speed *= 2.4;
    this.vel.lerp(_wish.multiplyScalar(speed), 1 - Math.exp(-(wl > 0.01 ? 3.5 : 2.6) * dt));

    _w.copy(this.pos).addScaledVector(this.vel, dt);
    if (alt < 12) this.pushOut(_w);
    let r = _w.length();
    _d.copy(_w).multiplyScalar(1 / r);
    const hT = heightAtXYZ(_d.x, _d.y, _d.z);
    const minR = R + Math.max(hT, 0) + 0.5;
    let vr = this.vel.dot(up);
    if (r < minR) {
      r = minR;
      if (vr < 0) vr = 0;
    }
    if (r > FLY_CEIL) {
      r = FLY_CEIL;
      if (vr > 0) vr = 0;
    }
    const tv = _v.copy(this.vel).addScaledVector(up, -this.vel.dot(up));
    _w.copy(_d).multiplyScalar(r);
    this.moveTo(_w, tv, vr);

    this.grounded = false;
    this.swimming = false;
    this.wade = 0;
    this.altitude = r - (R + Math.max(hT, 0));
    this.speed = this.vel.length();
    this.bobAmp += (0 - this.bobAmp) * (1 - Math.exp(-8 * dt));
    this.fovTarget = 70 + Math.min(14, this.speed / 14) + (input.run && wl > 0.01 ? 4 : 0);
  }

  /** Move to `p`, parallel-transporting the heading and the velocity to the new tangent plane. */
  private moveTo(p: THREE.Vector3, tv: THREE.Vector3, vr: number) {
    const newUp = _x.copy(p).normalize();
    _q.setFromUnitVectors(this.up, newUp);
    this.fwd.applyQuaternion(_q);
    tv.applyQuaternion(_q);
    this.pos.copy(p);
    this.up.copy(newUp);
    _x.set(1, 0, 0);
    // Re-orthonormalise against the new up (kills drift).
    this.fwd.addScaledVector(this.up, -this.fwd.dot(this.up));
    if (this.fwd.lengthSq() < 1e-10) tangentFrame(this.up, _v, this.fwd); // never happens in practice
    this.fwd.normalize();
    tv.addScaledVector(this.up, -tv.dot(this.up));
    this.vel.copy(tv).addScaledVector(this.up, vr);
    this.right.crossVectors(this.fwd, this.up).normalize();
  }

  /** Circle push-out against nearby colliders, in the tangent plane. */
  private pushOut(p: THREE.Vector3) {
    if (!this.colliders.length) return;
    const pr = p.length();
    const u = _x.copy(p).multiplyScalar(1 / pr);
    for (const c of this.colliders) {
      _d.copy(p).sub(c.p);
      const dh = _d.dot(u);
      if (dh > c.h || dh < -2) continue; // above it (flying / on a roof) or far below
      _d.addScaledVector(u, -dh);
      const rr = c.r + PLAYER_RADIUS;
      const l2 = _d.lengthSq();
      if (l2 >= rr * rr) continue;
      const l = Math.sqrt(l2);
      if (l < 1e-5) _d.copy(this.right);
      else _d.multiplyScalar(1 / l);
      p.addScaledVector(_d, rr - l);
    }
    _x.set(1, 0, 0);
  }

  private land(impact: number) {
    this.dipVel -= Math.min(impact, 25) * 0.05;
  }

  private updateCamera(dt: number, run: boolean) {
    // Landing dip: damped spring.
    if (dt > 0) {
      const k = 120;
      const c = 18;
      this.dipVel += (-k * this.dip - c * this.dipVel) * dt;
      this.dip += this.dipVel * dt;
      this.dip = THREE.MathUtils.clamp(this.dip, -0.45, 0.2);
      this.fov += (this.fovTarget - this.fov) * (1 - Math.exp(-5 * dt));
    }
    const a = this.bobAmp;
    let lift = EYE + this.dip + a * 0.045 * (Math.cos(2 * this.bobPhase) - 1) * 0.5;
    if (this.swimming) lift += 0.06 * Math.sin(this.swimT * 2.1);
    this.eye
      .copy(this.pos)
      .addScaledVector(this.up, lift)
      .addScaledVector(this.right, a * 0.022 * Math.sin(this.bobPhase));
    // Never let the eye dip under the waterline beyond the swimming limit.
    const er = this.eye.length();
    if (er < R + SWIM_EYE - 0.1 && !this.flying && this.swimming) this.eye.multiplyScalar((R + SWIM_EYE - 0.1) / er);

    // Camera basis: x = right, y = up, z = -fwd; then pitch about local x.
    _v.copy(this.fwd).negate();
    _m.makeBasis(this.right, this.up, _v);
    this.quat.setFromRotationMatrix(_m);
    _q.setFromAxisAngle(_x.set(1, 0, 0), this.pitch);
    this.quat.multiply(_q);
    // a whisper of roll into strafes while running feels nice, but roll-free is the brief: keep 0.
    void run;
  }

  /** Unit view direction (with pitch). */
  viewDir(out = new THREE.Vector3()) {
    return out.copy(this.fwd).multiplyScalar(Math.cos(this.pitch)).addScaledVector(this.up, Math.sin(this.pitch));
  }
}
