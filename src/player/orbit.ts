// Title-screen orbit (a pure function of time) and the eased fly-down from orbit to the player's eyes.
import * as THREE from 'three';

const AXIS = new THREE.Vector3(0.22, 1, -0.12).normalize();
const START = new THREE.Vector3(-0.35, 0.28, 1).normalize(); // starts over the village side
const RADIUS = 196;

export interface Pose {
  pos: THREE.Vector3;
  target: THREE.Vector3;
  up: THREE.Vector3;
  fov: number;
}

export const makePose = (): Pose => ({ pos: new THREE.Vector3(), target: new THREE.Vector3(), up: new THREE.Vector3(0, 1, 0), fov: 50 });

const _r = new THREE.Vector3();
/**
 * Slow orbit. `shift` (-1..1) slides the planet sideways in frame so the title card has room:
 * positive moves the planet to the right of the screen.
 */
export function orbitPose(t: number, shift: number, out: Pose, shiftY = 0): Pose {
  const a = t * 0.045;
  out.pos.copy(START).applyAxisAngle(AXIS, a);
  // gentle bob in latitude
  out.pos.addScaledVector(AXIS, 0.12 * Math.sin(t * 0.031)).normalize().multiplyScalar(RADIUS);
  out.up.copy(AXIS);
  // camera looks at -pos; right = forward x up = (-pos) x up
  _r.crossVectors(out.pos, out.up).multiplyScalar(-1 / out.pos.length()).normalize();
  out.target.set(0, 0, 0).addScaledVector(_r, -shift * 62).addScaledVector(out.up, -shiftY * 62);
  out.fov = 50;
  return out;
}

const easeInOut = (x: number) => (x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2);
const smooth = (x: number) => x * x * (3 - 2 * x);
const clamp01 = (x: number) => Math.min(1, Math.max(0, x));

const _a = new THREE.Vector3();
const _b = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _id = new THREE.Quaternion();
const _m = new THREE.Matrix4();
const _up = new THREE.Vector3();
const _f = new THREE.Vector3();
const _c = new THREE.Vector3();

/**
 * Blend camera from `from` (orbit) to `to` (eyes) at u in [0,1].
 * Swings around the planet first, then descends, while the gaze tilts from the planet to the horizon.
 */
export function blendPose(from: Pose, to: Pose, toFwd: THREE.Vector3, u: number, cam: THREE.PerspectiveCamera) {
  const uDir = easeInOut(clamp01(u * 1.15));
  const uRad = easeInOut(clamp01((u - 0.08) / 0.92));
  const uLook = smooth(clamp01((u - 0.3) / 0.7));
  const rA = from.pos.length();
  const rB = to.pos.length();
  _a.copy(from.pos).normalize();
  _b.copy(to.pos).normalize();
  _q.setFromUnitVectors(_a, _b);
  _q.copy(_id.identity().slerp(_q, uDir));
  _a.applyQuaternion(_q);
  // radius: exponential-ish descent feels better than linear (fast high up, slow near the ground)
  const r = rB * Math.pow(rA / rB, 1 - uRad);
  cam.position.copy(_a).multiplyScalar(r);

  // Look target: planet centre (rotated along with us) -> the eye's look point.
  _b.copy(from.target).applyQuaternion(_q).lerp(to.target, uLook);
  // Up: while looking down at the planet, screen-up turns (about the view axis) from the orbit's up to the
  // player's heading; then, as the gaze levels out to the horizon, it tilts to the local up. Every stage
  // stays perpendicular-ish to the view, so lookAt never degenerates.
  _up.copy(from.up).applyQuaternion(_q);
  _up.addScaledVector(_a, -_up.dot(_a)).normalize();
  _f.copy(toFwd).addScaledVector(_a, -toFwd.dot(_a)).normalize();
  const ang = Math.atan2(_c.crossVectors(_up, _f).dot(_a), _up.dot(_f));
  _up.applyAxisAngle(_a, ang * smooth(clamp01(u * 1.4)));
  _up.lerp(_a, uLook).normalize();
  _m.lookAt(cam.position, _b, _up);
  cam.quaternion.setFromRotationMatrix(_m);
  cam.fov = THREE.MathUtils.lerp(from.fov, to.fov, uRad);
}

export function applyPose(p: Pose, cam: THREE.PerspectiveCamera) {
  cam.position.copy(p.pos);
  _m.lookAt(p.pos, p.target, p.up);
  cam.quaternion.setFromRotationMatrix(_m);
  cam.fov = p.fov;
}
