// Player / UI test in PLAY mode (the shot tool runs in 'shot' mode where the player is inert).
//
//   node tools/player-test.mjs [--only terrain,ocean,...] [--name player] [--quick]
//
// 1. Title card screenshots at 1280x720 and 1920x1080, click -> fly-down blend -> HUD, Esc -> pause.
// 2. Physics through ctx.systems.player.debug with fixed steps (frame loop frozen):
//    walk once round the planet across the north pole, mouse look + pitch clamp, jump arc,
//    fly to orbit and back, toggle-off fall + landing, never under terrain / deep under the sea.
// 3. Real keyboard: hold W for a second.
// Screenshots land in shots/<name>-*.png. Exit code 1 if any check fails.
import path from 'node:path';
import fs from 'node:fs';
import { openApp, ROOT } from './browser.mjs';

const args = process.argv.slice(2);
const one = (f, d) => { const i = args.indexOf(f); return i >= 0 ? args[i + 1] : d; };
const name = one('--name', 'player');
const extra = one('--only', 'terrain');
const only = ['player', ...extra.split(',').filter(Boolean)].join(',');

const outDir = path.join(ROOT, 'shots');
fs.mkdirSync(outDir, { recursive: true });
const fails = [];
const check = (ok, msg) => { console.log(ok ? '  ok  ' : '  FAIL', msg); if (!ok) fails.push(msg); };

const app = await openApp({ width: 1280, height: 720, query: `only=${only}` });
const { page } = app;
let n = 0;
const shot = async (label) => {
  const file = path.join(outDir, `${name}-${n++}-${label}.png`);
  await page.screenshot({ path: file });
  console.log('[shot]', file);
};
const wait = (ms) => page.waitForTimeout(ms);
const P = (fn, arg) => page.evaluate(fn, arg);

// ---------------------------------------------------------------- UI
console.log('[ui] title');
await wait(2200);
await app.checkErrors();
await shot('title-720');
await page.setViewportSize({ width: 1920, height: 1080 });
await wait(900);
await shot('title-1080');
await page.setViewportSize({ width: 820, height: 1000 });
await wait(600);
await shot('title-portrait');
await page.setViewportSize({ width: 1280, height: 720 });
await wait(400);

const screen = () => P(() => window.__tp.ctx.systems.player.debug.state().screen);
check((await screen()) === 'title', 'starts on the title card');
// record the camera every frame through the fly-down
await P(() => {
  const cam = window.__tp.ctx.camera;
  window.__rec = [];
  const tick = () => {
    const st = window.__tp.ctx.systems.player.debug.state();
    window.__rec.push({ p: cam.position.toArray(), q: cam.quaternion.toArray(), screen: st.screen });
    if (window.__rec.length < 400) requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
});
await page.mouse.click(640, 400);
await wait(450);
await shot('blend-a');
await wait(300);
check((await screen()) === 'blend', 'click starts the fly-down blend');
await shot('blend-b');
await wait(400);
await shot('blend-c');
await wait(1200);
const rec = await P(() => {
  const r = window.__rec.filter((x, i, a) => x.screen !== 'title' || (a[i + 1] && a[i + 1].screen !== 'title'));
  let maxAng = 0, minClear = Infinity;
  for (let i = 1; i < r.length; i++) {
    const a = r[i - 1].q, b = r[i].q;
    const dot = Math.abs(a[0] * b[0] + a[1] * b[1] + a[2] * b[2] + a[3] * b[3]);
    maxAng = Math.max(maxAng, 2 * Math.acos(Math.min(1, dot)));
    minClear = Math.min(minClear, Math.hypot(...r[i].p) - 60);
  }
  return { frames: r.length, maxAng, minClear };
});
console.log('  blend', JSON.stringify(rec));
check(rec.maxAng < 0.12, `fly-down blend is smooth (max camera turn per frame ${(rec.maxAng * 57.3).toFixed(2)} deg over ${rec.frames} frames)`);
check(rec.minClear > 0.4, `fly-down never dips into the planet (min clearance ${rec.minClear.toFixed(2)})`);
check((await screen()) === 'play', 'blend ends in play');
check((await P(() => window.__tp.ctx.systems.player.debug.audio())) === 'running', 'ambient audio started on the first click');
const locked = await P(() => document.pointerLockElement === window.__tp.ctx.canvas);
console.log('  pointer lock granted headless:', locked);
await wait(300);
await shot('hud-720');

// pause
if (locked) await P(() => document.exitPointerLock());
else await page.keyboard.press('Escape');
await wait(700);
check((await screen()) === 'pause', 'losing pointer lock / Esc pauses');
await shot('pause');
await page.mouse.click(640, 360);
await wait(1500);
if ((await screen()) !== 'play') { await wait(1200); await page.mouse.click(640, 360); await wait(800); }
check((await screen()) === 'play', 'click resumes');

// real keyboard: hold W
const before = await P(() => window.__tp.ctx.systems.player.debug.state().pos);
await page.keyboard.down('KeyW');
await wait(1000);
await page.keyboard.up('KeyW');
const after = await P(() => window.__tp.ctx.systems.player.debug.state().pos);
const moved = Math.hypot(after[0] - before[0], after[1] - before[1], after[2] - before[2]);
check(moved > 2 && moved < 8, `holding W for 1 s walks ~4 m (moved ${moved.toFixed(2)})`);

// F -> fly chip, screenshot at night
await page.keyboard.press('KeyF');
await page.keyboard.down('Space');
await wait(1500);
await page.keyboard.up('Space');
const fs1 = await P(() => window.__tp.ctx.systems.player.debug.state());
check(fs1.flying && fs1.altitude > 5, `F + Space flies up (alt ${fs1.altitude.toFixed(1)})`);
await shot('hud-flying');
await page.keyboard.press('KeyF');
await page.keyboard.press('KeyM');
await wait(400);
await shot('hud-mute-toast');

// ---------------------------------------------------------------- physics (fixed steps)
console.log('[physics]');
await P(() => { const d = window.__tp.ctx.systems.player.debug; d.freeze = true; d.teleport(-0.06, -0.26, 0.96); });

// 1) walk all the way round across the north pole
const walk = await P(() => {
  const d = window.__tp.ctx.systems.player.debug;
  d.face(0, 1000, 0); // head due north: the great circle passes both poles
  const s0 = d.state();
  const start = s0.pos;
  let travelled = 0, prev = start, maxPole = 0, worstUp = 0, worstRoll = 0, worstOrtho = 0, nan = false, under = 0, eyeLow = Infinity;
  let closest = Infinity, steps = 0, maxFwdJump = 0, prevFwd = s0.fwd;
  const R = 60;
  for (let chunk = 0; chunk < 4000 && steps < 60 * 400; chunk++) {
    const s = d.step(1 / 60, 6, { z: 1, run: true });
    steps += 6;
    const p = s.pos, l = Math.hypot(...p);
    if (![...p, ...s.fwd, ...s.eye, ...s.camUp].every(Number.isFinite)) { nan = true; break; }
    travelled += Math.hypot(p[0] - prev[0], p[1] - prev[1], p[2] - prev[2]);
    prev = p;
    maxPole = Math.max(maxPole, Math.abs(p[1]) / l);
    // up must equal normalize(position)
    worstUp = Math.max(worstUp, Math.hypot(s.up[0] - p[0] / l, s.up[1] - p[1] / l, s.up[2] - p[2] / l));
    // roll-free: camera right must be perpendicular to local up
    const cf = s.camFwd, cu = s.camUp;
    const right = [cf[1] * cu[2] - cf[2] * cu[1], cf[2] * cu[0] - cf[0] * cu[2], cf[0] * cu[1] - cf[1] * cu[0]];
    worstRoll = Math.max(worstRoll, Math.abs(right[0] * s.up[0] + right[1] * s.up[1] + right[2] * s.up[2]));
    worstOrtho = Math.max(worstOrtho, Math.abs(s.fwd[0] * s.up[0] + s.fwd[1] * s.up[1] + s.fwd[2] * s.up[2]));
    // heading must never flip: consecutive forward vectors stay close
    maxFwdJump = Math.max(maxFwdJump, Math.hypot(s.fwd[0] - prevFwd[0], s.fwd[1] - prevFwd[1], s.fwd[2] - prevFwd[2]));
    prevFwd = s.fwd;
    const floor = Math.max(R + s.terrain, R + 0.45 - 1.7);
    under = Math.max(under, floor - l);
    eyeLow = Math.min(eyeLow, Math.hypot(...s.eye) - Math.max(R, R + s.terrain));
    if (travelled > 300) closest = Math.min(closest, Math.hypot(p[0] - start[0], p[1] - start[1], p[2] - start[2]));
    if (travelled > 340 && closest < 3) break;
  }
  return { travelled, seconds: steps / 60, maxPole, worstUp, worstRoll, worstOrtho, maxFwdJump, nan, under, eyeLow, closest };
});
console.log('  walk', JSON.stringify(walk, (k, v) => (typeof v === 'number' ? +v.toFixed(4) : v)));
check(!walk.nan, 'no NaNs on the walk round the planet');
check(walk.maxPole > 0.98, `crossed the pole (max |y| ${walk.maxPole.toFixed(3)})`);
check(walk.travelled > 340, `walked all the way round (${walk.travelled.toFixed(0)} m in ${walk.seconds.toFixed(0)} s)`);
check(walk.closest < 6, `came back near the start (closest ${walk.closest.toFixed(2)} m)`);
check(walk.worstUp < 1e-6, `up == normalize(position) (err ${walk.worstUp.toExponential(1)})`);
check(walk.worstRoll < 1e-5, `camera never rolls (err ${walk.worstRoll.toExponential(1)})`);
check(walk.worstOrtho < 1e-6, `heading stays tangent (err ${walk.worstOrtho.toExponential(1)})`);
check(walk.maxFwdJump < 0.2, `heading never flips (max step change ${walk.maxFwdJump.toFixed(3)})`);
check(walk.under < 1e-3, `never under the terrain (worst ${walk.under.toFixed(4)})`);
check(walk.eyeLow > 0.3, `eye never deep under the sea (lowest eye above surface/sea ${walk.eyeLow.toFixed(2)})`);

// 2) walk across the pole the other way too, on a diagonal heading (exercises the transport, not just a meridian)
const diag = await P(() => {
  const d = window.__tp.ctx.systems.player.debug;
  d.teleport(0.3, 0.9, 0.3);
  d.face(-1000, 1000, 400);
  let nan = false, worstRoll = 0;
  const s0 = d.state();
  for (let i = 0; i < 1500; i++) {
    const s = d.step(1 / 60, 4, { z: 1, x: 0.4, run: true }, [0.002, 0]);
    if (![...s.pos, ...s.fwd, ...s.camUp].every(Number.isFinite)) { nan = true; break; }
    const cf = s.camFwd, cu = s.camUp;
    const right = [cf[1] * cu[2] - cf[2] * cu[1], cf[2] * cu[0] - cf[0] * cu[2], cf[0] * cu[1] - cf[1] * cu[0]];
    worstRoll = Math.max(worstRoll, Math.abs(right[0] * s.up[0] + right[1] * s.up[1] + right[2] * s.up[2]));
  }
  return { nan, worstRoll };
});
check(!diag.nan && diag.worstRoll < 1e-5, `spiralling walk with mouse look: no NaN, no roll (${diag.worstRoll.toExponential(1)})`);

// 3) mouse look + pitch clamp
const look = await P(() => {
  const d = window.__tp.ctx.systems.player.debug;
  d.teleport(-0.06, -0.26, 0.96);
  const a = d.state().fwd;
  d.look(Math.PI / 2, 0);
  const b = d.state().fwd;
  d.look(0, -10);
  const up = d.step(1 / 60, 1).pitch;
  d.look(0, 20);
  const down = d.step(1 / 60, 1).pitch;
  d.look(0, -down);
  return { dot: a[0] * b[0] + a[1] * b[1] + a[2] * b[2], up, down };
});
check(Math.abs(look.dot) < 1e-3, `yaw 90 deg turns the heading by 90 deg (dot ${look.dot.toFixed(4)})`);
check(Math.abs(look.up - (85 * Math.PI) / 180) < 1e-6 && Math.abs(look.down + (85 * Math.PI) / 180) < 1e-6, `pitch clamped to +/-85 deg (${((look.up * 180) / Math.PI).toFixed(1)}, ${((look.down * 180) / Math.PI).toFixed(1)})`);

// 4) jump arc on the village green
const jump = await P(() => {
  const d = window.__tp.ctx.systems.player.debug;
  d.teleport(0, -0.12, 1);
  d.step(1 / 60, 30);
  const alts = [];
  let s = d.step(1 / 60, 1, { jump: true });
  alts.push(s.altitude);
  for (let i = 0; i < 90; i++) { s = d.step(1 / 60, 1); alts.push(s.altitude); }
  return { peak: Math.max(...alts), end: alts[alts.length - 1], grounded: s.grounded, airFrames: alts.filter((a) => a > 0.01).length };
});
check(jump.peak > 0.9 && jump.peak < 1.5 && jump.grounded && jump.end < 0.01, `jump arc: peak ${jump.peak.toFixed(2)} m, ${jump.airFrames} frames airborne, lands`);

// 5) fly to orbit and back
const fly = await P(() => {
  const d = window.__tp.ctx.systems.player.debug;
  d.teleport(-0.06, -0.26, 0.96);
  d.setFlying(true);
  d.look(0, -1.4); // look steeply up
  let s, t = 0, tOrbit = -1, maxAlt = 0, minAlt = Infinity;
  for (; t < 30; t += 1 / 60) {
    s = d.step(1 / 60, 1, { z: 1 });
    maxAlt = Math.max(maxAlt, s.altitude);
    if (tOrbit < 0 && s.altitude > 150) tOrbit = t;
  }
  const capped = s.altitude;
  d.look(0, 3); // look steeply down
  let tBack = -1;
  for (t = 0; t < 30; t += 1 / 60) {
    s = d.step(1 / 60, 1, { z: 1, run: t < 3 });
    minAlt = Math.min(minAlt, s.altitude);
    if (tBack < 0 && s.altitude < 3) tBack = t;
  }
  // hold C (down) too, still clamped at 0.5
  for (let i = 0; i < 120; i++) { s = d.step(1 / 60, 1, { z: 1, y: -1 }); minAlt = Math.min(minAlt, s.altitude); }
  // climb to 40 m, toggle off, fall and land
  d.look(0, -3);
  for (let i = 0; i < 600 && s.altitude < 40; i++) s = d.step(1 / 60, 1, { y: 1 });
  const dropFrom = s.altitude;
  d.setFlying(false);
  let tLand = -1;
  for (t = 0; t < 10; t += 1 / 60) { s = d.step(1 / 60, 1); if (s.grounded || s.swimming) { tLand = t; break; } }
  for (let i = 0; i < 60; i++) s = d.step(1 / 60, 1);
  return { tOrbit, maxAlt, capped, tBack, minAlt, dropFrom, tLand, endAlt: s.altitude, flying: s.flying, nan: !s.pos.every(Number.isFinite) };
});
console.log('  fly', JSON.stringify(fly, (k, v) => (typeof v === 'number' ? +v.toFixed(2) : v)));
check(fly.tOrbit > 0 && fly.tOrbit < 8, `reaches orbit altitude (150 m) in ${fly.tOrbit.toFixed(1)} s`);
check(fly.maxAlt <= 220.5, `altitude capped (~220): max ${fly.maxAlt.toFixed(1)}`);
check(fly.tBack > 0 && fly.tBack < 10, `back down to the ground in ${fly.tBack.toFixed(1)} s`);
check(fly.minAlt >= 0.499, `never below terrain/sea + 0.5 while flying (min ${fly.minAlt.toFixed(3)})`);
check(fly.tLand > 0 && !fly.flying && fly.endAlt < 0.05 && !fly.nan, `toggle off at ${fly.dropFrom.toFixed(0)} m: falls and lands after ${fly.tLand.toFixed(2)} s`);

// 6) swim: walk out to sea from the spawn, eye stays above the water
const swim = await P(() => {
  const d = window.__tp.ctx.systems.player.debug;
  d.teleport(-0.06, -0.26, 0.96);
  d.face(0, -1000, 0); // south: the sea
  let swam = 0, eyeLow = Infinity, s;
  for (let i = 0; i < 60 * 40; i++) {
    s = d.step(1 / 60, 1, { z: 1 });
    if (s.swimming) swam++;
    if (s.terrain < 0) eyeLow = Math.min(eyeLow, Math.hypot(...s.eye) - 60);
  }
  return { swam, eyeLow };
});
check(swim.swam > 30, `swims out to sea (${swim.swam} swimming frames)`);
check(swim.eyeLow > 0.3, `eye stays above the sea while swimming/wading (lowest ${swim.eyeLow.toFixed(2)} m)`);

// 7) colliders (only if village / forest are loaded and export them)
const col = await P(() => {
  const d = window.__tp.ctx.systems.player.debug;
  const list = d.colliderList();
  if (!list.length) return null;
  // the collider nearest the forest centre
  const f = [0.78, 0.32, 0.54], fl = Math.hypot(...f);
  let best = list[0], bd = Infinity;
  for (const c of list) {
    const l = Math.hypot(c[0], c[1], c[2]);
    const dd = 1 - (c[0] * f[0] + c[1] * f[1] + c[2] * f[2]) / (l * fl);
    if (dd < bd) { bd = dd; best = c; }
  }
  // stand 3 m from it (away from the centre along some tangent), face it, walk into it for 3 s
  const l = Math.hypot(best[0], best[1], best[2]);
  const u = [best[0] / l, best[1] / l, best[2] / l];
  let t = [-u[1], u[0], 0]; const tl = Math.hypot(...t) || 1; t = t.map((x) => x / tl);
  d.teleport(best[0] + t[0] * 3, best[1] + t[1] * 3, best[2] + t[2] * 3);
  d.face(best[0], best[1], best[2]);
  let minD = Infinity;
  for (let i = 0; i < 180; i++) {
    const s = d.step(1 / 60, 1, { z: 1 });
    const p = s.pos;
    const dv = [p[0] - best[0], p[1] - best[1], p[2] - best[2]];
    const dh = dv[0] * s.up[0] + dv[1] * s.up[1] + dv[2] * s.up[2];
    const tang = Math.hypot(dv[0] - s.up[0] * dh, dv[1] - s.up[1] * dh, dv[2] - s.up[2] * dh);
    minD = Math.min(minD, tang);
  }
  return { n: list.length, r: best[3], minD };
});
if (col) check(col.minD >= col.r + 0.3, `collides with ${col.n} colliders: walking into one stops at ${col.minD.toFixed(2)} m (r ${col.r})`);
else console.log('  (no colliders exported by loaded systems; skipped)');

// ---------------------------------------------------------------- HUD at different times of day
console.log('[hud] times of day');
await P(() => { const d = window.__tp.ctx.systems.player.debug; d.teleport(-0.06, -0.26, 0.96); d.face(0, -0.12 * 60, 60); d.freeze = false; });
for (const [label, t] of [['noon', 255], ['sunset', 30], ['night', 105]]) {
  await P((t) => window.__tp.setTime(t), t);
  await wait(500);
  await shot(`hud-${label}`);
}
await page.setViewportSize({ width: 1920, height: 1080 });
await wait(500);
await shot('hud-1080');

await app.checkErrors();
const stats = await P(() => window.__tp.info());
console.log('[stats]', JSON.stringify(stats));
console.log(fails.length ? `\n${fails.length} FAILED` : '\nall checks passed');
await app.close(fails.length ? 1 : 0);
