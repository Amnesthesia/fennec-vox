import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { resolve } from 'path';

export default defineConfig({
  plugins: [react()],
  root: resolve(__dirname, 'src/web'),
  publicDir: resolve(__dirname, 'src/renderer/public'),
  resolve: {
    alias: { '@shared': resolve(__dirname, 'src/shared') },
  },
  build: {
    outDir: resolve(__dirname, 'dist/web'),
    emptyOutDir: true,
  },
  optimizeDeps: {
    // pdfjs-dist ships CJS; force it through Vite's pre-bundler
    include: ['pdfjs-dist'],
  },
});
