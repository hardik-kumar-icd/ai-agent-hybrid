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
    // Plugin to inline all CSS into JS bundle (CSS injected programmatically)
    {
      name: 'inline-css',
      writeBundle(options, bundle) {
        // Find all CSS assets
        const cssAssets = Object.keys(bundle).filter(key => 
          bundle[key].type === 'asset' && key.endsWith('.css')
        );
        
        if (cssAssets.length > 0) {
          // Get the main JS bundle file name
          const jsFileName = options.file || 'widget.bundle.umd.js';
          const jsPath = path.resolve(options.dir || __dirname + '/dist', jsFileName);
          
          // Read the JS bundle file
          const fs = require('fs');
          let jsCode = fs.readFileSync(jsPath, 'utf-8');
          
          // Combine all CSS content from CSS files
          const allCss = cssAssets
            .map(key => {
              const cssPath = path.resolve(options.dir || __dirname + '/dist', key);
              return fs.readFileSync(cssPath, 'utf-8');
            })
            .join('\n');
          
          // Inject CSS injection code at the start of the bundle
          const cssInjectionCode = `(function(){if(typeof document==="undefined")return;const styleId="visor-ai-widget-styles";if(document.getElementById(styleId))return;const style=document.createElement("style");style.id=styleId;style.textContent=${JSON.stringify(allCss)};document.head.appendChild(style);})();`;
          
          jsCode = cssInjectionCode + jsCode;
          
          // Write updated JS bundle
          fs.writeFileSync(jsPath, jsCode, 'utf-8');
          
          // Delete CSS files (they're now inlined)
          cssAssets.forEach(key => {
            const cssPath = path.resolve(options.dir || __dirname + '/dist', key);
            if (fs.existsSync(cssPath)) {
              fs.unlinkSync(cssPath);
            }
          });
        }
      },
    },
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
    // Inline all CSS in the bundle (no separate CSS file)
    cssCodeSplit: false,
    // Don't emit CSS files - CSS is injected programmatically via widget-styles.js
    cssMinify: true,
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
