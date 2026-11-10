import assert from 'node:assert/strict';
import { test } from 'node:test';
import { URLS, harness, user } from './helpers.ts';

test('organizers can ban and unban normalized usernames; bans persist across restarts and nights', async () => {
  const h = harness();
  await h.startNight();
  const prior = await h.ok(h.alice, 'request.submit', { url: URLS.r1 });
  await h.fails('FORBIDDEN', h.alice, 'requester.ban', { username: 'Alice' });
  await h.ok(h.admin, 'requester.ban', { username: 'ALICE' });
  assert.deepEqual(h.snap(h.admin).bannedUsernames, ['alice']);
  assert.equal(h.snap(h.alice).bannedUsernames, undefined, 'attendees cannot read the list');
  await h.fails('USERNAME_BANNED', h.alice, 'request.submit', { url: URLS.r2 });
  const preview = await h.cmd(h.alice, 'request.preview', { url: URLS.r2 });
  assert.equal(preview.ok, false);
  if (!preview.ok) assert.equal(preview.error.code, 'USERNAME_BANNED');
  assert.equal(h.snap(h.admin).requests.some((r) => r.id === prior.entryId), true, 'ban does not remove prior requests');
  assert.equal(h.snap(h.alice).quota?.used, 1, 'rejection does not change quota');

  await h.svc.settle();
  h.restart();
  await h.fails('USERNAME_BANNED', h.alice, 'request.submit', { url: URLS.r2 });
  await h.ok(h.admin, 'night.close', {});
  await h.ok(h.admin, 'night.open', {});
  await h.fails('USERNAME_BANNED', h.alice, 'request.submit', { url: URLS.r2 });
  await h.ok(h.admin, 'requester.unban', { username: 'ALICE' });
  assert.deepEqual(h.snap(h.admin).bannedUsernames, []);
  assert.ok((await h.cmd(h.alice, 'request.submit', { url: URLS.r2 })).ok);
  await h.svc.settle();
  h.svc.close();
});

test('legacy sessions without a verified username cannot bypass active bans', async () => {
  const h = harness();
  await h.startNight();
  await h.ok(h.admin, 'requester.ban', { username: 'someone' });
  const legacy = user('legacy');
  if (legacy.kind !== 'user') throw new Error('test setup');
  delete legacy.identity.username;
  await h.fails('USERNAME_REQUIRED', legacy, 'request.submit', { url: URLS.r1 });
  const preview = await h.cmd(legacy, 'request.preview', { url: URLS.r1 });
  assert.equal(preview.ok, false);
  if (!preview.ok) assert.equal(preview.error.code, 'USERNAME_REQUIRED');
  assert.equal(h.snap(h.admin).requests.length, 0);
  await h.svc.settle();
  h.svc.close();
});

test('ban commands reject invalid names and request payloads cannot provide an identity username', async () => {
  const h = harness();
  await h.fails('BAD_REQUEST', h.admin, 'requester.ban', { username: 'person@elsewhere' });
  await h.startNight();
  const response = await h.svc.execute(h.alice, {
    commandId: crypto.randomUUID(), type: 'request.submit', payload: { url: URLS.r1, username: 'unbanned' },
  });
  assert.equal(response.ok, false);
  if (!response.ok) assert.equal(response.error.code, 'BAD_REQUEST');
  await h.svc.settle();
  h.svc.close();
});
