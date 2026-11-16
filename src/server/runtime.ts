/** One queue authority per Bun process. Never instantiate during an Astro build. */
import { mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { FakeIdentity, FakeMedia, FakeSource, systemClock } from '../adapters/fakes.ts';
import { fixtureMatchingSource } from '../adapters/matching-fixtures.ts';
import { phidFromEnv } from '../adapters/phid.ts';
import { LiveCatalog } from '../adapters/live-catalog.ts';
import { MatchingSource } from '../adapters/matching-source.ts';
import { WorkerAdapter, proxyMedia } from '../adapters/worker.ts';
import type { SourcePort, MediaPort, IdentityPort } from '../core/ports.ts';
import { validateProduction } from './production.ts';
import { createTransport, type TransportOptions } from './transport.ts';
import { JukeboxService } from './service.ts';

export function createRuntime(env = process.env) {
  const data = resolve(env.JUKEBOX_SERVICE_DATA ?? '.local/service');
  const devAuth = env.JUKEBOX_DEV_AUTH === '1';
  const fixtureMedia = env.JUKEBOX_FIXTURE_MEDIA === '1';
  const fixtureMatching = env.JUKEBOX_FIXTURE_MATCHING === '1';
  validateProduction(env, { data: env.JUKEBOX_SERVICE_DATA ?? '.local/service', devAuth, fixtures: fixtureMedia || fixtureMatching });
  let identity: IdentityPort | null = phidFromEnv(env);
  if (devAuth) {
    if (identity) throw Error('Refusing fake sign-in while PH ID is configured');
    identity = new FakeIdentity();
  }
  if (!identity) throw Error('Configure PH ID or explicitly set JUKEBOX_DEV_AUTH=1 for isolated tests');
  const origin = env.JUKEBOX_ORIGIN ?? (env.JUKEBOX_PHID_REDIRECT_URI ? new URL(env.JUKEBOX_PHID_REDIRECT_URI).origin : `http://127.0.0.1:${env.PORT ?? '5173'}`);
  if (env.JUKEBOX_PHID_REDIRECT_URI && new URL(env.JUKEBOX_PHID_REDIRECT_URI).origin !== origin) throw Error('JUKEBOX_ORIGIN must match the PH ID callback origin');
  let source: SourcePort, media: MediaPort, mediaProxy: TransportOptions['mediaProxy'];
  const workerUrl = env.JUKEBOX_WORKER_URL ?? 'http://127.0.0.1:8971';
  if (fixtureMatching) { source = fixtureMatchingSource(); media = new FakeMedia(); }
  else if (fixtureMedia) {
    const fake = new FakeSource();
    for (const [name, durationSec] of [['master', 3600], ['request', 4], ['song', 360], ['aac', 8]] as const) fake.add(`fixture:${name}`, { title: `fixture:${name}`, durationSec });
    source = fake; media = new FakeMedia();
  } else {
    const worker = new WorkerAdapter({ baseUrl: workerUrl });
    source = new MatchingSource(worker, new LiveCatalog({ spotifyClientId: env.JUKEBOX_SPOTIFY_CLIENT_ID, spotifyClientSecret: env.JUKEBOX_SPOTIFY_CLIENT_SECRET, appleDeveloperToken: env.JUKEBOX_APPLE_MUSIC_DEVELOPER_TOKEN }), worker);
    media = worker;
    mediaProxy = (id, request) => proxyMedia(workerUrl, id, request);
  }
  mkdirSync(data, { recursive: true });
  const service = new JukeboxService({ dbPath: join(data, 'state.sqlite3'), clock: systemClock, source, media, adminKeys: env.JUKEBOX_ADMIN_KEYS?.split(',').filter(Boolean) });
  const transport = createTransport({ service, identity, origin, mediaProxy });
  const timer = setInterval(() => void service.reconcile().catch(error => console.error('[jukebox] reconcile', error)), 1000);
  timer.unref();
  let closed = false;
  console.log(`Jukebox authority: ${identity.kind === 'fake' ? 'FAKE local sign-in' : 'PH ID'}; ${fixtureMedia || fixtureMatching ? 'EXPLICIT FIXTURE MEDIA' : `audio worker ${workerUrl}; live catalog matching`}`);
  return { service, transport, origin, stopScheduling() { clearInterval(timer); }, async close() { if (closed) return; closed = true; clearInterval(timer); transport.close(); await service.settle(); service.close(); } };
}

export type Runtime = ReturnType<typeof createRuntime>;

const key = Symbol.for('purduehackers.jukebox.runtime');
const registry = globalThis as typeof globalThis & { [key]?: Runtime };
export function getRuntime() { return registry[key] ??= createRuntime(); }
export async function closeRuntime() { await registry[key]?.close(); delete registry[key]; }

const signalsKey = Symbol.for('purduehackers.jukebox.runtime.signals');
/**
 * Backstop so the runtime settles even when the dev server's `httpServer` close
 * event never fires. Installed at most once per process. Dev exit is owned by
 * the Astro CLI's own signal handlers; production lifecycle (including signals)
 * lives in scripts/start-web.ts, where this hook never runs.
 */
export function installShutdownBackstop() {
  const signals = globalThis as typeof globalThis & { [signalsKey]?: boolean };
  if (signals[signalsKey]) return;
  signals[signalsKey] = true;
  for (const signal of ['SIGTERM', 'SIGINT'] as const) {
    process.once(signal, () => { void closeRuntime(); });
  }
}
