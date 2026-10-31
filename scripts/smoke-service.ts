// End-to-end local smoke: real phase-1 worker (owned fixtures only, no network) behind
// the queue service, driven over HTTP by admin, attendee, and a paired player.
// Usage: node scripts/smoke-service.ts   (needs .venv and ffmpeg; ~10s)
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const root = new URL('..', import.meta.url).pathname;
const dir = mkdtempSync(join(tmpdir(), 'jukebox-smoke-'));
const workerPort = 18971 + Math.floor(Math.random() * 500);
const servicePort = workerPort + 1000;
const children = [
  spawn(join(root, '.venv/bin/python'), ['-m', 'jukebox.server', '--port', String(workerPort), '--data', join(dir, 'worker')], { cwd: root, stdio: 'inherit' }),
  spawn(process.execPath, ['src/server/main.ts', '--port', String(servicePort), '--data', join(dir, 'service'), '--dev-auth', '--worker', `http://127.0.0.1:${workerPort}`], { cwd: root, stdio: 'inherit', env: { ...process.env, JUKEBOX_PHID_CLIENT_ID: '' } }),
];
const base = `http://127.0.0.1:${servicePort}`;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function client() {
  const jar: string[] = [];
  let bearer = '';
  const call = async (path: string, init: RequestInit = {}) => {
    const headers = new Headers(init.headers);
    if (jar.length) headers.set('cookie', jar.join('; '));
    if (bearer) headers.set('authorization', `Bearer ${bearer}`);
    const res = await fetch(base + path, { ...init, headers, redirect: 'manual' });
    for (const c of res.headers.getSetCookie()) jar.push(c.split(';')[0]!);
    return res;
  };
  return {
    call,
    setBearer: (t: string) => { bearer = t; },
    async login(sub: string, organizer = false) {
      const state = new URL((await call('/auth/login')).headers.get('location')!, base).searchParams.get('state');
      await call(`/auth/callback?state=${state}&sub=${sub}${organizer ? '&roles=organizer' : ''}`);
    },
    async cmd(type: string, payload: unknown) {
      const res = await call('/api/v1/commands', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ commandId: randomUUID(), type, payload }) });
      const body = await res.json() as { ok: boolean; result: Record<string, unknown> };
      assert.ok(body.ok, `${type}: ${JSON.stringify(body)}`);
      return body.result;
    },
    async snap() {
      return await (await call('/api/v1/snapshot')).json();
    },
  };
}

try {
  for (let i = 0; i < 100; i++) {
    try {
      if ((await fetch(`${base}/healthz`)).ok) break;
    } catch { /* starting */ }
    await sleep(100);
  }
  const admin = client();
  const alice = client();
  const display = client();
  await admin.login('organizer1', true);
  await alice.login('alice');
  await admin.cmd('night.open', {});
  await admin.cmd('master.add', { url: 'fixture:song' }); // 360s AAC: a normal song at the boundary
  await alice.cmd('request.submit', { url: 'fixture:request' });
  const started = Date.now();
  let s;
  for (;;) {
    s = await admin.snap();
    if (s.master[0].status === 'ready' && s.requests[0]?.status === 'ready') break;
    assert.ok(Date.now() - started < 60_000, 'preparation timed out');
    await sleep(250);
  }
  console.log(`prepared master+request via real worker in ${Date.now() - started}ms`);
  const { code } = await admin.cmd('device.pairing.create', { name: 'smoke' }) as { code: string };
  const { token } = await display.cmd('device.pair', { code }) as { token: string };
  display.setBearer(token);
  await display.cmd('player.claim', {});
  await admin.cmd('playback.play', {});
  const desired = (await display.snap()).desired;
  assert.match(desired.asset.url, /^\/media\/[0-9a-f-]{36}$/, 'same-origin media path');
  const ranged = await display.call(desired.asset.url, { headers: { range: 'bytes=0-1023' } });
  assert.equal(ranged.status, 206);
  assert.equal(ranged.headers.get('content-range')?.startsWith('bytes 0-1023/'), true);
  assert.equal((await ranged.arrayBuffer()).byteLength, 1024);
  console.log(`desired ${desired.kind} ${desired.asset.mime}/${desired.asset.codec} ${desired.asset.durationSec}s; range 206 via service proxy`);
  const retention = await (await fetch(`http://127.0.0.1:${workerPort}/api/status`)).json() as { assets: { id: string; pinned: boolean }[] };
  assert.ok(retention.assets.every((a) => a.pinned), 'worker pins every asset the queue retains');
  console.log(`worker pinned ${retention.assets.length}/${retention.assets.length} queue assets`);
  console.log('SMOKE OK');
} finally {
  for (const child of children) child.kill('SIGTERM');
}
