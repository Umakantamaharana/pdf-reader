import { defineConfig } from 'vite';
import { crx } from '@crxjs/vite-plugin';
import manifest from './manifest.json';

// @crxjs handles MV3 bundling: it rewrites manifest paths, bundles the service
// worker + viewer as ES modules, and copies web_accessible_resources. PDF.js's
// worker and the ONNX/WASM assets are emitted locally so nothing is loaded
// remotely (required by the MV3 CSP).
export default defineConfig({
  plugins: [crx({ manifest })],
  resolve: {
    alias: {
      // kokoro-js statically imports these Node built-ins on a dead (server)
      // path; stub them so the browser bundle resolves.
      'fs/promises': '/src/shim/node-empty.ts',
      path: '/src/shim/node-empty.ts',
    },
  },
  build: {
    target: 'esnext', // top-level await + WASM in the viewer/offscreen docs
    rollupOptions: {
      input: {
        viewer: 'src/viewer/viewer.html',
        settings: 'src/ui/settings.html',
        popup: 'src/ui/popup.html',
        offscreen: 'src/offscreen/offscreen.html',
      },
    },
  },
  // Keep heavy, pre-built WASM/ONNX out of the dep optimizer.
  optimizeDeps: { exclude: ['kokoro-js', 'pdfjs-dist'] },
  worker: { format: 'es' },
});
