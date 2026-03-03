import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Vite config for the standalone admin SPA.
// - Root: client/admin
// - Base path: /admin/
// - Output: server/public/admin (served by Express at /admin)
export default defineConfig({
  root: __dirname,
  base: '/admin/',
  plugins: [
    react({
      jsxRuntime: 'automatic',
    }),
  ],
  define: {
    // Avoid bundling any real process.env into the browser build.
    'process.env': {},
  },
  build: {
    outDir: path.resolve(__dirname, '../../server/public/admin'),
    emptyOutDir: true,
    rollupOptions: {
      input: path.resolve(__dirname, 'index.html'),
    },
  },
});

