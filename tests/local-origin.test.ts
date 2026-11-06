import assert from 'node:assert/strict';
import { test } from 'node:test';
import { localOriginRedirect } from '../src/server/local-origin.ts';

test('local pages and login use the registered callback hostname before cookies are set', () => {
  const canonical = 'http://127.0.0.1:5173';
  for (const path of ['/display', '/admin', '/queue', '/auth/login?returnTo=%2Fadmin']) {
    assert.equal(localOriginRedirect('localhost:5173', path, canonical), `${canonical}${path}`);
    assert.equal(localOriginRedirect('127.0.0.1:5173', path, canonical), null);
  }
  assert.equal(localOriginRedirect('127.0.0.1:5173', '/admin', 'http://localhost:5173'), 'http://localhost:5173/admin');
});

test('canonical redirect cannot reflect arbitrary hosts, ports or external redirect targets', () => {
  const canonical = 'http://127.0.0.1:5173';
  for (const host of ['evil.example:5173', 'localhost.evil.example:5173', 'localhost:5174', 'user@localhost:5173', undefined]) {
    assert.equal(localOriginRedirect(host, '/admin', canonical), null);
  }
  for (const path of ['//evil.example', 'https://evil.example', 'admin']) {
    assert.equal(localOriginRedirect('localhost:5173', path, canonical), null);
  }
  assert.equal(localOriginRedirect('localhost:5173', '/admin', 'https://jukebox.purduehackers.com'), null);
});
