import { defineConfig } from 'vite';

// Creations are served from their own sealed address, so:
// - every path is relative (the creation doesn't know its address in advance),
// - no inline scripts (the frame's security policy forbids them).
export default defineConfig({
  base: './',
  build: {
    target: 'es2022',
    modulePreload: { polyfill: false },
    assetsInlineLimit: 0,
    // three.js alone is ~600 KB (≈150 KB compressed); the creation budget is far larger.
    chunkSizeWarningLimit: 1500,
  },
});
