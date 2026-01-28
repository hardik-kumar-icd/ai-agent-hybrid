import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  plugins: [
    react({
      // Process JSX files
      include: '**/*.{jsx,js}',
      // Use automatic JSX runtime - but ensure React is available
      jsxRuntime: 'automatic',
    }),
  ],
  // Define process.env as empty object to prevent browser errors
  define: {
    'process.env': '{}',
  },
  build: {
    lib: {
      entry: path.resolve(__dirname, 'src/widget.jsx'),
      name: 'VisorAIWidget',
      fileName: 'widget.bundle',
      formats: ['umd'],
    },
    // Inline all CSS in the bundle
    cssCodeSplit: false,
    rollupOptions: {
      // React and ReactDOM are external (loaded from CDN)
      external: ['react', 'react-dom'],
      output: {
        globals: {
          react: 'React',
          'react-dom': 'ReactDOM',
        },
        // Ensure proper module format
        format: 'umd',
      },
    },
  },
});
