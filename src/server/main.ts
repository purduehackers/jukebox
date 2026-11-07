// Queue service and built frontend behind same-origin HTTPS ingress.
import { validateProduction } from './production.ts';
import { mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { FakeIdentity, FakeMedia, FakeSource, systemClock } from '../adapters/fakes.ts';
import { fixtureMatchingSource } from '../adapters/matching-fixtures.ts';
import { phidFromEnv } from '../adapters/phid.ts';
import { LiveCatalog } from '../adapters/live-catalog.ts';
import { MatchingSource } from '../adapters/matching-source.ts';
import { WorkerAdapter, proxyMedia } from '../adapters/worker.ts';
import type { IdentityPort, MediaPort, SourcePort } from '../core/ports.ts';
import { createHttpServer } from './http.ts';
import type { HttpOptions } from './http.ts';
import { JukeboxService } from './service.ts';

const { values } = parseArgs({
  options: {
    port: { type: 'string', default: process.env.JUKEBOX_SERVICE_PORT ?? '8980' },
    data: { type: 'string', default: process.env.JUKEBOX_SERVICE_DATA ?? '.local/service' },
    worker: { type: 'string' },
    'dev-auth': { type: 'boolean', default: false },
    'fixture-media': { type: 'boolean', default: false },
    'fixture-matching': { type: 'boolean', default: false },
    'admin-key': { type: 'string', multiple: true, default: [] },
  },
});

validateProduction(process.env, { data: values.data!, devAuth: values['dev-auth'], fixtures: values['fixture-media'] || values['fixture-matching'] });

const port = Number(values.port);
const host = process.env.JUKEBOX_SERVICE_HOST ?? '127.0.0.1';
const origin = process.env.JUKEBOX_ORIGIN ?? `http://${host}:${port}`;
const data = resolve(values.data!);
mkdirSync(data, { recursive: true });

if (values.worker && (values['fixture-media'] || values['fixture-matching'])) throw new Error('Choose a real worker or an explicit fixture mode');
const workerUrl = values.worker ?? process.env.JUKEBOX_WORKER_URL ?? 'http://127.0.0.1:8971';
const useWorker = !values['fixture-media'] && !values['fixture-matching'];

let source: SourcePort;
let media: MediaPort;
let mediaProxy: HttpOptions['mediaProxy'];
if (useWorker) {
  // Phase-1 Python worker: real audio-only preparation, cache retention, and range media.
  const worker = new WorkerAdapter({ baseUrl: workerUrl });
  source = new MatchingSource(worker, new LiveCatalog({ spotifyClientId: process.env.JUKEBOX_SPOTIFY_CLIENT_ID, spotifyClientSecret: process.env.JUKEBOX_SPOTIFY_CLIENT_SECRET, appleDeveloperToken: process.env.JUKEBOX_APPLE_MUSIC_DEVELOPER_TOKEN }), worker);
  media = worker;
  mediaProxy = (assetId, req, res) => proxyMedia(workerUrl, assetId, req, res);
} else if (values['fixture-matching']) {
  // Offline attendee-page demo: fixture YouTube items and fixture Spotify/Apple catalog matching.
  source = fixtureMatchingSource();
  media = new FakeMedia();
} else {
  // Fully offline: deterministic fixture metadata and instantly "prepared" fake assets (no audio bytes).
  const fake = new FakeSource();
  for (const [name, durationSec] of [['master', 3600], ['request', 4], ['song', 360], ['aac', 8]] as const) {
    fake.add(`fixture:${name}`, { title: `fixture:${name}`, durationSec });
  }
  source = fake;
  media = new FakeMedia();
}

let identity: IdentityPort | null = phidFromEnv(process.env);
if (values['dev-auth']) {
  if (identity) throw new Error('Refusing --dev-auth while PH ID is configured');
  identity = new FakeIdentity();
}
if (!identity) {
  console.error('Configure PH ID (JUKEBOX_PHID_CLIENT_ID, JUKEBOX_PHID_REDIRECT_URI, JUKEBOX_SESSION_SECRET) or pass --dev-auth for local fake sign-in.');
  process.exit(2);
}

const service = new JukeboxService({
  dbPath: join(data, 'state.sqlite3'),
  clock: systemClock,
  source,
  media,
  adminKeys: [...values['admin-key']!, ...(process.env.JUKEBOX_ADMIN_KEYS?.split(',').filter(Boolean) ?? [])],
});
const server = createHttpServer({ service, identity, origin, mediaProxy, frontendDir: resolve('dist/app') });
// Server-side timer: due turns, lease expiry, and preparation progress never depend on a browser interval.
const timer = setInterval(() => void service.reconcile().catch((error) => console.error('[jukebox] reconcile', error)), 1000);
server.listen(port, host, () => {
  console.log(`Jukebox queue service: ${origin} (${identity.kind === 'fake' ? 'FAKE local sign-in' : 'PH ID'}; ${useWorker ? `audio worker ${workerUrl}; live catalog matching` : 'EXPLICIT FIXTURE MEDIA (no audio)'})`);
});

function shutdown() {
  clearInterval(timer);
  server.close(() => {
    service.close();
    process.exit(0);
  });
  server.closeAllConnections();
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
