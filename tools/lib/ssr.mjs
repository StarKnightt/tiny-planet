// Load the game's TypeScript modules in plain Node (no browser, no listening server) through vite's
// SSR loader. Used for numeric checks that do not need rendering, e.g. the cinematic path self-check.
//
//   import { withSrc } from './lib/ssr.mjs';
//   await withSrc(async (load) => { const cine = await load('/src/cinematic.ts'); ... });
//
// The vite instance is always closed, also when `fn` throws.
import { createServer } from 'vite';
import { ROOT } from './root.mjs';

export async function withSrc(fn) {
  const server = await createServer({
    root: ROOT,
    logLevel: 'error',
    appType: 'custom',
    optimizeDeps: { noDiscovery: true, include: [] },
    server: { middlewareMode: true, hmr: false, watch: null },
  });
  try {
    return await fn((id) => server.ssrLoadModule(id));
  } finally {
    await server.close();
  }
}
