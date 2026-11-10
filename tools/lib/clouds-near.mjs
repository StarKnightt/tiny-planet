// Helper for tuning the cinematic dive: list the clouds nearest a point on the village map at time t.
//   node tools/lib/clouds-near.mjs --t 6.5 --e -41 --n -50 [--count 8]
// Prints each cloud's village-map position (east, north), base altitude above sea level and size.
import { openApp } from '../browser.mjs';

const args = process.argv.slice(2);
const one = (f, d) => { const i = args.indexOf(f); return i >= 0 ? Number(args[i + 1]) : d; };
const t = one('--t', 6.5), e = one('--e', -41), n = one('--n', -50), count = one('--count', 8);

const app = await openApp({ width: 320, height: 180, query: 'shot=1&only=clouds&nopost=1' });
const rows = await app.page.evaluate(({ t, e, n }) => {
  const tp = window.__tp;
  const THREE_V = tp.ctx.camera.position.constructor; // THREE.Vector3 without importing three
  const clouds = tp.ctx.systems.clouds?.cloudsAt?.(t);
  if (!clouds) return null;
  const R = 60;
  const V = new THREE_V(0, -0.12, 1).normalize();
  const up = new THREE_V(0, 1, 0);
  const east = new THREE_V().crossVectors(up, V).normalize();
  const north = new THREE_V().crossVectors(V, east).normalize();
  return clouds
    .map((c) => {
      const d = c.centre.clone().normalize();
      const ang = Math.acos(Math.min(1, Math.max(-1, d.dot(V))));
      const h = d.clone().addScaledVector(V, -d.dot(V));
      const hl = h.length() || 1;
      const ce = (h.dot(east) / hl) * ang * R, cn = (h.dot(north) / hl) * ang * R;
      return { e: +ce.toFixed(1), n: +cn.toFixed(1), base: +(c.baseRadius - R).toFixed(1), top: +(c.centre.length() - R).toFixed(1), size: +c.size.toFixed(1), dist: +Math.hypot(ce - e, cn - n).toFixed(1) };
    })
    .sort((a, b) => a.dist - b.dist);
}, { t, e, n });
if (!rows) await app.close(1, 'clouds system has no cloudsAt()');
console.table(rows.slice(0, count));
await app.close(0);
