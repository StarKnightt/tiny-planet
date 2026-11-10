// Screenshot tool. Renders deterministic stills of the planet on the GPU and exits.
//
//   node tools/shot.mjs --name grass --only terrain,grass --view "g:-0.82,0.22,0.52;1.7;90;-5" --view "0,40,190;0,0,0"
//
//   --name  <prefix>       output: shots/<prefix>-<n>.png           (default "shot")
//   --only  a,b,c          load only these systems (src/systems/<name>.ts). Default: all.
//   --view  <spec>         repeatable. Either
//                            free camera:  "px,py,pz;tx,ty,tz[;fov]"
//                            on the ground: "g:dx,dy,dz;eyeHeight;yawDeg;pitchDeg[;fov]"   (yaw clockwise from north)
//   --sun   <angle|x,y,z>  day-cycle angle in radians, or an explicit sun direction. Default 0.95 (golden afternoon at the village).
//                          Tip: pass the view's own direction for local noon; the opposite for midnight.
//   --time  <seconds>      world time (animation phase). Default 3.
//   --cine  <t>            repeatable; render the cinematic at time t instead of a --view.
//   --size  WxH            default 1280x720
//   --nopost               skip post-processing
//   --stats                print draw calls / triangles and a rough ms-per-frame
import path from 'node:path';
import fs from 'node:fs';
import { openApp, ROOT } from './browser.mjs';

const args = process.argv.slice(2);
const all = (flag) => args.flatMap((a, i) => (a === flag ? [args[i + 1]] : []));
const one = (flag, dflt) => all(flag)[0] ?? dflt;
const has = (flag) => args.includes(flag);

const name = one('--name', 'shot');
const only = one('--only', '');
const [width, height] = one('--size', '1280x720').split('x').map(Number);
const sun = one('--sun', '0.95');
const time = Number(one('--time', '3'));
const views = all('--view');
const cines = all('--cine').map(Number);
if (!views.length && !cines.length) views.push('0,40,190;0,0,0');

const query = ['shot=1', only && `only=${only}`, has('--nopost') && 'nopost=1'].filter(Boolean).join('&');
const app = await openApp({ width, height, query });
const { page } = app;
const outDir = path.join(ROOT, 'shots');
fs.mkdirSync(outDir, { recursive: true });

const nums = (s) => s.split(',').map(Number);
let n = 0;
const snap = async () => {
  await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => r(null))));
  const file = path.join(outDir, `${name}-${n++}.png`);
  await page.locator('#game').screenshot({ path: file });
  console.log('[shot]', file);
};

for (const spec of views) {
  await page.evaluate(
    ({ spec, sun, time }) => {
      const tp = window.__tp;
      const nums = (s) => s.split(',').map(Number);
      tp.setTime(time);
      const s = nums(sun);
      if (s.length === 3) tp.setSunDir(s[0], s[1], s[2]);
      else tp.setSunAngle(s[0]);
      if (spec.startsWith('g:')) {
        const [d, h, yaw, pitch, fov] = spec.slice(2).split(';');
        tp.setGroundView(...nums(d), Number(h ?? 1.7), Number(yaw ?? 0), Number(pitch ?? 0), Number(fov ?? 55));
      } else {
        const [p, t, fov] = spec.split(';');
        tp.setCamera(...nums(p), ...nums(t), Number(fov ?? 55));
      }
      tp.render();
      tp.render(); // second pass: anything that lags a frame (shadow maps, history buffers) has settled
    },
    { spec, sun, time },
  );
  await app.checkErrors();
  await snap();
}
for (const t of cines) {
  const ok = await page.evaluate((t) => {
    window.__tp.cinematicFrame(Math.max(0, t - 1 / 60));
    return window.__tp.cinematicFrame(t);
  }, t);
  if (!ok) await app.close(1, 'no src/cinematic.ts');
  await app.checkErrors();
  await snap();
}

if (has('--stats')) {
  const stats = await page.evaluate(() => {
    const tp = window.__tp;
    const gl = tp.ctx.renderer.getContext();
    const t0 = performance.now();
    const N = 120;
    for (let i = 0; i < N; i++) {
      tp.setTime(tp.ctx.time + 1 / 60);
      tp.render();
    }
    gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array(4)); // forces the GPU to actually finish
    return { ...tp.info(), msPerFrame: +((performance.now() - t0) / N).toFixed(2) };
  });
  console.log('[stats]', JSON.stringify(stats));
}
await app.close(0);
