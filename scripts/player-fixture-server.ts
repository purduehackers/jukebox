// Isolated phase-3 integration service. Uses the real phase-1 Python worker for
// fixture audio, with only the scheduling/lease clocks shortened for a test run.
import { mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { FakeIdentity } from '../src/adapters/fakes.ts';
import { WorkerAdapter, proxyMedia } from '../src/adapters/worker.ts';
import { createHttpServer } from '../src/server/http.ts';
import { JukeboxService } from '../src/server/service.ts';
import { systemClock } from '../src/adapters/fakes.ts';

const { values } = parseArgs({ options: {
  port: { type: 'string', default: '0' }, worker: { type: 'string', required: true },
  data: { type: 'string', required: true }, origin: { type: 'string', required: true },
  periodMs: { type: 'string', default: '12000' }, leaseMs: { type: 'string', default: '6000' },
} });
const port = Number(values.port);
const data = resolve(values.data!);
mkdirSync(data, { recursive: true });
const worker = new WorkerAdapter({ baseUrl: values.worker! });
const service = new JukeboxService({
  dbPath: join(data, 'state.sqlite3'), clock: systemClock, source: worker, media: worker,
  policy: { periodMs: Number(values.periodMs), leaseMs: Number(values.leaseMs), heartbeatMs: 1000, ackTimeoutMs: 5000 },
});
const server = createHttpServer({ service, identity: new FakeIdentity(), origin: values.origin!, mediaProxy: (id, req, res) => proxyMedia(values.worker!, id, req, res) });
const timer = setInterval(() => void service.reconcile().catch((e) => console.error('[fixture] reconcile', e)), 200);
server.listen(port, '127.0.0.1', () => {
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('No TCP address');
  console.log(JSON.stringify({ port: address.port }));
});
function stop() { clearInterval(timer); server.close(() => { service.close(); process.exit(0); }); server.closeAllConnections(); }
process.on('SIGINT', stop); process.on('SIGTERM', stop);
