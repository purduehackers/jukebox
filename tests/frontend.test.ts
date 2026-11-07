import assert from 'node:assert/strict';
import { test } from 'node:test';
import http from 'node:http';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { serveFrontend } from '../src/server/frontend.ts';

test('built frontend serves direct app routes and assets without exposing backend files', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'jukebox-frontend-'));
  await mkdir(join(root, 'assets'));
  await writeFile(join(root, 'index.html'), '<html>app</html>');
  await writeFile(join(root, 'assets', 'app-123.js'), 'console.log(1)');
  const server = http.createServer((req, res) => {
    void serveFrontend(root, new URL(req.url!, 'http://localhost').pathname, req, res).then(served => {
      if (!served) { res.writeHead(404); res.end(); }
    });
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { await new Promise<void>(resolve => server.close(() => resolve())); await rm(root, { recursive: true }); });
  const base = `http://127.0.0.1:${(server.address() as import('node:net').AddressInfo).port}`;
  for (const route of ['/', '/admin', '/queue', '/display', '/visual']) {
    const response = await fetch(base + route);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('cache-control'), 'no-cache');
    assert.equal(await response.text(), '<html>app</html>');
  }
  const asset = await fetch(base + '/assets/app-123.js');
  assert.match(asset.headers.get('content-type')!, /javascript/);
  assert.match(asset.headers.get('cache-control')!, /immutable/);
  assert.equal(await asset.text(), 'console.log(1)');
  const head = await fetch(base + '/display', { method: 'HEAD' });
  assert.equal(head.headers.get('content-length'), '16');
  assert.equal(await head.text(), '');
  for (const route of ['/assets/missing.js', '/api/missing', '/auth/missing', '/media/missing', '/.env.local', '/src/server/main.ts', '/assets/%2e%2e%2findex.html']) {
    assert.equal((await fetch(base + route)).status, 404, route);
  }
  assert.equal((await fetch(base + '/admin', { method: 'POST' })).status, 404);
});
