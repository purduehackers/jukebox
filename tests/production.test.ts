import assert from 'node:assert/strict';
import { test } from 'node:test';
import { validateProduction } from '../src/server/production.ts';
import { requestUrl } from '../app/src/display/model.ts';

const env = {
  NODE_ENV: 'production', JUKEBOX_ORIGIN: 'https://jukebox.purduehackers.com',
  JUKEBOX_PHID_REDIRECT_URI: 'https://jukebox.purduehackers.com/auth/callback',
  JUKEBOX_PHID_CLIENT_ID: 'fixture-client', JUKEBOX_PHID_CLIENT_SECRET: 'fixture-secret',
  JUKEBOX_SESSION_SECRET: 'fixture-session-secret-'.repeat(3),
};
const options = { data: '/var/lib/jukebox/service', devAuth: false, fixtures: false };
test('production rejects missing identity, local origins, callback mismatches, temporary paths and fixture modes', () => {
  assert.doesNotThrow(() => validateProduction(env, options));
  for (const key of Object.keys(env).filter(k => k !== 'NODE_ENV')) {
    assert.throws(() => validateProduction({ ...env, [key]: '' }, options));
  }
  assert.throws(() => validateProduction({ ...env, JUKEBOX_ORIGIN: 'http://127.0.0.1:5173' }, options));
  assert.throws(() => validateProduction({ ...env, JUKEBOX_PHID_REDIRECT_URI: 'http://127.0.0.1:5173/auth/callback' }, options));
  assert.throws(() => validateProduction(env, { ...options, data: '.local/service' }));
  assert.throws(() => validateProduction({ ...env, JUKEBOX_WORKER_DATA: options.data }, options));
  assert.throws(() => validateProduction({ ...env, JUKEBOX_WORKER_DATA: '.local/worker' }, options));
  assert.throws(() => validateProduction(env, { ...options, devAuth: true }));
  assert.throws(() => validateProduction(env, { ...options, fixtures: true }));
});
test('deployed QR and printed link follow the public browser origin without a laptop address', () => {
  assert.equal(requestUrl(undefined, env.JUKEBOX_ORIGIN), 'https://jukebox.purduehackers.com/queue');
});

test('production launcher boots real worker/service using configured persistent directories and shuts both down', { timeout: 20_000 }, async () => {
  const { spawn } = await import('node:child_process');
  const { mkdtempSync, existsSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { createServer } = await import('node:net');
  async function freePort() {
    const listener = createServer();
    await new Promise<void>(r => listener.listen(0, '127.0.0.1', r));
    const address = listener.address(); assert.ok(address && typeof address !== 'string');
    await new Promise<void>(r => listener.close(() => r()));
    return address.port;
  }
  const dir = mkdtempSync(join(tmpdir(), 'jukebox-production-'));
  const servicePort = await freePort(), workerPort = await freePort();
  const inherited = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('JUKEBOX_')));
  const child = spawn('./scripts/run-production', [], { env: {
    ...inherited, ...env, JUKEBOX_SERVICE_DATA: join(dir, 'service'), JUKEBOX_WORKER_DATA: join(dir, 'worker'),
    JUKEBOX_SERVICE_PORT: String(servicePort), JUKEBOX_WORKER_PORT: String(workerPort),
  }, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = ''; child.stdout.on('data', chunk => output += chunk); child.stderr.on('data', chunk => output += chunk);
  const stopped = new Promise<void>(resolve => child.once('exit', () => resolve()));
  try {
    for (let attempt = 0; !output.includes('Server listening on'); attempt++) {
      if (child.exitCode !== null || attempt >= 150) throw Error(`Production startup failed: ${output}`);
      await new Promise(r => setTimeout(r, 50));
    }
    const response = await fetch(`http://127.0.0.1:${servicePort}/healthz`);
    assert.equal(response.status, 200);
    assert.ok(existsSync(join(dir, 'service', 'state.sqlite3')));
    assert.ok(existsSync(join(dir, 'worker', 'state.sqlite3')));
    assert.match(output, /Jukebox authority: PH ID/);
    assert.equal((await fetch(`http://127.0.0.1:${servicePort}/auth/fake`)).status, 404);
  } finally {
    child.kill('SIGTERM'); await stopped;
    for (const port of [servicePort, workerPort]) {
      await assert.rejects(fetch(`http://127.0.0.1:${port}/healthz`, { signal: AbortSignal.timeout(1000) }));
    }
    rmSync(dir, { recursive: true, force: true });
  }
});
