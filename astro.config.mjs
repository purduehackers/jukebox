import { defineConfig } from 'astro/config';
import node from '@astrojs/node';

export default defineConfig({
  output: 'server',
  session: false,
  adapter: node({ mode: 'standalone' }),
  integrations: [{
    name: 'jukebox-authority',
    hooks: {
      'astro:server:setup': async ({ server }) => {
        const { getRuntime, closeRuntime } = await import('./src/server/runtime.ts');
        getRuntime();
        server.httpServer?.once('close', closeRuntime);
      },
    },
  }],
  server: { host: '127.0.0.1', port: 5173 },
  // Private .env.local is loaded explicitly by the supervisor, never by Vite.
  vite: { envDir: './.local/astro-env', ssr: { external: ['bun:sqlite'] } },
});
