import { defineConfig } from 'astro/config';
import node from '@astrojs/node';
import react from '@astrojs/react';
import tailwindcss from '@tailwindcss/vite';

export default defineConfig({
  output: 'server',
  session: false,
  adapter: node({ mode: 'standalone' }),
  integrations: [react(), {
    name: 'jukebox-authority',
    hooks: {
      // The authority service's HTTP surface is declared here instead of as
      // one-line files under src/pages; each entrypoint delegates to
      // transport.handle, which owns the real method+path routing.
      'astro:config:setup': ({ injectRoute }) => {
        injectRoute({ pattern: '/auth/[...slug]', entrypoint: './src/server/routes/auth.ts', prerender: false });
        injectRoute({ pattern: '/api/v1/[...slug]', entrypoint: './src/server/routes/api.ts', prerender: false });
        injectRoute({ pattern: '/media/[assetId]', entrypoint: './src/server/routes/media.ts', prerender: false });
        for (const pattern of ['/metrics', '/healthz']) {
          injectRoute({ pattern, entrypoint: './src/server/routes/probes.ts', prerender: false });
        }
        // /readyz has its own probe logic (DB + audio worker), not a transport shim.
        injectRoute({ pattern: '/readyz', entrypoint: './src/server/routes/readyz.ts', prerender: false });
      },
      'astro:server:setup': async ({ server }) => {
        const { getRuntime, closeRuntime, installShutdownBackstop } = await import('./src/server/runtime.ts');
        // Dev restarts re-run this hook in the same process; settle any previous
        // runtime first so the new server never reuses a closing transport.
        await closeRuntime();
        getRuntime();
        installShutdownBackstop();
        server.httpServer?.once('close', closeRuntime);
      },
    },
  }],
  server: { host: '127.0.0.1', port: 5173 },
  // Private .env.local is loaded explicitly by the supervisor, never by Vite.
  vite: {
    plugins: [tailwindcss()],
    envDir: './.local/astro-env',
    // Astro 7 only pre-bundles the renderer's client entrypoint; the renderer's
    // own optimizeDeps.include (react-dom/client) is not applied, so the island's
    // renderer-url chain serves raw CJS react-dom/client.js to the browser.
    optimizeDeps: { include: ['react', 'react-dom', 'react-dom/client', 'react/jsx-runtime', 'react/jsx-dev-runtime'] },
    // @purduehackers/time ships a nested React 18; keep a single React copy.
    resolve: { dedupe: ['react', 'react-dom'] },
    ssr: { external: ['bun:sqlite'] },
  },
});
