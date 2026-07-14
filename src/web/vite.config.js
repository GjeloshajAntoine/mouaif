// Vite config for the mobile UI. Run `npm run build:web` to write
// src/web/dist/; the Node server (src/index.js) serves that directory
// at /web/. The dev script (`npm run dev:web`) starts Vite on :5173
// with HMR for optional browser-side development; the Node server is
// not involved in that path.
import { defineConfig } from 'vite';
import preact from '@preact/preset-vite';

export default defineConfig({
  root: 'src/web',
  base: '/web/',
  plugins: [preact()],
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    sourcemap: false,
    target: 'es2020',
    rollupOptions: {
      output: {
        // Vite emits assets/<filename> by default; we keep that so the
        // HTML <link> and <script> tags line up with the disk layout.
        entryFileNames: 'assets/index.js',
        chunkFileNames: 'assets/index-[hash].js',
        assetFileNames: 'assets/index-[hash][extname]'
      }
    }
  },
  server: {
    port: 5173,
    strictPort: false
  }
});
