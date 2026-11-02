// Phase 4A: what an organizer's UI depends on, exercised against the real HTTP service
// (fake clock/adapters/display). The UI's own command runner and view-model code are the
// system under test, so conflict handling and honesty rules here are the shipped rules.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CommandRunner, VolumeController } from '../app/src/admin/intents.ts';
import type { Timers } from '../app/src/admin/intents.ts';
import { describeTurn, estimatePosition, explainError, moveAnchor, optimisticIntent, playerState, queueSignature, waitingRequests } from '../app/src/admin/derive.ts';
import { sendCommand } from '../app/src/shared/api.ts';
import { URLS } from './helpers.ts';
import { ORIGIN, ScriptedDisplay, organizer, startApp, startNight } from './admin-helpers.ts';
import type { App, HttpClient } from './admin-helpers.ts';

const submit = async (app: App, who: HttpClient, url: string) => {
  const res = await who.raw('request.submit', { url });
  assert.ok(res.body.ok, JSON.stringify(res.body));
  await app.service.reconcile();
  return (res.body as { result: { entryId: string } }).result.entryId;
};

test('two organizers racing: one skip applies, the other gets guard feedback; duplicates replay', async () => {
  const app = await startApp();
  try {
    const a = await organizer(app, 'organizer1');
    const b = await organizer(app, 'organizer2');
    await startNight(app, a, [URLS.mix, URLS.song]);
    const before = (await a.snapshot()).nowPlaying!;
    assert.equal(before.title, 'Hour Mix');

    const [first, second] = await Promise.all([a.raw('playback.skip', { entryId: before.entryId }), b.raw('playback.skip', { entryId: before.entryId })]);
    const outcomes = [first, second].map((r) => (r.body.ok ? 'ok' : r.body.error.code)).sort();
    assert.deepEqual(outcomes, ['GUARD_MISMATCH', 'ok'], 'exactly one skip applies');
    assert.equal((await b.snapshot()).nowPlaying!.title, 'Master Song', 'skipped once, not twice');

    // The runner reports the loser as "not applied" with a conflict explanation, not a generic failure.
    const runner = new CommandRunner(b.send);
    const stale = await runner.run('Skip current item', 'playback.skip', { entryId: before.entryId });
    assert.equal(stale.status, 'failed');
    assert.equal(stale.error!.code, 'GUARD_MISMATCH');
    assert.equal(stale.error!.retryable, false);
    assert.equal(explainError(stale.error!, stale.type).tone, 'conflict');
    assert.equal(runner.getSnapshot()[0]!.status, 'failed');
    assert.equal(await runner.retry('missing'), null);

    // Same commandId delivered twice (retry after a lost response): applied once, second says replayed.
    const id = crypto.randomUUID();
    const one = await a.raw('playback.pause', {}, id);
    const two = await a.raw('playback.pause', {}, id);
    assert.ok(one.body.ok && two.body.ok);
    assert.equal(one.body.replayed, false);
    assert.equal(two.body.replayed, true);
    // …but reusing it for a different decision is refused rather than silently ignored.
    const mismatch = await a.raw('playback.play', {}, id);
    assert.equal(mismatch.body.ok ? 'ok' : mismatch.body.error.code, 'IDEMPOTENCY_MISMATCH');

    // Queue races: removing an anchor/entry another organizer already removed is NOT_FOUND feedback.
    const alice = await app.client().login('alice');
    const r1 = await submit(app, alice, URLS.r1);
    const r2 = await submit(app, alice, URLS.r2);
    const r3 = await submit(app, await app.client().login('bob'), URLS.r3);
    assert.ok((await a.raw('request.remove', { entryId: r2 })).body.ok);
    const removedTwice = await b.raw('request.remove', { entryId: r2 });
    assert.equal(removedTwice.body.ok ? 'ok' : removedTwice.body.error.code, 'NOT_FOUND');
    const staleMove = await b.raw('request.move', { entryId: r3, afterEntryId: r2 });
    assert.equal(staleMove.body.ok ? 'ok' : staleMove.body.error.code, 'NOT_FOUND');
    assert.equal(explainError({ code: 'NOT_FOUND', message: '', retryable: false }, 'request.move').tone, 'conflict');
    // A concurrent insert does not invalidate a relative move.
    assert.ok((await b.raw('request.move', { entryId: r3, afterEntryId: null })).body.ok);
    assert.deepEqual(waitingRequests(await a.snapshot()).map((r) => r.id), [r3, r1]);
  } finally {
    await app.stop();
  }
});

test('permissions: public, attendee, and device credentials cannot control playback; expiry is visible', async () => {
  const app = await startApp();
  try {
    const admin = await organizer(app);
    const display = await startNight(app, admin);
    const attendee = await app.client().login('alice');
    const anon = app.client();

    assert.equal((await anon.raw('playback.pause', {})).status, 401);
    const forbidden = await attendee.raw('playback.pause', {});
    assert.equal(forbidden.status, 403);
    assert.equal(forbidden.body.ok ? 'ok' : forbidden.body.error.code, 'FORBIDDEN');
    assert.equal(explainError({ code: 'FORBIDDEN', message: '', retryable: false }, 'playback.pause').tone, 'auth');
    assert.equal((await display.client.raw('night.close', {})).status, 403, 'a paired display token is not an organizer');
    assert.equal((await attendee.raw('playback.volume', { volume: 0, role: 'admin' } as never)).status, 400, 'extra role field is rejected, not honoured');
    assert.equal((await admin.snapshot()).schedule.intent, 'playing', 'rejected commands changed nothing');

    // Role-scoped data: organizer-only fields never reach an attendee.
    await submit(app, attendee, URLS.r1);
    const seen = await attendee.snapshot();
    assert.equal(seen.role, 'attendee');
    assert.equal(seen.master, undefined);
    assert.equal(seen.devices, undefined);
    assert.equal(seen.requests[0]!.requester, undefined);
    assert.deepEqual(seen.alerts, []);
    assert.equal((await admin.snapshot()).requests[0]!.requester, 'alice');

    // Session expiry: the next poll says "public", and a command is refused with an actionable error.
    app.clock.advance(13 * 3600_000);
    assert.equal((await admin.snapshot()).role, 'public');
    const expired = await admin.raw('playback.pause', {});
    assert.equal(expired.status, 401);
    assert.equal(!expired.body.ok && explainError(expired.body.error, 'playback.pause').tone, 'auth');
    void display;
  } finally {
    await app.stop();
  }
});

test('honest display state: no display, requested -> unconfirmed -> confirmed, then offline with a stale position', async () => {
  const app = await startApp();
  try {
    const admin = await organizer(app);
    assert.ok((await admin.raw('night.open', {})).body.ok);
    assert.ok((await admin.raw('master.add', { url: URLS.mix })).body.ok);
    await app.service.reconcile();
    assert.equal(playerState(await admin.snapshot()), 'no_display');

    const display = await ScriptedDisplay.pair(app, admin);
    assert.equal(playerState(await admin.snapshot()), 'needs_activation');
    assert.ok((await admin.raw('playback.play', {})).body.ok);
    let snap = await admin.snapshot();
    assert.equal(snap.playback.confirmation, 'requested', 'accepted by the server is not confirmed by the display');

    app.clock.advance(11_000);
    await display.report('playing', 0);
    snap = await admin.snapshot();
    assert.equal(snap.playback.confirmation, 'confirmed');
    assert.equal(playerState(snap), 'playing');

    // A seek the display never acknowledges becomes "unconfirmed" with an alert after the timeout.
    const entryId = snap.nowPlaying!.entryId;
    assert.ok((await admin.raw('playback.seek', { entryId, positionSec: 600 })).body.ok);
    assert.equal((await admin.snapshot()).playback.confirmation, 'requested');
    app.clock.advance(10_000);
    snap = await admin.snapshot();
    assert.equal(snap.playback.confirmation, 'unconfirmed');
    assert.ok(snap.alerts.some((alert) => alert.code === 'unconfirmed_command'));
    assert.equal(estimatePosition(snap, snap.serverTime).basis, 'unconfirmed', 'position is labelled, not presented as fact');

    await display.report('playing', 600);
    snap = await admin.snapshot();
    assert.equal(snap.playback.confirmation, 'confirmed');
    const live = estimatePosition(snap, snap.serverTime + 4000);
    assert.equal(live.basis, 'live');
    assert.ok(Math.abs(live.positionSec! - 604) < 0.5, `extrapolated ${live.positionSec}`);

    // The display disappears: lease expires, state is offline, the position is explicitly last-known.
    app.clock.advance(16_000);
    snap = await admin.snapshot();
    assert.equal(playerState(snap), 'offline');
    assert.ok(snap.alerts.some((alert) => alert.code === 'player_offline'));
    const stale = estimatePosition(snap, snap.serverTime);
    assert.equal(stale.basis, 'stale');
    assert.equal(stale.positionSec, 600);
    assert.match(describeTurn(snap, snap.serverTime).detail, /offline/);
  } finally {
    await app.stop();
  }
});

test('seek, replay, and volume: guards, same-intent retries, and bounded slider traffic', async () => {
  const app = await startApp();
  try {
    const admin = await organizer(app);
    const display = await startNight(app, admin, [URLS.mix, URLS.song]);
    const runner = new CommandRunner(admin.send);
    const { entryId } = (await admin.snapshot()).nowPlaying!;
    const periodAnchor = (await admin.snapshot()).schedule.periodStartedAt;
    assert.notEqual(periodAnchor, null);

    assert.equal((await runner.run('Seek', 'playback.seek', { entryId, positionSec: 1200 })).status, 'ok');
    assert.equal((await display.desired())!.startPositionSec, 1200);
    assert.equal((await runner.run('Replay', 'playback.seek', { entryId, positionSec: 0 })).status, 'ok');
    assert.equal((await display.desired())!.startPositionSec, 0);
    const epoch = (await display.desired())!.seekSeq;
    assert.equal((await runner.run('Replay again', 'playback.seek', { entryId, positionSec: 0 })).status, 'ok');
    assert.equal((await display.desired())!.seekSeq, epoch + 1, 'a repeated replay is a new seek, so the display applies it');
    assert.equal((await admin.snapshot()).schedule.periodStartedAt, periodAnchor, 'seeking and replaying never move the request timer');

    // Skip, then a late seek aimed at the old item is refused instead of landing on the new one.
    assert.ok((await runner.run('Skip', 'playback.skip', { entryId })).status === 'ok');
    const late = await runner.run('Seek (late)', 'playback.seek', { entryId, positionSec: 30 });
    assert.equal(late.error?.code, 'GUARD_MISMATCH');

    // Fifty drag values wait until adjustment settles, then send only the final value.
    let t = 1_000_000;
    const queue = new Map<number, { at: number; cb: () => void }>();
    let timerId = 0;
    const timers: Timers = { now: () => t, set: (cb, ms) => { queue.set(++timerId, { at: t + ms, cb }); return timerId; }, clear: (id) => { queue.delete(id as number); } };
    const volume = new VolumeController(runner, { minIntervalMs: 250, timers });
    const pendingSeen: (number | null)[] = [];
    volume.onPending = (value) => pendingSeen.push(value);
    for (let i = 1; i <= 50; i++) volume.set(i / 100);
    assert.equal(volume.pending, true);
    assert.equal(volume.sent, 0, 'dragging does not immediately send commands');
    assert.equal(queue.size, 1, 'each adjustment replaces the debounce timer');
    t += 250;
    const fire = () => { const [id, timer] = queue.entries().next().value!; queue.delete(id); timer.cb(); };
    fire();
    await until(() => volume.sent === 1 && !volume.pending);
    assert.equal((await admin.snapshot()).playback.volume, 0.5, 'the last value always wins');
    assert.equal(pendingSeen.at(-1), null);
    const volumeEvents = ((await (await admin.fetch('/api/v1/events?after=0')).json()) as { events: { type: string }[] }).events.filter((e) => e.type === 'playback.volume');
    assert.equal(volumeEvents.length, 1, 'the service saw one volume command for 50 slider values');
    // Out-of-range input never leaves the client.
    volume.set(7);
    t += 250;
    fire();
    await until(() => !volume.pending);
    assert.equal((await admin.snapshot()).playback.volume, 1);
    void display;
  } finally {
    await app.stop();
  }
});

test('reorder and remove both queues; removing the playing request ends its turn without refund', async () => {
  const app = await startApp({ periodMs: 60_000 });
  try {
    const a = await organizer(app, 'organizer1');
    const b = await organizer(app, 'organizer2');
    const display = await startNight(app, a, [URLS.mix, URLS.mix2, URLS.song]);
    const move = async (who: HttpClient, kind: 'master' | 'request', id: string, direction: 'up' | 'down') => {
      const snap = await who.snapshot();
      const ids = kind === 'master' ? snap.master!.map((m) => m.id) : waitingRequests(snap).map((r) => r.id);
      const anchor = moveAnchor(ids, ids.indexOf(id), direction)!;
      const res = await who.raw(kind === 'master' ? 'master.move' : 'request.move', { entryId: id, ...anchor });
      assert.ok(res.body.ok, JSON.stringify(res.body));
    };
    const masterTitles = async (who: HttpClient) => (await who.snapshot()).master!.map((m) => m.title);

    const ids = (await a.snapshot()).master!.map((m) => m.id);
    assert.deepEqual(await masterTitles(a), ['Hour Mix', 'Second Mix', 'Master Song']);
    await move(a, 'master', ids[2]!, 'up');
    assert.deepEqual(await masterTitles(b), ['Hour Mix', 'Master Song', 'Second Mix'], 'the other organizer sees the new order');
    await move(b, 'master', ids[0]!, 'down');
    assert.deepEqual(await masterTitles(a), ['Master Song', 'Hour Mix', 'Second Mix']);
    assert.equal(moveAnchor(ids, 0, 'up'), null, 'no-op at the top');
    assert.equal(moveAnchor(ids, 2, 'down'), null, 'no-op at the bottom');

    const alice = await app.client().login('alice');
    const bob = await app.client().login('bob');
    const r1 = await submit(app, alice, URLS.r1);
    const r2 = await submit(app, bob, URLS.r2);
    const r3 = await submit(app, alice, URLS.r3);
    await move(a, 'request', r3, 'up');
    await move(a, 'request', r3, 'up');
    assert.deepEqual(waitingRequests(await b.snapshot()).map((r) => r.id), [r3, r1, r2]);
    const sigBefore = queueSignature(await b.snapshot());
    await move(a, 'request', r3, 'down');
    assert.notEqual(queueSignature(await b.snapshot()), sigBefore, 'an external reorder changes the queue signature');
    assert.ok((await b.raw('request.remove', { entryId: r2 })).body.ok);
    assert.deepEqual(waitingRequests(await a.snapshot()).map((r) => r.id), [r1, r3]);

    // Run the clock past the period with a reporting display: the mix is interrupted for the first request.
    for (let i = 0; i < 13; i++) {
      app.clock.advance(5000);
      await display.report('playing');
      await app.service.reconcile();
    }
    let snap = await a.snapshot();
    assert.equal(snap.schedule.phase, 'request', 'the first ready request is now playing');
    assert.equal(snap.nowPlaying!.entryId, r1);
    assert.ok(snap.suspendedMaster, 'the interrupted master is suspended, not lost');
    const mixAtInterrupt = snap.suspendedMaster!.entryId;
    assert.equal(describeTurn(snap, snap.serverTime).kind, 'in_request');

    // Remove the playing request: queue-and-playback action. Turn ends, master resumes, allowance stays spent.
    assert.equal((await alice.snapshot()).quota!.used, 2);
    assert.ok((await a.raw('request.remove', { entryId: r1 })).body.ok);
    snap = await a.snapshot();
    assert.equal(snap.schedule.phase, 'master');
    assert.equal(snap.nowPlaying!.entryId, mixAtInterrupt, 'the suspended mix resumes');
    assert.equal(snap.suspendedMaster, null);
    assert.equal((await alice.snapshot()).quota!.used, 2, 'removal does not refund');
    assert.deepEqual(waitingRequests(snap).map((r) => r.id), [r3], 'only one request per turn: the next waits a full period');
    assert.equal(snap.schedule.turnDue, false);

    // Master removal: unknown ids are conflicts, current item removal advances.
    const gone = await a.raw('master.remove', { entryId: r1 });
    assert.equal(gone.body.ok ? 'ok' : gone.body.error.code, 'NOT_FOUND');
    assert.ok((await a.raw('master.remove', { entryId: ids[2]! })).body.ok);
    assert.deepEqual((await b.snapshot()).master!.map((m) => m.id), [ids[0], ids[1]]);
  } finally {
    await app.stop();
  }
});

test('closing a night uses the revision the organizer confirmed against', async () => {
  const app = await startApp();
  try {
    const admin = await organizer(app);
    await startNight(app, admin);
    const alice = await app.client().login('alice');
    await submit(app, alice, URLS.r1);
    const seen = await admin.snapshot();
    await submit(app, alice, URLS.r2); // changes while the organizer is reading the confirmation
    const runner = new CommandRunner(admin.send);

    const stale = await runner.run('Close night', 'night.close', {}, { expectedRevision: seen.revision });
    assert.equal(stale.error?.code, 'REVISION_CONFLICT');
    assert.equal(explainError(stale.error!, 'night.close').tone, 'conflict');
    assert.equal((await admin.snapshot()).night!.status, 'open', 'nothing was closed on stale information');

    const fresh = await admin.snapshot();
    assert.equal(fresh.requests.filter((r) => r.status === 'ready').length, 2);
    const ok = await runner.run('Close night', 'night.close', {}, { expectedRevision: fresh.revision });
    assert.equal(ok.status, 'ok');
    const closed = await admin.snapshot();
    assert.equal(closed.night!.status, 'closed');
    assert.equal(closed.schedule.intent, 'paused');
    assert.equal(waitingRequests(closed).length, 0);
    assert.equal(describeTurn(closed, closed.serverTime).kind, 'night_closed');
    // Opening twice (two organizers) gives conflict feedback.
    assert.ok((await admin.raw('night.open', {})).body.ok);
    const again = await admin.raw('night.open', {});
    assert.equal(again.body.ok ? 'ok' : again.body.error.code, 'NIGHT_ALREADY_OPEN');
  } finally {
    await app.stop();
  }
});

test('the real client retries a lost response with the same commandId; the service applies it once', async () => {
  const app = await startApp();
  const admin = await organizer(app);
  const realFetch = globalThis.fetch;
  let delivered = 0;
  try {
    // Browser stand-in: relative URLs hit the service with the organizer's cookie; the first response is lost.
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const res = await admin.fetch(String(input), { ...init, headers: { ...(init?.headers as Record<string, string>), origin: ORIGIN } });
      delivered++;
      if (delivered === 1) throw new TypeError('network dropped the response');
      return res;
    }) as typeof fetch;
    assert.ok((await admin.raw('night.open', {})).body.ok);
    delivered = 0;
    const response = await sendCommand('master.add', { url: URLS.song }, { attempts: 3 });
    assert.ok(response.ok, JSON.stringify(response));
    assert.equal(response.replayed, true, 'second delivery was answered from the stored result');
    assert.equal(delivered, 2);
    assert.equal((await admin.snapshot()).master!.length, 1, 'one master item, not two');
  } finally {
    globalThis.fetch = realFetch;
    await app.stop();
  }
});

test('turn description follows the scheduler for pause, offline, empty and due turns', async () => {
  const app = await startApp({ periodMs: 60_000 });
  try {
    const admin = await organizer(app);
    assert.equal(describeTurn(await admin.snapshot(), app.clock.now()).kind, 'night_closed');
    assert.ok((await admin.raw('night.open', {})).body.ok);
    assert.equal(describeTurn(await admin.snapshot(), app.clock.now()).kind, 'not_started');
    const display = await startNight(app, admin, [URLS.mix], { nightOpen: true });
    let snap = await admin.snapshot();
    let turn = describeTurn(snap, snap.serverTime);
    assert.equal(turn.kind, 'counting');
    assert.equal(turn.periodRemainingMs, 60_000);
    assert.match(turn.detail, /No ready request yet/);
    assert.match(turn.detail, /mix/);

    const alice = await app.client().login('alice');
    await submit(app, alice, URLS.r1);
    snap = await admin.snapshot();
    assert.match(describeTurn(snap, snap.serverTime).detail, /1 ready request will take this turn/);

    // Pausing keeps the clock honest: still counting, and says so; due while paused waits for Play.
    assert.ok((await admin.raw('playback.pause', {})).body.ok);
    await display.report('paused');
    app.clock.advance(30_000);
    snap = await admin.snapshot();
    turn = describeTurn(snap, snap.serverTime);
    assert.equal(turn.periodRemainingMs, 30_000);
    assert.match(turn.detail, /Paused — the timer keeps running/);
    app.clock.advance(31_000);
    await app.service.reconcile();
    snap = await admin.snapshot();
    turn = describeTurn(snap, snap.serverTime);
    assert.equal(turn.kind, 'due');
    assert.match(turn.detail, /Press Play/);
  } finally {
    await app.stop();
  }
});

async function until(condition: () => boolean, ms = 3000) {
  const deadline = Date.now() + ms;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error('condition not reached');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

test('known service limitation: an already-open SSE stream keeps admin data after the session expires, so /admin also polls', async () => {
  const app = await startApp();
  const controller = new AbortController();
  try {
    const admin = await organizer(app);
    assert.ok((await admin.raw('night.open', {})).body.ok);
    const seen: { role: string; revision: number; hasMaster: boolean }[] = [];
    const res = await admin.fetch('/api/v1/stream', { signal: controller.signal });
    void (async () => {
      let buffer = '';
      for await (const chunk of res.body!) {
        buffer += Buffer.from(chunk).toString('utf8');
        let index;
        while ((index = buffer.indexOf('\n\n')) >= 0) {
          const data = buffer.slice(0, index).split('\n').find((l) => l.startsWith('data: '));
          buffer = buffer.slice(index + 2);
          if (data) { const s = JSON.parse(data.slice(6)); seen.push({ role: s.role, revision: s.revision, hasMaster: s.master !== undefined }); }
        }
      }
    })().catch(() => undefined);
    await until(() => seen.length > 0);
    app.clock.advance(13 * 3600_000); // session TTL is 12 h
    assert.equal((await admin.snapshot()).role, 'public', 'a fresh request sees the expiry (what the admin page polls)');
    const other = await organizer(app, 'organizer2');
    assert.ok((await other.raw('master.add', { url: URLS.song })).body.ok);
    await until(() => seen.some((s) => s.revision > seen[0]!.revision));
    assert.equal(seen.at(-1)!.role, 'admin', 'LIMITATION (proposal A2): the stale stream still receives admin snapshots');
    assert.equal(seen.at(-1)!.hasMaster, true);
  } finally {
    controller.abort();
    await app.stop();
  }
});

test('unsupported sources get specific, truthful explanations and nothing is added', async () => {
  const app = await startApp();
  try {
    const admin = await organizer(app);
    const runner = new CommandRunner(admin.send);
    const attempts = [
      ['https://open.spotify.com/track/1OAFmguvHB2OI2AMYXpmyG', /Spotify and Apple Music links cannot be played yet/],
      ['https://www.youtube.com/playlist?list=PLabc', /Playlists and albums cannot be imported yet/],
      ['https://music.apple.com/us/album/x/123456', /Playlists and albums cannot be imported yet/],
      ['https://example.com/track.mp3', /not a supported source/],
    ] as const;
    for (const [url, expected] of attempts) {
      const intent = await runner.run('Add', 'master.add', { url });
      assert.equal(intent.status, 'failed', url);
      assert.match(explainError(intent.error!, 'master.add').message, expected, url);
    }
    assert.equal((await admin.snapshot()).master!.length, 0);
  } finally {
    await app.stop();
  }
});


test('optimistic controls respond before network completion, reconcile by revision, and roll back failures', async () => {
  const app = await startApp();
  try {
    const admin = await organizer(app);
    await startNight(app, admin);
    const before = await admin.snapshot();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const runner = new CommandRunner(async (type, payload, options) => {
      await gate;
      return admin.send(type, payload, options);
    });
    const paused = runner.run('Pause', 'playback.pause', {});
    assert.equal(optimisticIntent(before, runner.getSnapshot(), ['playback.play', 'playback.pause'])?.type, 'playback.pause');
    const played = runner.run('Play', 'playback.play', {});
    assert.equal(optimisticIntent(before, runner.getSnapshot(), ['playback.play', 'playback.pause'])?.type, 'playback.play');
    release();
    const [pause, play] = await Promise.all([paused, played]);
    assert.ok(pause.revision! < play.revision!, 'rapid toggles reach the server in click order');
    assert.equal(optimisticIntent(before, runner.getSnapshot(), ['playback.play', 'playback.pause'])?.type, 'playback.play', 'old snapshots cannot undo local feedback');
    assert.equal(optimisticIntent(await admin.snapshot(), runner.getSnapshot(), ['playback.play', 'playback.pause']), null);
    await runner.run('Bad seek', 'playback.seek', { entryId: 'missing', positionSec: 12 });
    assert.equal(optimisticIntent(before, runner.getSnapshot(), ['playback.seek']), null, 'rejected changes roll back');
  } finally { await app.stop(); }
});

test('volume release flushes once, coalesces while sending, and cleans up scheduled work', async () => {
  let release!: () => void;
  const calls: number[] = [];
  const runner = new CommandRunner(async (type, payload, options) => {
    calls.push((payload as { volume: number }).volume);
    await new Promise<void>((resolve) => { release = resolve; });
    return { ok: true, commandId: options.commandId, revision: calls.length, replayed: false, result: {} } as never;
  });
  const volume = new VolumeController(runner);
  volume.begin();
  volume.set(.1);
  volume.set(.2);
  await new Promise((resolve) => setTimeout(resolve, 350));
  assert.deepEqual(calls, [], 'holding the slider never sends, even after the debounce interval');
  volume.flush();
  await until(() => calls.length === 1);
  volume.set(.3);
  volume.set(.7);
  volume.flush();
  assert.deepEqual(calls, [.2]);
  release();
  await until(() => calls.length === 2);
  assert.deepEqual(calls, [.2, .7]);
  release();
  await until(() => !volume.pending);
  volume.set(.7);
  volume.flush();
  await until(() => calls.length === 3);
  release();
  await until(() => !volume.pending);
  assert.deepEqual(calls, [.2, .7, .7], 'setting the same value again still settles');
  volume.set(.9);
  volume.dispose();
  assert.equal(volume.pending, false);
  await new Promise((resolve) => setTimeout(resolve, 350));
  assert.equal(calls.length, 3, 'unmount cancels unsent work');
});


test('volume acknowledgements never rewind the running seek clock', async () => {
  const app = await startApp();
  try {
    const admin = await organizer(app);
    const display = await startNight(app, admin, [URLS.mix]);
    const runner = new CommandRunner(admin.send);
    const entryId = (await admin.snapshot()).nowPlaying!.entryId;
    await runner.run('Seek', 'playback.seek', { entryId, positionSec: 120 });
    await display.report('playing', 120);
    app.clock.advance(4000);
    const before = await admin.snapshot();
    const positionBefore = estimatePosition(before, before.serverTime).positionSec;
    assert.equal(positionBefore, 124);
    assert.equal((await runner.run('Volume', 'playback.volume', { volume: .4 })).status, 'ok');
    const pending = await admin.snapshot();
    assert.equal(optimisticIntent(pending, runner.getSnapshot(), ['playback.seek']), null, 'volume cannot resurrect the previously acknowledged seek');
    assert.equal(pending.playback.confirmation, 'requested');
    assert.equal(estimatePosition(pending, pending.serverTime).positionSec, positionBefore, 'volume does not jump back to the 120-second heartbeat');
    app.clock.advance(2000);
    const later = await admin.snapshot();
    assert.equal(estimatePosition(later, later.serverTime).positionSec, 126, 'the clock keeps advancing while volume awaits acknowledgement');
    await display.report('playing', 126);
    const confirmed = await admin.snapshot();
    assert.equal(estimatePosition(confirmed, confirmed.serverTime).positionSec, 126, 'acknowledgement does not jump forward again');
    assert.ok((await admin.raw('playback.pause', {})).body.ok);
    app.clock.advance(2000);
    const paused = await admin.snapshot();
    assert.equal(estimatePosition(paused, paused.serverTime).positionSec, 126, 'pause still stops extrapolation');
  } finally { await app.stop(); }
});
