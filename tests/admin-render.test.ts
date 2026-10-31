// Component tests without a browser dependency: Vite loads the real TSX views in SSR mode and
// react-dom/server renders them from snapshots taken from the live service. Interaction and
// layout are covered by scripts/verify-admin.py (real Firefox) — this covers the truthful states.
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { createServer } from 'vite';
import type { ViteDevServer } from 'vite';
import { renderToStaticMarkup } from 'react-dom/server';
import { createElement } from 'react';
import type { ComponentType } from 'react';
import type { Snapshot } from '../src/contract/types.ts';
import { URLS } from './helpers.ts';
import { ScriptedDisplay, organizer, startApp, startNight } from './admin-helpers.ts';

// Loosely typed on purpose: the root tsconfig has no JSX; the app project type-checks the real components.
type Views = Record<'AccessGate' | 'NowPlayingPanel' | 'TurnPanel' | 'RequestQueuePanel' | 'MasterQueuePanel' | 'AlertsBand' | 'NightPanel' | 'DevicesPanel' | 'ActivityPanel', ComponentType<any>>;
type Actions = never;
let vite: ViteDevServer;
let views: Views;

before(async () => {
  vite = await createServer({ root: 'app', configFile: false, logLevel: 'silent', appType: 'custom', server: { middlewareMode: true, hmr: false, ws: false }, optimizeDeps: { noDiscovery: true, include: [] } });
  views = (await vite.ssrLoadModule('/src/admin/views.tsx')) as Views;
});
after(async () => {
  await vite.close();
});

const noop = () => { throw new Error('not called during render'); };
const actions = new Proxy({}, { get: () => noop }) as Actions;
const html = (node: ReturnType<typeof createElement>) => renderToStaticMarkup(node);
const text = (markup: string) => markup.replace(/<[^>]+>/g, ' ').replace(/&#x27;/g, "'").replace(/\s+/g, ' ');

test('access gates: signed out, expired, and forbidden are distinct and actionable', () => {
  const out = text(html(createElement(views.AccessGate, { access: { state: 'signed_out', expired: false }, onRetry: noop })));
  assert.match(out, /Organizer sign-in/);
  const expired = html(createElement(views.AccessGate, { access: { state: 'signed_out', expired: true }, onRetry: noop }));
  assert.match(text(expired), /Session expired/);
  assert.match(text(expired), /Nothing you tried since then was applied/);
  assert.match(expired, /href="\/auth\/login\?returnTo=\/admin"/);
  const forbidden = text(html(createElement(views.AccessGate, { access: { state: 'forbidden', name: 'alice' }, onRetry: noop })));
  assert.match(forbidden, /Organizer access required/);
  assert.match(forbidden, /signed in as alice/);
});

test('now playing: requested vs confirmed vs unconfirmed vs offline are rendered distinctly', async () => {
  const app = await startApp();
  try {
    const admin = await organizer(app);
    assert.ok((await admin.raw('night.open', {})).body.ok);
    assert.ok((await admin.raw('master.add', { url: URLS.mix })).body.ok);
    await app.service.reconcile();
    const render = (snapshot: Snapshot, pendingVolume: number | null = null) =>
      html(createElement(views.NowPlayingPanel, { snapshot, serverNow: snapshot.serverTime, actions, pendingVolume }));

    assert.match(render(await admin.snapshot()), /No display connected/);
    assert.match(text(render(await admin.snapshot())), /Pair one below/);

    const display = await ScriptedDisplay.pair(app, admin);
    assert.match(render(await admin.snapshot()), /Display needs activation/);
    assert.match(text(render(await admin.snapshot())), /Firefox blocked autoplay/);

    assert.ok((await admin.raw('playback.play', {})).body.ok);
    let out = render(await admin.snapshot());
    assert.match(out, /data-testid="confirmation">Requested</);
    assert.match(text(out), /has not confirmed it yet/);
    assert.match(out, /Hour Mix/);
    assert.match(out, />Master</);

    await display.report('playing', 42);
    out = render(await admin.snapshot());
    assert.match(out, /Confirmed by display/);
    assert.match(out, /Display playing/);
    assert.match(text(out), /This does not prove the room can hear it/);
    assert.match(out, /Pause</, 'playing intent shows Pause');
    assert.match(out, /data-testid="position">0:42</);

    const { entryId } = (await admin.snapshot()).nowPlaying!;
    assert.ok((await admin.raw('playback.seek', { entryId, positionSec: 100 })).body.ok);
    app.clock.advance(11_000);
    out = render(await admin.snapshot());
    assert.match(out, /Unconfirmed</);
    assert.match(text(out), /may not have happened/);
    assert.match(text(out), /not confirmed by display/);

    assert.match(text(render(await admin.snapshot(), 0.37)), /37% .*sending/, 'a slider value being sent is not shown as saved');
    await display.report('buffering', 100);
    assert.match(render(await admin.snapshot()), /Display buffering/);
    await display.report('error', 100);
    assert.match(text(render(await admin.snapshot())), /Display error/);

    await display.report('playing', 100); // the seek is acknowledged, then the display goes silent
    app.clock.advance(20_000);
    out = render(await admin.snapshot());
    assert.match(out, /Display offline/);
    assert.match(out, /Last change was confirmed; display now silent/);
    assert.doesNotMatch(out, />Confirmed by display</, 'a lapsed confirmation is not presented as current');
    assert.match(text(out), /Position below is the last report, not live/);
    assert.match(text(out), /last report, display offline/);
  } finally {
    await app.stop();
  }
});

test('alerts band, request turn, queues, and unsupported-source guidance', async () => {
  const app = await startApp({ periodMs: 60_000 });
  try {
    const admin = await organizer(app);
    const display = await startNight(app, admin, [URLS.mix]);
    const alice = await app.client().login('alice');
    assert.ok((await alice.raw('request.submit', { url: URLS.r1 })).body.ok);
    await app.service.reconcile();
    const snap = await admin.snapshot();

    const turn = text(html(createElement(views.TurnPanel, { snapshot: snap, serverNow: snap.serverTime })));
    assert.match(turn, /Master period ends in 1:00/);
    assert.match(turn, /1 ready request will take this turn/);
    assert.match(turn, /Elapsed time counts through pause, buffering and offline/);

    const requests = html(createElement(views.RequestQueuePanel, { snapshot: snap, actions }));
    assert.match(requests, /Request One/);
    assert.match(text(requests), /from alice/);
    assert.match(requests, /Remove…/);

    const master = html(createElement(views.MasterQueuePanel, { snapshot: snap, actions, lastAdd: null }));
    assert.match(text(master), /Spotify and Apple Music links \(no audio matching exists\)/);
    assert.match(text(master), /playlist\/album import/);
    assert.match(text(master), /mix \(interruptible\)/);
    assert.match(master, /Move up/);

    const failedAdd = { id: 'x', label: 'Add', type: 'master.add', payload: {}, status: 'failed', replayed: false, startedAt: 0, finishedAt: 1, attempts: 1,
      error: { code: 'SOURCE_UNSUPPORTED', message: 'Spotify/Apple Music matching is not implemented yet', retryable: false } } as const;
    const withError = text(html(createElement(views.MasterQueuePanel, { snapshot: snap, actions, lastAdd: failedAdd })));
    assert.match(withError, /cannot be played yet/);

    // Offline display + conflicts surface as alerts; an external queue change can be dismissed.
    app.clock.advance(16_000);
    const offline = await admin.snapshot();
    const band = html(createElement(views.AlertsBand, { snapshot: offline, link: 'reconnecting', external: true, onAckExternal: noop }));
    assert.match(band, /data-alert="player_offline"/);
    assert.match(text(band), /Connection to the jukebox service was lost/);
    assert.match(band, /data-alert="external_change"/);
    assert.equal(html(createElement(views.AlertsBand, { snapshot: snap, link: 'live', external: false, onAckExternal: noop })), '');
    void display;
  } finally {
    await app.stop();
  }
});

test('night and device panels; activity list explains failures and offers retry only when safe', async () => {
  const app = await startApp();
  try {
    const admin = await organizer(app);
    const snapClosed = await admin.snapshot();
    assert.match(text(html(createElement(views.NightPanel, { snapshot: snapClosed, actions }))), /No night has been opened yet/);
    await startNight(app, admin);
    const snap = await admin.snapshot();
    const night = html(createElement(views.NightPanel, { snapshot: snap, actions }));
    assert.match(night, /Close night…/);

    const pairing = { name: 'Wall Firefox', code: 'ABCD2345', expiresAt: app.clock.now() + 600_000 };
    const devices = html(createElement(views.DevicesPanel, { devices: snap.devices!, pairing, actions }));
    assert.match(devices, /data-testid="pairing-code">ABCD2345</);
    assert.match(text(devices), /shown once and works once/);
    assert.match(devices, /plays audio/);
    assert.match(devices, /Revoke…/);

    const base = { type: 'playback.skip', payload: {}, replayed: false, startedAt: 0, finishedAt: 1, attempts: 1 } as const;
    const intents = [
      { ...base, id: '1', label: 'Skip current item', status: 'failed', error: { code: 'GUARD_MISMATCH', message: 'That item is no longer playing', retryable: false } },
      { ...base, id: '2', label: 'Set volume 40%', status: 'failed', error: { code: 'INTERNAL', message: 'Network error: down', retryable: true } },
      { ...base, id: '3', label: 'Pause', status: 'ok', error: null, replayed: true },
      { ...base, id: '4', label: 'Play', status: 'pending', error: null },
    ] as const;
    const activity = html(createElement(views.ActivityPanel, { intents: [...intents], actions }));
    assert.match(text(activity), /another organizer or the schedule moved on/);
    assert.match(activity, /not applied/);
    assert.equal((activity.match(/>Retry</g) ?? []).length, 1, 'only the retryable failure offers Retry');
    assert.match(text(activity), /Already applied earlier/);
    assert.match(text(activity), /sending…/);
  } finally {
    await app.stop();
  }
});
