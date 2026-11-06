// Dev server for the browser app. Proxies the queue service so pages, cookies,
// and /media stay same-origin (needed for sessions and Firefox Web Audio analysis).
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';
import { localOriginRedirect } from './src/server/local-origin.ts';

const service = process.env.JUKEBOX_SERVICE ?? 'http://127.0.0.1:8980';
const proxy = Object.fromEntries(['/api', '/auth', '/media', '/healthz'].map((path) => [path, { target: service }]));

export default defineConfig({
  root: 'app',
  plugins: [{
    name: 'canonical-local-origin',
    configureServer(server) {
      const configured = process.env.JUKEBOX_ORIGIN ?? (process.env.JUKEBOX_PHID_REDIRECT_URI
        ? new URL(process.env.JUKEBOX_PHID_REDIRECT_URI).origin
        : `http://127.0.0.1:${server.config.server.port}`);
      server.middlewares.use((req, res, next) => {
        const target = localOriginRedirect(req.headers.host, req.url ?? '/', configured);
        if (target && (req.method === 'GET' || req.method === 'HEAD')) {
          res.writeHead(302, { location: target, 'cache-control': 'no-store' });
          res.end();
          return;
        }
        next();
      });
    },
  }, react()],
  server: { host: '127.0.0.1', port: 5173, strictPort: true, proxy },
  build: { outDir: '../dist/app', emptyOutDir: true },
});
