// Dev server for the browser app. Proxies the queue service so pages, cookies,
// and /media stay same-origin (needed for sessions and Firefox Web Audio analysis).
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

const service = process.env.JUKEBOX_SERVICE ?? 'http://127.0.0.1:8980';
const proxy = Object.fromEntries(['/api', '/auth', '/media', '/healthz'].map((path) => [path, { target: service }]));

export default defineConfig({
  root: 'app',
  plugins: [react()],
  server: { host: '127.0.0.1', port: 5173, strictPort: true, proxy },
  build: { outDir: '../dist/app', emptyOutDir: true },
});
