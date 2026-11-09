// Production build entry point. Astro owns the listener, routes and static assets.
import { getRuntime, closeRuntime } from '../src/server/runtime.ts';
process.env.ASTRO_NODE_AUTOSTART = 'disabled';
const runtime = getRuntime();
let stopping = false;
try {
  const { startServer } = await import('../dist/server/entry.mjs');
  const app = startServer();
  async function stop() {
    if (stopping) return;
    stopping = true;
    runtime.stopScheduling();
    runtime.transport.close();
    await app.server.stop();
    await closeRuntime();
  }
  process.once('SIGTERM', () => void stop());
  process.once('SIGINT', () => void stop());
  await app.done;
  await closeRuntime();
} catch (error) { await closeRuntime(); throw error; }
