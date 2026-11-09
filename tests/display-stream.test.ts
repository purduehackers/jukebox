import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { AddressInfo } from 'node:net';
import { FakeIdentity } from '../src/adapters/fakes.ts';
import { createHttpServer } from './http-server.ts';
import type { Snapshot } from '../src/contract/types.ts';
import { harness } from './helpers.ts';

test('SSE refreshes position-only reports even when revision is unchanged', { timeout: 12_000 }, async () => {
  const h = harness();
  const player = await h.startNight();
  const server = createHttpServer({ service: h.svc, identity: new FakeIdentity(), origin: 'http://127.0.0.1' });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const controller = new AbortController();
  try {
    const response = await fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}/api/v1/stream`, { signal: controller.signal });
    const reader = response.body!.pipeThrough(new TextDecoderStream()).getReader();
    let buffer = '';
    async function next() {
      for (;;) {
        const boundary = buffer.indexOf('\n\n');
        if (boundary >= 0) {
          const block = buffer.slice(0, boundary); buffer = buffer.slice(boundary + 2);
          const data = block.split('\n').find((line) => line.startsWith('data: '));
          if (data) return JSON.parse(data.slice(6)) as Snapshot;
        } else {
          const value = await reader.read(); assert.equal(value.done, false); buffer += value.value;
        }
      }
    }
    const initial = await next();
    h.clock.advance(5000); await player.heartbeat(5000);
    const current = h.snap();
    assert.equal(initial.revision, current.revision);
    const heartbeat = await next();
    assert.equal(heartbeat.revision, initial.revision);
    assert.ok(heartbeat.serverTime > initial.serverTime);
    assert.ok(heartbeat.playback.observed!.observedAt! > initial.playback.observed!.observedAt!);
    assert.ok(heartbeat.playback.observed!.positionSec! > initial.playback.observed!.positionSec!);
    assert.equal(heartbeat.master, undefined);
  } finally {
    controller.abort();
    await new Promise<void>((resolve) => { server.close(() => resolve()); server.closeAllConnections(); });
    h.svc.close();
  }
});
