// Offline video capture of the cinematic (src/cinematic.ts): rendered frame by frame on the GPU with a fixed
// time step, so the result is perfectly smooth however fast or slow each frame renders.
//
//   node tools/capture.mjs                                  full film -> recordings/tiny-planet.mp4
//   node tools/capture.mjs --from 0 --to 3 --out capture-tmp/test.mp4 --stills 6
//
//   --out <file.mp4>     output (default recordings/tiny-planet.mp4; folders are created)
//   --size WxH           default 1920x1080
//   --fps N              default 60
//   --from s / --to s    capture only [from, to) of the film (default 0 .. DURATION)
//   --no-audio           skip the sound bed
//   --keep-frames        also write every frame as PNG to <out-name>-frames/
//   --stills N           after encoding, extract N evenly spaced PNG stills next to the MP4
//   --stills-only N      just extract N stills from an existing --out file (no rendering)
//   --cq N               nvenc constant-quality level (default 17; lower = better/bigger)
//   --only a,b           load only these systems (debugging)
//   --check              numeric camera-path self-check only (no browser), exit 1 on problems
//   --verify             grab-correctness test: determinism, no one-frame lag, readPixels vs screenshot colours
//   --bench              time the grab methods (render / readPixels / POST / screenshot png+jpeg)
//   --grab yuv|rgba      frame read-back format (default yuv; rgba is the slower reference path)
//   --allow-software     permit a CPU rasteriser (never by default; the run fails without the RTX GPU)
//
// Pipeline: page renders frame i (window.__tp.cinematicFrame(t, 1/fps)) -> the canvas is copied to a
// texture and converted on the GPU to planar BT.709 limited-range yuv420p (flipped top-down) -> readPixels
// -> WebSocket to a loopback endpoint in this process (tools/lib/frame-sink.mjs) -> stdin of ONE
// long-running ffmpeg (rawvideo yuv420p -> h264_nvenc, no swscale step).
// Why YUV on the GPU: page->node transfer runs at ~185 MB/s whatever the transport, so it dominates; 1.5 B/px
// instead of 4 B/px takes 1080p from ~11 to ~25+ frames/s. The conversion is checked every run against a
// CPU reference computed from the RGBA canvas bytes (--grab rgba keeps the plain path for comparison).
// Then the procedural sound bed (tools/audio-bed.mjs) is muxed in, and the file is renamed into place
// only when complete. ffprobe facts are printed and asserted at the end.
//
// Teardown: vite + chromium via openApp() (tools/browser.mjs); every ffmpeg child is tracked and killed
// synchronously on exit (tools/lib/proc.mjs), temp files are deleted unless the run succeeds.
import path from 'node:path';
import fs from 'node:fs';
import { performance } from 'node:perf_hooks';
import { ROOT } from './lib/root.mjs';
import { spawnTracked, run, tempPath, keepTemp, haveBinary } from './lib/proc.mjs';

const args = process.argv.slice(2);
const one = (flag, dflt) => {
  const i = args.indexOf(flag);
  return i >= 0 && i + 1 < args.length ? args[i + 1] : dflt;
};
const has = (flag) => args.includes(flag);

const OUT = path.resolve(ROOT, one('--out', 'recordings/tiny-planet.mp4'));
const [W, H] = one('--size', '1920x1080').split('x').map(Number);
const FPS = Number(one('--fps', '60'));
const CQ = Number(one('--cq', '17'));
const ONLY = one('--only', '');
const STILLS = Number(one('--stills', one('--stills-only', '0')));
// yuv: BT.709 limited-range 4:2:0 converted on the GPU (1.5 B/px). rgba: raw readPixels (4 B/px), converted by ffmpeg.
const GRAB = one('--grab', W % 8 === 0 && H % 4 === 0 ? 'yuv' : 'rgba');
const FRAME_BYTES = GRAB === 'yuv' ? (W * H * 3) / 2 : W * H * 4;

const log = (...a) => console.log('[capture]', ...a);
const fail = (msg) => {
  console.error('[capture] FAILED:', msg);
  process.exit(1);
};

if (!Number.isInteger(W) || !Number.isInteger(H) || W < 16 || H < 16 || W % 2 || H % 2) fail(`bad --size ${W}x${H} (even numbers)`);
if (!(FPS > 0)) fail('bad --fps');
if (GRAB !== 'yuv' && GRAB !== 'rgba') fail(`bad --grab ${GRAB} (yuv|rgba)`);
if (GRAB === 'yuv' && (W % 8 || H % 4)) fail(`--grab yuv needs width % 8 == 0 and height % 4 == 0 (got ${W}x${H}); use --grab rgba`);

// ------------------------------------------------------------------------------------------------
// --check: numeric smoothness / clearance report, no browser
// ------------------------------------------------------------------------------------------------
function printReport(rep) {
  const f = (o, unit, d = 2) => `${o.value.toFixed(d)} ${unit} @ t=${o.t.toFixed(2)}`;
  log('camera path self-check:', rep.ok ? 'OK' : 'PROBLEMS');
  log(`  start distance ${rep.startDistance.toFixed(1)}, start speed ${rep.startSpeed.toFixed(3)} u/s, end speed ${rep.endSpeed.toFixed(2)} u/s, end turn ${rep.endAngVelDeg.toFixed(2)} deg/s`);
  log(`  min clearance ${f(rep.minClearance, 'u')}   (smooth floor lift engaged: ${JSON.stringify(rep.liftEngaged)})`);
  log(`  max speed ${f(rep.maxSpeed, 'u/s')}   max accel ${f(rep.maxAccel, 'u/s^2')}   max jerk ${f(rep.maxJerk, 'u/s^3', 0)}`);
  log(`  max angular vel ${f(rep.maxAngVelDeg, 'deg/s', 1)}   max angular accel ${f(rep.maxAngAccelDeg, 'deg/s^2', 1)}   max fov rate ${f(rep.maxFovRate, 'deg/s')}`);
  log(`  min look/up margin ${f(rep.minUpMargin, '')}   max bank ${rep.maxBankDeg.toFixed(2)} deg`);
  log(`  key arrival (table t -> film t): ${rep.keyArrival.map(([a, b]) => `${a}->${b}`).join('  ')}`);
  log(`  village sun height: ${rep.sun.map((s) => `${s.t}s:${s.villageSunH}`).join('  ')}`);
  log('  profile  t  speed(u/s)  angvel(deg/s)  alt(sea)  clearance');
  for (const p of rep.profile) if (p[0] % 1 === 0) log(`           ${String(p[0]).padStart(2)}  ${String(p[1]).padStart(6)}  ${String(p[2]).padStart(6)}  ${String(p[3]).padStart(7)}  ${String(p[4]).padStart(7)}`);
  for (const p of rep.problems) log('  PROBLEM:', p);
}

if (has('--check')) {
  const { withSrc } = await import('./lib/ssr.mjs');
  const rep = await withSrc(async (load) => (await load('/src/cinematic.ts')).checkCinematic());
  printReport(rep);
  process.exit(rep.ok ? 0 : 1);
}

// ------------------------------------------------------------------------------------------------
// ffmpeg helpers
// ------------------------------------------------------------------------------------------------
if (!haveBinary('ffmpeg') || !haveBinary('ffprobe')) fail('ffmpeg/ffprobe not found on PATH');

async function probe(file) {
  const out = await run('ffprobe', [
    '-v', 'error', '-count_frames',
    '-show_entries', 'stream=index,codec_type,codec_name,profile,width,height,pix_fmt,r_frame_rate,avg_frame_rate,nb_read_frames,color_space,color_transfer,color_primaries,color_range,channels,sample_rate,bit_rate:format=duration,bit_rate,size',
    '-of', 'json', file,
  ]);
  return JSON.parse(out);
}

async function extractStills(file, n) {
  const info = await probe(file);
  const dur = Number(info.format.duration);
  const base = file.replace(/\.mp4$/i, '');
  const files = [];
  for (let k = 0; k < n; k++) {
    const ts = ((k + 0.5) / n) * dur;
    const png = `${base}-still-${k + 1}.png`;
    await run('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-ss', ts.toFixed(4), '-i', file, '-frames:v', '1', '-update', '1', png]);
    files.push({ t: +ts.toFixed(3), png });
  }
  return files;
}

if (has('--stills-only')) {
  if (!fs.existsSync(OUT)) fail(`--stills-only: ${OUT} does not exist`);
  for (const s of await extractStills(OUT, STILLS)) log(`still t=${s.t}s -> ${s.png}`);
  process.exit(0);
}

/** Fail loudly (before anything is rendered) if NVENC is not usable: never fall back to libx264. */
async function assertNvenc() {
  try {
    await run('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'color=c=black:s=256x256:r=60:d=0.2', '-c:v', 'h264_nvenc', '-preset', 'p7', '-f', 'null', '-']);
  } catch (e) {
    fail(`h264_nvenc is not available (refusing to fall back to the CPU encoder libx264):\n${e.message}`);
  }
}

// ------------------------------------------------------------------------------------------------
// Browser + in-page grabber
// ------------------------------------------------------------------------------------------------
const { openApp } = await import('./browser.mjs');

async function installGrabber(page, sinkUrl) {
  await page.evaluate(
    async ({ w, h, url, mode, frameBytes }) => {
      const tp = window.__tp;
      const r = tp.ctx.renderer;
      const gl = r.getContext();
      // one message buffer: 4-byte frame index + pixels (readPixels writes straight into it)
      const msg = new Uint8Array(4 + frameBytes);
      const head = new DataView(msg.buffer, 0, 4);
      const buf = msg.subarray(4);
      const rgba = mode === 'rgba' ? buf : new Uint8Array(w * h * 4); // canvas bytes (tests / reference)
      const readRGBA = () => {
        r.setRenderTarget(null);
        gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, rgba);
        return rgba;
      };

      // ---- GPU RGBA -> yuv420p (BT.709, limited range), written as one RGBA8 target of w/4 x 1.5h texels
      // whose bytes, read bottom row first, ARE the planar Y, U, V planes of the top-down image. ----
      let readYUV = null;
      if (mode === 'yuv') {
        const sh = (type, src) => {
          const s = gl.createShader(type);
          gl.shaderSource(s, src);
          gl.compileShader(s);
          if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error('yuv shader: ' + gl.getShaderInfoLog(s));
          return s;
        };
        const prog = gl.createProgram();
        gl.attachShader(prog, sh(gl.VERTEX_SHADER, `#version 300 es
          void main() { vec2 p = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2)); gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0); }`));
        gl.attachShader(prog, sh(gl.FRAGMENT_SHADER, `#version 300 es
          precision highp float; precision highp int; precision highp sampler2D;
          uniform sampler2D src;
          uniform int W, H;
          out vec4 o;
          // pixel (x, y) of the top-down image; the texture is bottom-up like the canvas
          vec3 px(int x, int y) { return texelFetch(src, ivec2(x, H - 1 - y), 0).rgb; }
          float luma(vec3 c) { return dot(c, vec3(0.2126, 0.7152, 0.0722)); }
          void main() {
            int x = int(gl_FragCoord.x), row = int(gl_FragCoord.y);
            vec4 v;
            if (row < H) {                       // Y plane: 4 luma samples per texel
              for (int k = 0; k < 4; k++) v[k] = (16.0 + 219.0 * luma(px(4 * x + k, row))) / 255.0;
            } else {                             // U then V plane: each texel row holds two chroma rows
              int rr = row - H, q = H / 4, hw = W / 8;
              bool isV = rr >= q;
              if (isV) rr -= q;
              int cy = 2 * rr + (x >= hw ? 1 : 0);
              int cx0 = (x % hw) * 4;
              for (int k = 0; k < 4; k++) {
                int cx = cx0 + k;
                vec3 c = 0.25 * (px(2 * cx, 2 * cy) + px(2 * cx + 1, 2 * cy) + px(2 * cx, 2 * cy + 1) + px(2 * cx + 1, 2 * cy + 1));
                float yl = luma(c);
                float d = isV ? (c.r - yl) / 1.5748 : (c.b - yl) / 1.8556;
                v[k] = (128.0 + 224.0 * d) / 255.0;
              }
            }
            o = v;
          }`));
        gl.linkProgram(prog);
        if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) throw new Error('yuv program link: ' + gl.getProgramInfoLog(prog));
        const tex = (tw, th) => {
          const t = gl.createTexture();
          gl.bindTexture(gl.TEXTURE_2D, t);
          gl.texStorage2D(gl.TEXTURE_2D, 1, gl.RGBA8, tw, th);
          gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
          gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
          return t;
        };
        const fbo = (t) => {
          const f = gl.createFramebuffer();
          gl.bindFramebuffer(gl.FRAMEBUFFER, f);
          gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, t, 0);
          if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE) throw new Error('yuv framebuffer incomplete');
          return f;
        };
        const srcTex = tex(w, h);
        const ow = w / 4, oh = (h * 3) / 2;
        const outFbo = fbo(tex(ow, oh));
        const vao = gl.createVertexArray();
        const uSrc = gl.getUniformLocation(prog, 'src'), uW = gl.getUniformLocation(prog, 'W'), uH = gl.getUniformLocation(prog, 'H');
        r.resetState();
        readYUV = () => {
          r.setRenderTarget(null);
          r.resetState(); // known GL defaults (no blend/depth/scissor/cull), three's cache invalidated
          gl.bindFramebuffer(gl.FRAMEBUFFER, null);
          gl.activeTexture(gl.TEXTURE0);
          gl.bindTexture(gl.TEXTURE_2D, srcTex);
          gl.copyTexSubImage2D(gl.TEXTURE_2D, 0, 0, 0, 0, 0, w, h); // canvas -> texture, on the GPU
          gl.bindFramebuffer(gl.FRAMEBUFFER, outFbo);
          gl.viewport(0, 0, ow, oh);
          gl.useProgram(prog);
          gl.uniform1i(uSrc, 0);
          gl.uniform1i(uW, w);
          gl.uniform1i(uH, h);
          gl.bindVertexArray(vao);
          gl.drawArrays(gl.TRIANGLES, 0, 3);
          gl.readPixels(0, 0, ow, oh, gl.RGBA, gl.UNSIGNED_BYTE, buf);
          gl.bindVertexArray(null);
          r.resetState(); // hand the context back to three.js in a state it knows
          return buf;
        };
        readYUV();
        const err = gl.getError();
        if (err) throw new Error(`yuv conversion: GL error 0x${err.toString(16)}`);
      }

      /** CPU reference of the GPU conversion, from the RGBA canvas bytes (bottom-up). Returns max |diff| per plane. */
      const checkYUV = () => {
        const src = readRGBA();
        const yuv = readYUV().slice();
        const at = (x, y) => ((h - 1 - y) * w + x) * 4;
        let maxY = 0, maxC = 0, sumC = 0;
        for (let y = 0; y < h; y++) {
          for (let x = 0; x < w; x++) {
            const p = at(x, y);
            const L = 0.2126 * src[p] + 0.7152 * src[p + 1] + 0.0722 * src[p + 2];
            const d = Math.abs(yuv[y * w + x] - (16 + (219 * L) / 255));
            if (d > maxY) maxY = d;
          }
        }
        const cw = w / 2, ch = h / 2;
        for (let y = 0; y < ch; y++) {
          for (let x = 0; x < cw; x++) {
            let R = 0, G = 0, B = 0;
            for (const [dx, dy] of [[0, 0], [1, 0], [0, 1], [1, 1]]) {
              const p = at(2 * x + dx, 2 * y + dy);
              R += src[p] / 4; G += src[p + 1] / 4; B += src[p + 2] / 4;
            }
            const L = 0.2126 * R + 0.7152 * G + 0.0722 * B;
            const U = 128 + (224 * (B - L)) / 1.8556 / 255, V = 128 + (224 * (R - L)) / 1.5748 / 255;
            const du = Math.abs(yuv[w * h + y * cw + x] - U), dv = Math.abs(yuv[w * h + cw * ch + y * cw + x] - V);
            maxC = Math.max(maxC, du, dv);
            sumC += du + dv;
          }
        }
        return { maxY: +maxY.toFixed(3), maxC: +maxC.toFixed(3), meanC: +(sumC / (cw * ch * 2)).toFixed(4) };
      };
      const ws = new WebSocket(url);
      ws.binaryType = 'arraybuffer';
      await new Promise((res, rej) => { ws.onopen = res; ws.onerror = () => rej(new Error('frame socket failed to open')); });
      const waiting = new Map(); // frame index -> { resolve, reject }
      let wsError = null;
      ws.onmessage = (e) => {
        const [kind, rest] = [String(e.data).slice(0, 3), String(e.data).slice(3)];
        if (kind === 'ok ') {
          const i = Number(rest);
          waiting.get(i)?.resolve();
          waiting.delete(i);
        } else {
          wsError = new Error(`frame sink: ${e.data}`);
          for (const w of waiting.values()) w.reject(wsError);
          waiting.clear();
        }
      };
      ws.onclose = () => {
        wsError ??= new Error('frame socket closed');
        for (const w of waiting.values()) w.reject(wsError);
        waiting.clear();
      };
      let inflight = [];
      const read = mode === 'yuv' ? readYUV : readRGBA;
      window.__cap = {
        checkYUV: mode === 'yuv' ? checkYUV : null,
        info: () => ({ dbw: gl.drawingBufferWidth, dbh: gl.drawingBufferHeight, attrs: gl.getContextAttributes(), dpr: window.devicePixelRatio, cssW: tp.ctx.canvas.clientWidth, cssH: tp.ctx.canvas.clientHeight }),
        render: (t, dt) => {
          if (!tp.cinematicFrame(t, dt)) throw new Error('no cinematic (src/cinematic.ts missing?)');
        },
        read,
        /** FNV-1a over the frame (for the verification tests). */
        hash: () => {
          const u = new Uint32Array(buf.buffer);
          let hh = 0x811c9dc5;
          for (let i = 0; i < u.length; i++) hh = Math.imul(hh ^ u[i], 0x01000193);
          return (hh >>> 0).toString(16);
        },
        /** Render frame i at t, read it back and send it; at most 2 frames in flight (send() copies the bytes). */
        frame: async (i, t, dt) => {
          if (wsError) throw wsError;
          window.__cap.render(t, dt);
          read();
          head.setUint32(0, i, true);
          const p = new Promise((resolve, reject) => waiting.set(i, { resolve, reject }));
          ws.send(msg);
          inflight.push(p);
          if (inflight.length > 2) await inflight.shift();
        },
        flush: async () => {
          const all = inflight;
          inflight = [];
          await Promise.all(all);
        },
        raw: () => Array.from(readRGBA()), // tests only (slow)
      };
    },
    { w: W, h: H, url: sinkUrl, mode: GRAB, frameBytes: FRAME_BYTES },
  );
  const info = await page.evaluate(() => window.__cap.info());
  if (info.dbw !== W || info.dbh !== H) throw new Error(`drawing buffer is ${info.dbw}x${info.dbh}, expected ${W}x${H} (dpr ${info.dpr}, css ${info.cssW}x${info.cssH})`);
  if (!info.attrs.preserveDrawingBuffer) log('note: preserveDrawingBuffer is off; readPixels still reads the frame just rendered');
  return info;
}

/** Decode a PNG (or any image) to raw RGBA with ffmpeg. */
async function decodeRGBA(file) {
  const child = spawnTracked('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-i', file, '-f', 'rawvideo', '-pix_fmt', 'rgba', 'pipe:1']);
  const chunks = [];
  child.stdout.on('data', (d) => chunks.push(d));
  child.stdin.end();
  const { code } = await child.done;
  if (code !== 0) throw new Error(child.stderrTail());
  return Buffer.concat(chunks);
}

// ------------------------------------------------------------------------------------------------
// main
// ------------------------------------------------------------------------------------------------
const query = ['shot=1', ONLY && `only=${ONLY}`].filter(Boolean).join('&');
const app = await openApp({ width: W, height: H, query });
const { page } = app;
const die = (msg) => app.close(1, msg);

const DURATION = await page.evaluate(() => window.__tp.duration);
if (!DURATION) await die('no src/cinematic.ts (window.__tp.duration is 0)');
const FROM = Number(one('--from', '0'));
const TO = Math.min(Number(one('--to', String(DURATION))), DURATION);
const N = Math.round((TO - FROM) * FPS);
if (!(N > 0)) await die(`empty range --from ${FROM} --to ${TO}`);
const DT = 1 / FPS;
const tAt = (i) => FROM + i / FPS;

// The camera path self-check, on the exact module the page renders with.
const report = await page.evaluate(async () => (await import('/src/cinematic.ts')).checkCinematic());
printReport(report);

let nullSinkBytes = 0;
const sink = { write: async () => {} };
const { createFrameSink } = await import('./lib/frame-sink.mjs');
const frameSink = await createFrameSink({ write: (b, i) => sink.write(b, i) }, FRAME_BYTES);
process.on('exit', () => frameSink.close());
await installGrabber(page, frameSink.url);

// warm-up: compile every program, fill shadow maps / history buffers, settle anything that lags a frame
await page.evaluate(
  ({ from, dt }) => {
    const tp = window.__tp;
    tp.ctx.renderer.compile(tp.ctx.scene, tp.ctx.camera);
    for (let k = 30; k >= 1; k--) window.__cap.render(Math.max(0, from - k * dt), dt);
    for (let k = 0; k < 3; k++) window.__cap.render(from, dt);
    window.__cap.read();
  },
  { from: FROM, dt: DT },
);
await app.checkErrors();

// ---- quick grab sanity test (every run): deterministic, and frame N is not frame N-1 ----
{
  const h = await page.evaluate(
    ({ a, b, dt }) => {
      const c = window.__cap;
      const diff = (x, y) => { let n = 0; for (let i = 0; i < x.length; i++) if (x[i] !== y[i]) n++; return n; };
      c.render(a, dt); const A = c.read().slice(); const ha = c.hash();
      c.render(b, dt); const B = c.read().slice(); const hb = c.hash();
      c.render(a, dt); const A2 = c.read().slice(); const ha2 = c.hash();
      return { ha, hb, ha2, againDiff: diff(A, A2), nextDiff: diff(A, B), bytes: A.length };
    },
    { a: tAt(Math.min(N - 1, 1)), b: tAt(0), dt: DT },
  );
  // A few differing bytes when re-rendering the same t means some system reads a previous-frame buffer
  // (history). Harmless for a sequential capture (each frame is rendered once, in order, after warm-up),
  // but reported. Anything bigger is a real determinism bug.
  if (h.againDiff > h.bytes * 1e-4) await die(`non-deterministic frame: re-rendering the same t changed ${h.againDiff} bytes`);
  if (h.againDiff > 0) log(`grab check: WARNING ${h.againDiff} bytes differ when re-rendering the same t (a system samples a previous-frame buffer)`);
  if (N > 1 && h.nextDiff < h.bytes * 1e-3) await die(`grab returned (nearly) the same image for two different times (${h.nextDiff} bytes differ): stale frame?`);
  log(`grab check (${GRAB}): same t -> ${h.ha}/${h.ha2} (${h.againDiff} bytes differ), next frame ${h.hb} (${h.nextDiff} bytes differ)`);
  if (GRAB === 'yuv') {
    // GPU conversion vs a CPU reference on the same canvas bytes: plane layout, flip, matrix, range, rounding.
    const c = await page.evaluate(({ t, dt }) => { window.__cap.render(t, dt); return window.__cap.checkYUV(); }, { t: tAt(0), dt: DT });
    log(`yuv check vs CPU reference: max |dY| ${c.maxY}, max |dUV| ${c.maxC}, mean |dUV| ${c.meanC} (code values)`);
    if (c.maxY > 1 || c.maxC > 1 || c.meanC > 0.6) await die('GPU yuv420p conversion disagrees with the CPU reference');
  }
}

if (has('--verify')) {
  // Independent second grab: compositor screenshot of the canvas, decoded by ffmpeg, vs readPixels bytes.
  const dir = tempPath(path.join(ROOT, 'capture-tmp', `verify-${process.pid}`));
  fs.mkdirSync(dir, { recursive: true });
  const times = [tAt(0), tAt(Math.floor(N / 3)), tAt(Math.floor((2 * N) / 3)), tAt(N - 1)];
  let prev = null;
  for (const t of times) {
    const raw = await page.evaluate(({ t, dt }) => { window.__cap.render(t, dt); return window.__cap.raw(); }, { t, dt: DT });
    const png = path.join(dir, `shot-${t.toFixed(3)}.png`);
    await page.locator('#game').screenshot({ path: png });
    const shot = await decodeRGBA(png);
    // readPixels is bottom-up: compare row r of the screenshot with row H-1-r
    let sum = 0, max = 0, n = 0;
    for (let y = 0; y < H; y += 3) {
      const so = y * W * 4, ro = (H - 1 - y) * W * 4;
      for (let x = 0; x < W * 4; x += 4 * 3) {
        for (let c = 0; c < 3; c++) {
          const d = Math.abs(shot[so + x + c] - raw[ro + x + c]);
          sum += d; if (d > max) max = d; n++;
        }
      }
    }
    const mean = sum / n;
    const vsPrev = prev ? (() => { let s = 0, m = 0; for (let i = 0; i < raw.length; i += 997) { s += Math.abs(raw[i] - prev[i]); m++; } return s / m; })() : null;
    log(`verify t=${t.toFixed(3)}: screenshot ${shot.length / 4 === W * H ? `${W}x${H}` : 'WRONG SIZE'} vs readPixels: mean |diff| ${mean.toFixed(3)}, max ${max}` + (vsPrev !== null ? `; differs from previous grab by ${vsPrev.toFixed(2)}` : ''));
    if (shot.length !== W * H * 4) await die('screenshot has the wrong size');
    if (mean > 1.0) await die(`screenshot and readPixels disagree (mean ${mean.toFixed(2)}): colour/gamma or lag problem`);
    prev = raw;
  }
  // Each screenshot is taken right after rendering a NEW time, so a compositor that lagged one frame behind
  // would have returned the previous time's image and failed the comparison above.
  log('verify: OK (screenshot == readPixels within rounding, no lag, full size, same colours)');
}

if (has('--bench')) {
  const n = 30;
  const t0 = tAt(Math.floor(N / 2));
  const r = await page.evaluate(
    async ({ n, t0, dt }) => {
      const c = window.__cap;
      const gl = window.__tp.ctx.renderer.getContext();
      const time = async (f) => { const a = performance.now(); for (let i = 0; i < n; i++) await f(i); return (performance.now() - a) / n; };
      const render = await time((i) => { c.render(t0 + i * dt, dt); gl.finish(); gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array(4)); });
      const renderRead = await time((i) => { c.render(t0 + i * dt, dt); c.read(); });
      return { render, renderRead };
    },
    { n, t0, dt: DT },
  );
  sink.write = async (b) => { nullSinkBytes += b.length; };
  let a = performance.now();
  for (let i = 0; i < n; i++) await page.evaluate(({ i, t, dt }) => window.__cap.frame(i, t, dt), { i, t: t0 + i * DT, dt: DT });
  await page.evaluate(() => window.__cap.flush());
  const post = (performance.now() - a) / n;
  a = performance.now();
  for (let i = 0; i < n; i++) {
    await page.evaluate(({ t, dt }) => window.__cap.render(t, dt), { t: t0 + i * DT, dt: DT });
    await page.locator('#game').screenshot({ type: 'png' });
  }
  const shotPng = (performance.now() - a) / n;
  a = performance.now();
  for (let i = 0; i < n; i++) {
    await page.evaluate(({ t, dt }) => window.__cap.render(t, dt), { t: t0 + i * DT, dt: DT });
    await page.locator('#game').screenshot({ type: 'jpeg', quality: 100 });
  }
  const shotJpg = (performance.now() - a) / n;
  log(`bench (${W}x${H}, ms/frame): render ${r.render.toFixed(1)} | render+readPixels ${r.renderRead.toFixed(1)} | render+readPixels+WebSocket (pipelined, null sink) ${post.toFixed(1)} | render+screenshot png ${shotPng.toFixed(1)} | render+screenshot jpeg100 ${shotJpg.toFixed(1)}`);
  await app.close(0);
}

if (has('--verify')) await app.close(0);

// ---- encode ----
await assertNvenc();
fs.mkdirSync(path.dirname(OUT), { recursive: true });
const base = OUT.replace(/\.mp4$/i, '');
const videoTmp = tempPath(`${base}.video-tmp.mp4`);
const finalTmp = tempPath(`${base}.mux-tmp.mp4`);
const framesDir = `${base}-frames`;
if (has('--keep-frames')) fs.mkdirSync(framesDir, { recursive: true });

const encArgs = [
  '-hide_banner', '-loglevel', 'error', '-y',
  '-f', 'rawvideo', '-pix_fmt', GRAB === 'yuv' ? 'yuv420p' : 'rgba', '-s', `${W}x${H}`, '-framerate', String(FPS), '-i', 'pipe:0',
  '-map', '0:v',
  // yuv: already top-down BT.709 limited yuv420p from the GPU, passed to nvenc untouched.
  // rgba: readPixels rows are bottom-up; convert to limited-range BT.709 explicitly (swscale's default is BT.601).
  ...(GRAB === 'yuv' ? [] : ['-vf', 'vflip,scale=out_color_matrix=bt709:out_range=tv:flags=accurate_rnd+full_chroma_int+bitexact,format=yuv420p']),
  '-c:v', 'h264_nvenc', '-preset', 'p7', '-tune', 'hq', '-profile:v', 'high',
  '-rc', 'vbr', '-cq', String(CQ), '-b:v', '0', '-maxrate', '40M', '-bufsize', '80M',
  '-bf', '3', '-b_ref_mode', 'middle', '-spatial-aq', '1', '-temporal-aq', '1', '-rc-lookahead', '32', '-g', String(FPS * 2),
  '-color_primaries', 'bt709', '-color_trc', 'bt709', '-colorspace', 'bt709', '-color_range', 'tv',
  // nvenc does not always write the primaries/transfer into the SPS VUI; set all four in the bitstream itself
  '-bsf:v', 'h264_metadata=colour_primaries=1:transfer_characteristics=1:matrix_coefficients=1:video_full_range_flag=0',
  '-fps_mode', 'cfr', '-r', String(FPS), '-movflags', '+faststart', videoTmp,
];
if (has('--keep-frames')) {
  encArgs.push('-map', '0:v', '-vf', GRAB === 'yuv' ? 'scale=in_color_matrix=bt709:in_range=tv:flags=accurate_rnd+full_chroma_int,format=rgb24' : 'vflip', '-start_number', '0', path.join(framesDir, 'frame-%05d.png'));
}
const enc = spawnTracked('ffmpeg', encArgs);
enc.stdin.on('error', () => {}); // reported through enc.done
let encExited = false;
enc.done.then(({ code }) => {
  encExited = true;
  if (code !== 0 && !frameSink.error) die(`ffmpeg encoder exited with ${code} during capture:\n${enc.stderrTail()}`);
});
sink.write = (buf) =>
  new Promise((resolve, reject) => {
    if (encExited) return reject(new Error('encoder is gone'));
    if (enc.stdin.write(buf)) resolve();
    else enc.stdin.once('drain', resolve);
  });

log(`rendering ${N} frames (${FROM}s .. ${TO}s) at ${W}x${H} ${FPS} fps -> ${OUT}`);
const t0 = performance.now();
let lastT = t0, lastI = 0;
for (let i = 0; i < N; i++) {
  await page.evaluate(({ i, t, dt }) => window.__cap.frame(i, t, dt), { i, t: tAt(i), dt: DT });
  if (frameSink.error) await die(frameSink.error.message);
  if ((i + 1) % 60 === 0 || i === N - 1) {
    await app.checkErrors();
    const now = performance.now();
    const fps = ((i + 1 - lastI) * 1000) / (now - lastT);
    const avg = ((i + 1) * 1000) / (now - t0);
    const eta = (N - i - 1) / avg;
    log(`frame ${String(i + 1).padStart(5)}/${N}  t=${tAt(i).toFixed(2)}s  ${fps.toFixed(1)} fps (avg ${avg.toFixed(1)})  ETA ${eta.toFixed(0)}s`);
    lastT = now;
    lastI = i + 1;
  }
}
await page.evaluate(() => window.__cap.flush());
if (frameSink.written !== N) await die(`frame count mismatch: ${frameSink.written} written, ${N} expected`);
enc.stdin.end();
const { code: encCode } = await enc.done;
if (encCode !== 0) await die(`ffmpeg encoder failed (${encCode}):\n${enc.stderrTail()}`);
const renderSecs = (performance.now() - t0) / 1000;
log(`encoded ${N} frames in ${renderSecs.toFixed(1)}s = ${(N / renderSecs).toFixed(1)} frames/s (projected full film ${(Math.round(DURATION * FPS) / (N / renderSecs)).toFixed(0)}s)`);

// ---- audio ----
if (!has('--no-audio')) {
  const { writeAudioBed } = await import('./audio-bed.mjs');
  const wav = tempPath(`${base}.bed-tmp.wav`);
  const a0 = performance.now();
  const st = writeAudioBed(wav, { duration: DURATION });
  log(`sound bed: ${st.seconds}s ${st.sampleRate} Hz stereo, peak ${st.peakDb.toFixed(2)} dBFS, synthesised in ${((performance.now() - a0) / 1000).toFixed(2)}s`);
  const dur = N / FPS;
  const fi = Math.min(0.25, dur / 4), fo = Math.min(0.6, dur / 4);
  await run('ffmpeg', [
    '-hide_banner', '-loglevel', 'error', '-y', '-i', videoTmp, '-i', wav,
    '-map', '0:v:0', '-map', '1:a:0', '-c:v', 'copy',
    '-af', `atrim=start=${FROM}:end=${FROM + dur},asetpts=PTS-STARTPTS,afade=t=in:st=0:d=${fi},afade=t=out:st=${(dur - fo).toFixed(4)}:d=${fo}`,
    '-c:a', 'aac', '-b:a', '320k', '-ar', '48000', '-ac', '2', '-t', dur.toFixed(6), '-movflags', '+faststart', finalTmp,
  ]);
} else {
  fs.renameSync(videoTmp, finalTmp);
}
fs.rmSync(OUT, { force: true });
fs.renameSync(finalTmp, OUT);
keepTemp(finalTmp);

// ---- verify the file ----
const info = await probe(OUT);
const v = info.streams.find((s) => s.codec_type === 'video');
const a = info.streams.find((s) => s.codec_type === 'audio');
const [rn, rd] = v.r_frame_rate.split('/').map(Number);
log('ffprobe:', JSON.stringify({
  video: { codec: v.codec_name, profile: v.profile, size: `${v.width}x${v.height}`, pix_fmt: v.pix_fmt, fps: v.r_frame_rate, avg_fps: v.avg_frame_rate, frames: Number(v.nb_read_frames), color: `${v.color_space}/${v.color_transfer}/${v.color_primaries}/${v.color_range}`, kbps: Math.round(Number(v.bit_rate) / 1000) },
  audio: a ? { codec: a.codec_name, channels: a.channels, rate: a.sample_rate, kbps: Math.round(Number(a.bit_rate) / 1000) } : null,
  duration: Number(info.format.duration), sizeMB: +(Number(info.format.size) / 1e6).toFixed(1),
}));
const problems = [];
if (v.codec_name !== 'h264') problems.push(`codec ${v.codec_name}`);
if (v.width !== W || v.height !== H) problems.push(`size ${v.width}x${v.height}`);
if (rn / rd !== FPS) problems.push(`fps ${v.r_frame_rate}`);
if (Number(v.nb_read_frames) !== N) problems.push(`frames ${v.nb_read_frames} != ${N}`);
if (v.pix_fmt !== 'yuv420p') problems.push(`pix_fmt ${v.pix_fmt}`);
const colour = `${v.color_space}/${v.color_transfer}/${v.color_primaries}/${v.color_range}`;
if (colour !== 'bt709/bt709/bt709/tv') problems.push(`colour tags ${colour}`);
if (!has('--no-audio')) {
  if (!a) problems.push('no audio stream');
  else if (a.codec_name !== 'aac' || a.channels !== 2 || a.sample_rate !== '48000') problems.push(`audio ${a.codec_name} ${a.channels}ch ${a.sample_rate}`);
}
if (Math.abs(Number(info.format.duration) - N / FPS) > 0.05) problems.push(`duration ${info.format.duration} != ${N / FPS}`);
if (problems.length) await die(`output verification failed: ${problems.join('; ')}`);
log(`OK ${OUT}`);

if (STILLS > 0) for (const s of await extractStills(OUT, STILLS)) log(`still t=${(FROM + s.t).toFixed(2)}s -> ${s.png}`);
await app.close(0);
