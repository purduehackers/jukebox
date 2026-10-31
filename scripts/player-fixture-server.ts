// Loopback-only browser test fixture. Never used by run-dev/production.
import { mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { FakeIdentity, systemClock } from '../src/adapters/fakes.ts';
import { WorkerAdapter, proxyMedia } from '../src/adapters/worker.ts';
import { createHttpServer } from '../src/server/http.ts';
import { JukeboxService } from '../src/server/service.ts';

const { values } = parseArgs({ options: {
  port: { type: 'string' }, worker: { type: 'string' },
  data: { type: 'string' }, origin: { type: 'string' },
} });
const data = resolve(values.data!);
mkdirSync(data, { recursive: true });
const worker = new WorkerAdapter({ baseUrl: values.worker! });
const service = new JukeboxService({ dbPath: join(data, 'state.sqlite3'), clock: systemClock, source: worker, media: worker });
const server = createHttpServer({ service, identity: new FakeIdentity(), origin: values.origin!, mediaProxy: (id, req, res) => proxyMedia(values.worker!, id, req, res) });
// Advance only the scheduling anchor, leaving real lease/heartbeat time intact.
// This explicit test fixture avoids fifteen-minute waits without weakening fencing.
const route = server.listeners('request')[0]!;
server.removeAllListeners('request');
server.on('request', (req, res) => {
  if (req.url === '/__test/due' && req.method === 'POST') {
    service.db.prepare('update playback set period_started_at = ?').run(Date.now() - service.policy.periodMs - 1);
    void service.reconcile().then(() => { res.writeHead(200); res.end('{}'); });
  } else route.call(server, req, res);
});
const timer = setInterval(() => void service.reconcile().catch(console.error), 200);
server.listen(Number(values.port), '127.0.0.1');
function stop() { clearInterval(timer); server.close(() => { service.close(); process.exit(0); }); server.closeAllConnections(); }
process.on('SIGINT', stop); process.on('SIGTERM', stop);
