import { defineConfig } from 'vite';

export default defineConfig({
  // relative asset URLs, so dist/ works from any static host or sub-path
  base: './',
  // three is plain ESM: skip dep pre-bundling so several dev servers (parallel
  // screenshot runs) never race on node_modules/.vite.
  optimizeDeps: { noDiscovery: true, include: [] },
  build: { target: 'es2022', chunkSizeWarningLimit: 2000 },
  server: { host: '127.0.0.1' },
});
