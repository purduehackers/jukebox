import assert from 'node:assert/strict';
import { test } from 'node:test';
import { LookupCache } from '../src/adapters/lookup-cache.ts';
test('metadata reuse coalesces concurrent lookups, isolates callers and retries failures', async () => {
  const cache = new LookupCache<{ title: string }>(); let calls = 0;
  const load = async () => { calls++; await Promise.resolve(); return { title: 'Song' }; };
  const [a, b] = await Promise.all([cache.get('track', load), cache.get('track', load)]);
  a.title = 'changed'; assert.equal(b.title, 'Song');
  assert.equal((await cache.get('track', load)).title, 'Song'); assert.equal(calls, 1);
  await assert.rejects(cache.get('failure', async () => { throw Error('offline'); }));
  assert.equal((await cache.get('failure', load)).title, 'Song');
});
