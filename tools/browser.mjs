// Shared launcher for every tool that needs the app in a headless browser.
// Guarantees: (1) the RTX GPU is really used - asserted from the WebGL context, never inferred from
// flags; (2) the vite server and the browser are torn down on EVERY exit path.
import { chromium } from 'playwright';
import { createServer } from 'vite';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/**
 * @param {{ width?: number, height?: number, query?: string, allowSoftware?: boolean, timeout?: number }} opts
 * @returns {Promise<{ page: import('playwright').Page, url: string, close: (code?: number, why?: unknown) => Promise<never>, checkErrors: () => Promise<void> }>}
 */
export async function openApp(opts = {}) {
  const { width = 1280, height = 720, query = 'shot=1', allowSoftware = process.argv.includes('--allow-software'), timeout = 120000 } = opts;
  let server = null;
  let browser = null;
  let closing = false;
  const close = async (code = 0, why) => {
    if (closing) return;
    closing = true;
    if (why) console.error('[teardown]', why);
    try { await browser?.close(); } catch {}
    try { await server?.close(); } catch {}
    process.exit(code); // close() does not evict live keep-alive sockets
  };
  process.on('SIGINT', () => close(130, 'interrupted'));
  process.on('SIGTERM', () => close(143, 'terminated'));
  process.on('uncaughtException', (e) => close(1, e));
  process.on('unhandledRejection', (e) => close(1, e));

  server = await createServer({
    root: ROOT,
    logLevel: 'error',
    server: { host: '127.0.0.1', port: 5300 + Math.floor(Math.random() * 600), strictPort: false, hmr: false, watch: null },
  });
  await server.listen();
  const addr = server.httpServer.address();
  const url = `http://127.0.0.1:${addr.port}/?${query}`;

  browser = await chromium.launch({
    headless: true,
    args: [
      '--use-angle=d3d11', // NVIDIA + Windows
      '--use-gl=angle',
      '--enable-gpu',
      '--enable-gpu-rasterization',
      '--ignore-gpu-blocklist',
      '--force_high_performance_gpu',
      '--autoplay-policy=no-user-gesture-required',
    ],
  });
  const page = await browser.newPage({ viewport: { width, height }, deviceScaleFactor: 1 });
  const consoleErrors = [];
  page.on('console', (m) => {
    if (m.type() === 'error') consoleErrors.push(m.text());
  });
  page.on('pageerror', (e) => consoleErrors.push(String(e)));

  await page.goto(url, { waitUntil: 'load', timeout });

  const gpu = await page.evaluate(() => {
    const gl = document.createElement('canvas').getContext('webgl2');
    const dbg = gl?.getExtension('WEBGL_debug_renderer_info');
    return dbg ? gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : 'unknown';
  });
  console.log('[gpu]', gpu);
  if (/swiftshader|llvmpipe|software|basic render|unknown/i.test(gpu) && !allowSoftware) {
    await close(1, `CPU rasteriser: ${gpu} (pass --allow-software to override)`);
  }

  await page.evaluate(() => window.__tp.ready);

  /** Shader compile/link errors and page errors are fatal: a lenient fallback would hide them. */
  const checkErrors = async () => {
    const appErrors = await page.evaluate(() => window.__tp.errors);
    const all = [...appErrors, ...consoleErrors];
    if (all.length) await close(1, 'page errors:\n' + all.join('\n---\n'));
  };

  return { page, url, close, checkErrors };
}
