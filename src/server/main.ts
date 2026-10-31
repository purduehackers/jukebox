// Local queue service entry point. Loopback-only; not a production deployment.
import { mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { FakeIdentity, FakeMedia, FakeSource, systemClock } from '../adapters/fakes.ts';
import { phidFromEnv } from '../adapters/phid.ts';
import { WorkerAdapter, proxyMedia } from '../adapters/worker.ts';
import type { IdentityPort, MediaPort, SourcePort } from '../core/ports.ts';
import { createHttpServer } from './http.ts';
import type { HttpOptions } from './http.ts';
import { JukeboxService } from './service.ts';

const { values } = parseArgs({
  options: {
    port: { type: 'string', default: '8980' },
    data: { type: 'string', default: '.local/service' },
    worker: { type: 'string' },
    'dev-auth': { type: 'boolean', default: false },
    'admin-key': { type: 'string', multiple: true, default: [] },
  },
});

const port = Number(values.port);
const host = '127.0.0.1';
const origin = process.env.JUKEBOX_ORIGIN ?? `http://${host}:${port}`;
const data = resolve(values.data!);
mkdirSync(data, { recursive: true });

let source: SourcePort;
let media: MediaPort;
let mediaProxy: HttpOptions['mediaProxy'];
if (values.worker) {
  // Phase-1 Python worker: real audio-only preparation, cache retention, and range media.
  const worker = new WorkerAdapter({ baseUrl: values.worker });
  source = worker;
  media = worker;
  mediaProxy = (assetId, req, res) => proxyMedia(values.worker!, assetId, req, res);
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
const server = createHttpServer({ service, identity, origin, mediaProxy });
// Server-side timer: due turns, lease expiry, and preparation progress never depend on a browser interval.
const timer = setInterval(() => void service.reconcile().catch((error) => console.error('[jukebox] reconcile', error)), 1000);
server.listen(port, host, () => {
  console.log(`Jukebox queue service: ${origin} (${identity.kind === 'fake' ? 'FAKE local sign-in' : 'PH ID'}; ${values.worker ? `worker ${values.worker}` : 'fake media'})`);
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
