import path from 'path';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { defineConfig } from 'vite';

const rawPort = process.env.PORT ?? '5173';

const port = Number(rawPort);

if (Number.isNaN(port) || port <= 0) {
  throw new Error(`Invalid PORT value: "${rawPort}"`);
}

const requestedBasePath = process.env.BASE_PATH ?? '/';
const basePath = requestedBasePath.startsWith('/')
  ? requestedBasePath.endsWith('/') ? requestedBasePath : `${requestedBasePath}/`
  : `/${requestedBasePath.endsWith('/') ? requestedBasePath : `${requestedBasePath}/`}`;
const apiProxy = process.env.COREX_EXTERNAL_DEV === '1'
  ? {
      '/api': {
        target: process.env.API_ORIGIN || 'http://127.0.0.1:8080',
        changeOrigin: true,
      },
    }
  : undefined;

export default defineConfig({
  base: basePath,
  plugins: [
    react(),
    tailwindcss(),
  ],
  resolve: {
    alias: {
      '@': path.resolve(import.meta.dirname, 'src'),
      '@assets': path.resolve(
        import.meta.dirname,
        '..',
        '..',
        'attached_assets',
      ),
    },
    dedupe: ['react', 'react-dom'],
  },
  root: path.resolve(import.meta.dirname),
  build: {
    outDir: path.resolve(import.meta.dirname, 'dist/public'),
    emptyOutDir: true,
  },
  worker: {
    format: 'es',
  },
  server: {
    port,
    strictPort: true,
    host: '0.0.0.0',
    allowedHosts: true,
    proxy: apiProxy,
    fs: {
      strict: true,
    },
  },
  preview: {
    port,
    host: '0.0.0.0',
    allowedHosts: true,
  },
});
