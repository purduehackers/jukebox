// Wording, timing honesty, and QR-origin rules for the attendee page.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { test } from 'node:test';
import type { ErrorCode, RequestEntryView, RequestStatus, Snapshot } from '../src/contract/types.ts';
import { OriginError, queueEntryUrl } from '../app/src/queue/origin.ts';
import { STATUS_COPY, describeError, describeEstimate, estimateTurn, formatDuration, readDisambiguation } from '../app/src/queue/model.ts';
import { checkReachable } from '../scripts/queue-qr.ts';

const ALL_CODES: ErrorCode[] = [
  'BAD_REQUEST', 'UNAUTHENTICATED', 'FORBIDDEN', 'NOT_FOUND', 'REVISION_CONFLICT', 'IDEMPOTENCY_MISMATCH', 'GUARD_MISMATCH', 'NIGHT_CLOSED',
  'NIGHT_ALREADY_OPEN', 'QUOTA_EXCEEDED', 'DUPLICATE_REQUEST', 'INVALID_SOURCE', 'SOURCE_UNSUPPORTED', 'SOURCE_UNAVAILABLE', 'DURATION_REJECTED',
  'RATE_LIMITED', 'LEASE_HELD', 'STALE_LEASE', 'DEVICE_REVOKED', 'PAIRING_INVALID', 'NOTHING_PLAYABLE', 'INTERNAL',
];

test('every contract error code has attendee wording, and the user-facing ones say what to do', () => {
  for (const code of ALL_CODES) {
    const copy = describeError({ code, message: 'server detail', retryable: false });
    assert.ok(copy.title.length > 3 && copy.body.length > 10, code);
  }
  const expectations: [ErrorCode, RegExp][] = [
    ['INVALID_SOURCE', /full https link/i],
    ['SOURCE_UNSUPPORTED', /playlists|albums/i],
    ['SOURCE_UNAVAILABLE', /private|removed|region/i],
    ['DURATION_REJECTED', /6 minutes/],
    ['DUPLICATE_REQUEST', /already/i],
    ['QUOTA_EXCEEDED', /used all|fresh allowance/i],
    ['NIGHT_CLOSED', /no open night/i],
    ['UNAUTHENTICATED', /purdue hackers id/i],
    ['GUARD_MISMATCH', /different recording/i],
  ];
  for (const [code, pattern] of expectations) {
    const copy = describeError({ code, message: '', retryable: false });
    assert.match(`${copy.title} ${copy.body}`, pattern, code);
  }
  assert.equal(describeError({ code: 'RATE_LIMITED', message: '', retryable: true }).retry, true);
});

test('matching failures surface candidates; malformed or non-YouTube candidates are dropped', () => {
  const good = { url: 'https://www.youtube.com/watch?v=abcdefghijk', title: 'Song', channel: 'Artist - Topic', durationSec: 201, notes: ['extra marker: live'] };
  const parsed = readDisambiguation({
    kind: 'ambiguous',
    requested: { title: 'Song', artist: 'Artist', durationSec: 200 },
    candidates: [good, { ...good, url: 'https://evil.example/x' }, { ...good, url: 'javascript:alert(1)' }, { title: 'no url' }, 'junk', good, good, good],
  });
  assert.equal(parsed?.kind, 'ambiguous');
  assert.equal(parsed?.candidates.length, 3, 'capped at three');
  assert.ok(parsed?.candidates.every((c) => c.url.startsWith('https://www.youtube.com/watch?v=')));
  assert.equal(readDisambiguation({ kind: 'something-else' }), null);
  assert.equal(readDisambiguation(undefined), null);
  const copy = describeError({ code: 'SOURCE_UNAVAILABLE', message: 'Paste the YouTube link of the version you want.', retryable: false, details: { kind: 'version_mismatch' } });
  assert.equal(copy.title, 'We only found different versions');
  assert.equal(copy.body, 'Paste the YouTube link of the version you want.');
});

test('every request state explains itself and its allowance effect', () => {
  const states: RequestStatus[] = ['preparing', 'ready', 'playing', 'played', 'failed', 'removed', 'skipped', 'archived'];
  for (const status of states) assert.ok(STATUS_COPY[status].label && STATUS_COPY[status].detail, status);
  assert.equal(STATUS_COPY.failed.allowance, 'refunded');
  for (const s of ['removed', 'skipped'] as const) assert.match(STATUS_COPY[s].detail, /still counts/i);
});

const entry = (id: string, status: RequestStatus, durationSec = 180): RequestEntryView => ({ id, title: id, artist: null, durationSec, status });
function snap(over: Partial<Pick<Snapshot, 'night' | 'schedule' | 'requests'>>): Pick<Snapshot, 'night' | 'schedule' | 'requests'> {
  return {
    night: { id: 'n', status: 'open', openedAt: 0, closedAt: null },
    schedule: { phase: 'master', intent: 'playing', periodStartedAt: 0, periodMs: 15 * 60_000, turnDue: false, dueReason: null },
    requests: [],
    ...over,
  };
}

test('timing estimates are rough, rounded up, and never promise a guarantee', () => {
  const MIN = 60_000;
  const requests = [entry('a', 'ready', 180), entry('b', 'ready', 240), entry('c', 'preparing', 200)];
  // 6 min into the period: first request is about 9 min away (rounds up to 10).
  const first = estimateTurn(snap({ requests }), 'a', 6 * MIN);
  assert.deepEqual(first, { kind: 'waiting', ahead: 0, approxMinutes: 10 });
  assert.match(describeEstimate(first), /next.*roughly 10 minutes.*sooner or later/i);
  // Behind one request: + its 3 min + a full 15 min master period.
  const second = estimateTurn(snap({ requests }), 'b', 6 * MIN);
  assert.deepEqual(second, { kind: 'waiting', ahead: 1, approxMinutes: 30 });
  assert.match(describeEstimate(second), /1 request ahead/);
  assert.doesNotMatch(describeEstimate(second), /guarantee|exactly|will play at/i);
  assert.match(describeEstimate(estimateTurn(snap({ requests }), 'a', 14.5 * MIN)), /within about 5 minutes/);
  // Past due: no clock-based number at all.
  const due = estimateTurn(snap({ requests, schedule: { ...snap({}).schedule, turnDue: true, dueReason: 'paused' } }), 'a', 20 * MIN);
  assert.equal(due.kind, 'turn-due');
  assert.match(describeEstimate(due), /paused.*organizer to resume/i);
  const notStarted = estimateTurn(snap({ requests, schedule: { ...snap({}).schedule, periodStartedAt: null } }), 'a', 0);
  assert.equal(notStarted.kind, 'clock-not-started');
  // While a request is playing, the next turn is a full period after it ends.
  const during = estimateTurn(snap({ requests: [entry('now', 'playing', 200), entry('a', 'ready')], schedule: { ...snap({}).schedule, phase: 'request' } }), 'a', 0);
  assert.deepEqual(during, { kind: 'waiting', ahead: 0, approxMinutes: 20 });
  assert.equal(estimateTurn(snap({ requests }), 'zzz', 0).kind, 'not-waiting');
  assert.equal(estimateTurn(snap({ requests: [entry('now', 'playing')] }), 'now', 0).kind, 'playing');
  assert.equal(estimateTurn(snap({ requests, night: { id: 'n', status: 'closed', openedAt: 0, closedAt: 1 } }), 'a', 0).kind, 'closed');
});

test('durations format as m:ss', () => {
  assert.equal(formatDuration(0), '0:00');
  assert.equal(formatDuration(65.4), '1:05');
  assert.equal(formatDuration(359.999), '6:00');
  assert.equal(formatDuration(null), '–:––');
});

test('QR origin: the canonical route works; anything a phone cannot reach is refused', async () => {
  assert.equal(queueEntryUrl('https://jukebox.purduehackers.com'), 'https://jukebox.purduehackers.com/queue');
  assert.equal(queueEntryUrl('https://jukebox.purduehackers.com/anything?x=1'), 'https://jukebox.purduehackers.com/queue');
  assert.equal(queueEntryUrl('http://192.168.1.20:5173'), 'http://192.168.1.20:5173/queue', 'LAN test origin');
  assert.equal(queueEntryUrl('https://abc.trycloudflare.com'), 'https://abc.trycloudflare.com/queue');
  for (const bad of [
    'http://localhost:5173', 'http://127.0.0.1:8980', 'http://127.1.2.3', 'http://[::1]:5173', 'http://0.0.0.0:5173', 'https://dev.localhost',
    'http://jukebox.purduehackers.com', 'ftp://192.168.1.2', 'https://user:pw@jukebox.purduehackers.com', 'not an origin', '',
  ]) {
    assert.throws(() => queueEntryUrl(bad), OriginError, bad);
  }
});

test('reachability check requires the health endpoint and the /queue page to answer', async () => {
  const server = createServer((req, res) => {
    res.statusCode = req.url === '/healthz' || req.url === '/queue' ? 200 : 404;
    res.end('ok');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  await checkReachable(origin); // loopback is fine for the reachability probe itself; queueEntryUrl guards the QR
  server.close();
  server.closeAllConnections();
  await assert.rejects(() => checkReachable(origin, 500));
});
