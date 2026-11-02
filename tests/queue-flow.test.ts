// Phase 4B exit gate: the attendee request flow (the same RequestFlow the page uses) driven
// against the real service with a fake clock, fixture sources, and fake media. No network.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import type { CommandPayloads, CommandResponse } from '../src/contract/types.ts';
import type { Actor } from '../src/server/service.ts';
import { RequestFlow } from '../app/src/queue/controller.ts';
import type { IntentStore, PendingIntent } from '../app/src/queue/controller.ts';
import { STATUS_COPY, describeError } from '../app/src/queue/model.ts';
import { MIN, URLS, harness, user } from './helpers.ts';
import type { Harness } from './helpers.ts';

type Send = ConstructorParameters<typeof RequestFlow>[0];

/** The page's transport, minus HTTP: same envelope, same retry-with-one-commandId contract. */
function sender(h: Harness, who: Actor, log: { commandId: string; type: string }[] = []): Send {
  return (async (type: 'request.preview' | 'request.submit', payload: CommandPayloads[typeof type], options: { commandId?: string } = {}) => {
    const commandId = options.commandId ?? randomUUID();
    log.push({ commandId, type });
    return await h.svc.execute(who, { commandId, type, payload }) as CommandResponse<typeof type>;
  }) as Send;
}

const memoryStore = (): IntentStore & { value: PendingIntent | null } => ({
  value: null,
  load() { return this.value; },
  save(intent) { this.value = intent; },
});

async function checked(flow: RequestFlow, url: string) {
  flow.setUrl(url);
  await flow.check();
  return flow.snapshot;
}

test('new user: check shows the recording and verdict, submit spends exactly one request, status follows the queue', async () => {
  const h = harness();
  await h.startNight();
  h.media.autoReady = false;
  const flow = new RequestFlow(sender(h, h.alice));
  const state = await checked(flow, ` ${URLS.r1Alt} `);
  assert.equal(state.phase, 'previewed');
  assert.equal(state.preview?.source.title, 'Request One');
  assert.deepEqual(state.preview?.verdict, { accepted: true });
  assert.equal(h.snap(h.alice).quota?.used, 0, 'preview reserves nothing');

  await flow.submit();
  assert.equal(flow.snapshot.phase, 'submitted');
  assert.deepEqual(flow.snapshot.submitted?.quota, { used: 1, limit: 3, remaining: 2 });
  assert.equal(h.snap(h.alice).requests.find((r) => r.mine)?.status, 'preparing');
  await h.svc.reconcile();
  assert.equal(h.snap(h.alice).requests.find((r) => r.mine)?.status, 'preparing', 'visible as getting ready until the audio is prepared');
  for (const jobId of h.media.jobs.keys()) h.media.complete(jobId);
  await h.svc.reconcile();
  const mine = h.snap(h.alice).requests.find((r) => r.mine)!;
  assert.equal(mine.status, 'ready');
  assert.equal(mine.sourceUrl, 'https://www.youtube.com/watch?v=REQreqreq01', 'canonical link is kept, share parameter dropped');
});

test('double tap and lost response: one command ID, one charge', async () => {
  const h = harness();
  await h.startNight();
  const log: { commandId: string; type: string }[] = [];
  const base = sender(h, h.alice, log);
  let drop = true;
  // The first submit reaches the server but its response is lost (phone drops signal).
  const lossy: Send = (async (...args: Parameters<Send>) => {
    const response = await base(...args);
    if (args[0] === 'request.submit' && drop) {
      drop = false;
      return { ok: false, commandId: null, replayed: false, error: { code: 'INTERNAL', message: 'Network error', retryable: true } };
    }
    return response;
  }) as Send;
  const flow = new RequestFlow(lossy);
  await checked(flow, URLS.r1);
  const [a, b] = [flow.submit(), flow.submit()]; // double tap
  await Promise.all([a, b]);
  assert.equal(log.filter((l) => l.type === 'request.submit').length, 1, 'second tap joined the first');
  assert.equal(flow.snapshot.phase, 'previewed', 'retryable failure keeps the preview');
  assert.equal(describeError(flow.snapshot.error!).retry, true);
  assert.equal(h.snap(h.alice).quota?.used, 1, 'the server did apply the first attempt');

  await flow.submit(); // user taps again: same commandId, server replays
  const submits = log.filter((l) => l.type === 'request.submit');
  assert.equal(submits.length, 2);
  assert.equal(submits[0]!.commandId, submits[1]!.commandId);
  assert.equal(flow.snapshot.phase, 'submitted');
  assert.equal(h.snap(h.alice).quota?.used, 1, 'replay did not charge again');
  assert.equal(h.snap(h.alice).requests.filter((r) => r.mine).length, 1);
});

test('reload mid-submit resumes the same intent from the retry store', async () => {
  const h = harness();
  await h.startNight();
  const store = memoryStore();
  const log: { commandId: string; type: string }[] = [];
  const real = sender(h, h.alice, log);
  // First page load: the submit never reaches the server (connection dies), then the page is closed.
  const dying: Send = (async (...args: Parameters<Send>) => args[0] === 'request.preview'
    ? real(...args)
    : { ok: false, commandId: null, replayed: false, error: { code: 'INTERNAL', message: 'offline', retryable: true } }) as Send;
  const before = new RequestFlow(dying, store, () => 'cccccccc-cccc-4ccc-8ccc-cccccccccccc');
  await checked(before, URLS.r2);
  await before.submit();
  assert.equal(before.snapshot.phase, 'previewed');
  assert.equal(store.value?.commandId, 'cccccccc-cccc-4ccc-8ccc-cccccccccccc', 'pending intent survives for a reload');

  const after = new RequestFlow(real, store); // new page load
  assert.equal(after.resumable?.canonicalUrl, 'https://www.youtube.com/watch?v=REQreqreq02');
  await checked(after, URLS.r2);
  await after.submit();
  const submits = log.filter((l) => l.type === 'request.submit');
  assert.equal(submits.length, 1);
  assert.equal(submits[0]!.commandId, 'cccccccc-cccc-4ccc-8ccc-cccccccccccc');
  assert.equal(after.snapshot.phase, 'submitted');
  assert.equal(store.value, null, 'final answer clears the intent');
});

test('returning user: allowance carries over, runs out at three, and a new night starts fresh', async () => {
  const h = harness();
  await h.startNight();
  for (const url of [URLS.r1, URLS.r2]) {
    const flow = new RequestFlow(sender(h, h.alice));
    await checked(flow, url);
    await flow.submit();
    assert.equal(flow.snapshot.phase, 'submitted');
  }
  // "Returning": a fresh page load sees the allowance from the server, not browser storage.
  assert.deepEqual(h.snap(h.alice).quota, { used: 2, limit: 3, remaining: 1 });
  const third = new RequestFlow(sender(h, h.alice));
  await checked(third, URLS.r3);
  await third.submit();
  const fourth = new RequestFlow(sender(h, h.alice));
  const state = await checked(fourth, URLS.r4);
  assert.equal(state.error?.code, 'QUOTA_EXCEEDED');
  assert.match(describeError(state.error!).title, /out of requests/i);
  assert.equal(state.preview, null);

  await h.ok(h.admin, 'night.close', {});
  assert.equal((await checked(new RequestFlow(sender(h, h.alice)), URLS.r4)).error?.code, 'NIGHT_CLOSED');
  await h.ok(h.admin, 'night.open', {});
  assert.deepEqual(h.snap(h.alice).quota, { used: 0, limit: 3, remaining: 3 });
  const fresh = new RequestFlow(sender(h, h.alice));
  assert.equal((await checked(fresh, URLS.r4)).phase, 'previewed');
});

test('a night spanning local midnight keeps one allowance; only the admin session resets it', async () => {
  const h = harness();
  await h.startNight();
  const local = (ms: number) => new Date(ms).toLocaleString('en-US', { timeZone: 'America/Indiana/Indianapolis', hour12: false });
  const startDay = local(h.clock.now()).slice(0, 10);
  await h.advance(6 * 60 * MIN + 50 * MIN); // 21:00 UTC + 6h50 = 23:50 Indianapolis (UTC-4)
  assert.equal(local(h.clock.now()).slice(0, 10), startDay);
  for (const url of [URLS.r1, URLS.r2]) {
    const flow = new RequestFlow(sender(h, h.alice));
    await checked(flow, url);
    await flow.submit();
  }
  await h.advance(60 * MIN); // 00:50 next local day
  assert.notEqual(local(h.clock.now()).slice(0, 10), startDay, 'crossed local midnight');
  assert.deepEqual(h.snap(h.alice).quota, { used: 2, limit: 3, remaining: 1 }, 'midnight does not reset');
  const late = new RequestFlow(sender(h, h.alice));
  await checked(late, URLS.r3);
  await late.submit();
  assert.equal(late.snapshot.phase, 'submitted');
  assert.equal((await checked(new RequestFlow(sender(h, h.alice)), URLS.r4)).error?.code, 'QUOTA_EXCEEDED');
  assert.equal(h.snap(h.alice).night?.status, 'open');
  await h.ok(h.admin, 'night.close', {});
  await h.ok(h.admin, 'night.open', {});
  assert.equal(h.snap(h.alice).quota?.remaining, 3, 'the admin-managed session reset it');
});

test('unsupported and malicious links are rejected before any resolver work and spend nothing', async () => {
  const h = harness();
  await h.startNight();
  const cases: [string, string][] = [
    ['javascript:alert(1)', 'INVALID_SOURCE'],
    ['file:///etc/passwd', 'INVALID_SOURCE'],
    ['http://youtu.be/REQreqreq01', 'INVALID_SOURCE'],
    ['https://user:pw@youtu.be/REQreqreq01', 'INVALID_SOURCE'],
    ['https://youtu.be:8443/REQreqreq01', 'INVALID_SOURCE'],
    ['https://youtu.be/REQreqreq01#evil', 'INVALID_SOURCE'],
    ['https://youtu.be/REQreqreq01; rm -rf /', 'INVALID_SOURCE'],
    ['https://youtu.be/short', 'INVALID_SOURCE'],
    ['https://www.youtube.com/playlist?list=PL123', 'SOURCE_UNSUPPORTED'],
    ['https://open.spotify.com/playlist/37i9dQZF1DXcBWIGoYBM5M', 'SOURCE_UNSUPPORTED'],
    ['https://evil.example/watch?v=REQreqreq01', 'SOURCE_UNSUPPORTED'],
    ['https://169.254.169.254/latest/meta-data', 'SOURCE_UNSUPPORTED'],
    ['https://music.apple.com/us/album/some-album/123456', 'SOURCE_UNSUPPORTED'],
    ['not a link', 'INVALID_SOURCE'],
    // 400 characters is within the 2048 API bound now and fails as an invalid source; beyond it the envelope is rejected.
    [`https://youtu.be/${'a'.repeat(400)}`, 'INVALID_SOURCE'],
    [`https://youtu.be/${'a'.repeat(2100)}`, 'BAD_REQUEST'],
  ];
  const resolvedBefore = h.source.resolveCalls; // starting the night resolved the master item
  let n = 0;
  for (const [url, code] of cases) {
    // A fresh identity per case keeps this under the per-identity preview rate limit.
    const flow = new RequestFlow(sender(h, user(`probe${n++}`)));
    const state = await checked(flow, url);
    assert.equal(state.error?.code, code, url);
    assert.equal(state.preview, null);
    const copy = describeError(state.error!);
    assert.ok(copy.title && copy.body, url);
    await flow.submit();
    assert.notEqual(flow.snapshot.phase, 'submitted', url);
  }
  assert.equal(h.source.resolveCalls, resolvedBefore, 'nothing was resolved or fetched for any of them');
  assert.equal(h.snap(h.alice).quota?.used, 0);
});

test('overlong item: the preview shows it but offers no submit; a forced submit is refused', async () => {
  const h = harness();
  await h.startNight();
  const flow = new RequestFlow(sender(h, h.alice));
  const state = await checked(flow, URLS.long);
  assert.equal(state.phase, 'previewed');
  assert.equal(state.preview?.source.title, 'Too Long');
  const verdict = state.preview?.verdict;
  assert.equal(verdict && !verdict.accepted ? verdict.code : null, 'DURATION_REJECTED');
  await flow.submit(); // the page hides this button; the controller also refuses
  assert.equal(flow.snapshot.phase, 'previewed');
  await h.fails('DURATION_REJECTED', h.alice, 'request.submit', { url: URLS.long });
  assert.equal(h.snap(h.alice).quota?.used, 0);
  assert.equal((await checked(new RequestFlow(sender(h, h.alice)), URLS.almost)).preview?.verdict.accepted, true, '359.999 s is allowed');
});

test('mismatched version: if the link resolves differently at submit, nothing is admitted', async () => {
  const h = harness();
  await h.startNight();
  const flow = new RequestFlow(sender(h, h.alice));
  await checked(flow, URLS.r1);
  const shown = flow.snapshot.preview!.source.recordingKey;
  // The resolver/matcher now returns another version of "the same" link.
  h.source.add(URLS.r1, { title: 'Request One (Live)', durationSec: 250, recordingKey: 'youtube:live-version' });
  await flow.submit();
  const view = () => flow.snapshot;
  assert.equal(view().error?.code, 'GUARD_MISMATCH');
  assert.equal(view().phase, 'idle', 'user must look again');
  assert.equal(view().preview, null);
  assert.equal(h.snap(h.alice).quota?.used, 0);
  await flow.check();
  assert.notEqual(view().preview?.source.recordingKey, shown);
  assert.equal(view().preview?.source.title, 'Request One (Live)');
});

test('admin removal is not refunded; preparation and playback failures are; the page copy says so', async () => {
  const h = harness();
  const p = await h.startNight();
  for (const url of [URLS.r1, URLS.r2, URLS.r3]) {
    const flow = new RequestFlow(sender(h, h.alice));
    await checked(flow, url);
    await flow.submit();
  }
  await h.svc.reconcile();
  const entries = h.snap(h.alice).requests.filter((r) => r.mine);
  assert.deepEqual(entries.map((e) => e.status), ['ready', 'ready', 'ready']);
  const second = entries.find((e) => e.title === 'Request Two')!;
  await h.ok(h.admin, 'request.remove', { entryId: second.id });
  assert.equal(h.snap(h.alice).requests.find((r) => r.id === second.id)?.status, 'removed');
  assert.equal(h.snap(h.alice).quota?.used, 3, 'removal is not refunded');
  assert.equal(STATUS_COPY.removed.allowance, 'counts-final');

  // Playback failure of the request that plays: retried once, then refunded.
  await h.advance(15 * MIN, p);
  assert.equal(h.snap().nowPlaying?.title, 'Request One');
  await p.sync('error', 0);
  await p.sync('error', 0);
  const after = h.snap(h.alice);
  assert.equal(after.requests.find((r) => r.title === 'Request One')?.status, 'failed');
  assert.equal(after.quota?.used, 2, 'failed playback refunded');
  assert.equal(STATUS_COPY.failed.allowance, 'refunded');
});

test('two clients see the same queue: public order/status match, "mine" differs, admin sees requesters', async () => {
  const h = harness();
  await h.startNight();
  for (const [who, url] of [[h.alice, URLS.r1], [h.bob, URLS.r2], [h.alice, URLS.r3]] as const) {
    const flow = new RequestFlow(sender(h, who));
    await checked(flow, url);
    await flow.submit();
  }
  await h.svc.reconcile();
  const shape = (actor: Actor) => h.snap(actor).requests.map(({ id, title, artist, status, durationSec }) => ({ id, title, artist, status, durationSec }));
  assert.deepEqual(shape(h.alice), shape(h.bob));
  const aliceMine = h.snap(h.alice).requests.filter((r) => r.mine).map((r) => r.title);
  const bobMine = h.snap(h.bob).requests.filter((r) => r.mine).map((r) => r.title);
  assert.deepEqual(aliceMine, ['Request One', 'Request Three']);
  assert.deepEqual(bobMine, ['Request Two']);
  assert.ok(h.snap(h.bob).requests.every((r) => r.requester === undefined && (r.mine || r.sourceUrl === undefined)), 'no other attendee’s link or name leaks');
  // A reorder is seen by both on the next snapshot.
  const [first, second] = h.snap(h.admin).requests;
  await h.ok(h.admin, 'request.move', { entryId: second!.id, afterEntryId: null });
  assert.deepEqual(shape(h.alice), shape(h.bob));
  assert.equal(h.snap(h.bob).requests[0]!.id, second!.id);
  assert.notEqual(h.snap(h.bob).requests[0]!.id, first!.id);
});
