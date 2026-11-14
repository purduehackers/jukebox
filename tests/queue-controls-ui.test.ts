// Admin queue-control UI states, rendered from real service snapshots (pure HTML, no browser),
// plus the mode-aware view-models shared with /display and /queue. Interaction: scripts/verify-admin.py.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createElement as reactCreateElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import * as rawViews from '../app/src/admin/views.tsx';
import { describeTurn, explainError } from '../app/src/admin/derive.ts';
import { displayModel } from '../app/src/display/model.ts';
import { describeEstimate, estimateTurn } from '../app/src/queue/model.ts';
import { MIN, URLS, harness, submit } from './helpers.ts';

const views = rawViews as unknown as Record<'QueueControls' | 'RequestQueuePanel' | 'NowPlayingPanel' | 'TurnPanel', (props: any) => unknown>;
const createElement = (view: (props: any) => unknown, props: any) => renderToStaticMarkup(reactCreateElement(view as never, props));

const noop = () => { throw new Error('not called during render'); };
const actions = new Proxy({}, { get: () => noop });
const html = (markup: string) => markup;
const text = (markup: string) => markup.replace(/<[^>]+>/g, ' ').replace(/&#x27;/g, "'").replace(/\s+/g, ' ');

async function scene() {
  const h = harness();
  const p = await h.startNight([URLS.mix]);
  await submit(h, h.alice, URLS.r1);
  await submit(h, h.bob, URLS.r2);
  await h.advance(4 * MIN, p);
  return { h, p };
}
const controls = (snapshot: ReturnType<typeof harness>['svc']['snapshot'] extends (...a: any) => infer S ? S : never, serverNow = snapshot.serverTime) =>
  html(createElement(views.QueueControls, { snapshot, serverNow, actions }));

test('mode selector reflects the service mode and interval without extra helper controls', async () => {
  const { h } = await scene();
  let out = controls(h.snap());
  assert.match(out, /role="radiogroup"/);
  assert.match(out, /data-mode="auto"[^>]*aria-checked="true"|aria-checked="true"[^>]*data-mode="auto"/);
  assert.doesNotMatch(out, /data-testid="mode-help"/);
  assert.match(out, /id="adm-interval"[^>]*value="15"/);
  assert.doesNotMatch(text(out), /Use 15 min/);
  await h.ok(h.admin, 'queue.interval', { periodMs: 10 * MIN });
  await h.ok(h.admin, 'queue.mode', { mode: 'master' });
  out = controls(h.snap());
  assert.match(out, /aria-checked="true"[^>]*data-mode="master"|data-mode="master"[^>]*aria-checked="true"/);
  assert.match(out, /value="10"/);
  assert.doesNotMatch(text(out), /Use 15 min/);

});

test('Requests only is unavailable before the night starts', async () => {
  const h = harness();
  const out = controls(h.snap());
  assert.match(out, /data-mode="requests"[^>]*disabled=""|disabled=""[^>]*data-mode="requests"/);
  assert.match(out, /Start the night first/);
});

test('Play now: row action names what it interrupts, and is disabled with a reason while a request plays', async () => {
  const { h } = await scene();
  const panel = (snapshot = h.snap()) => html(createElement(views.RequestQueuePanel, { snapshot, actions }));
  let out = panel();
  assert.equal((out.match(/Play now…/g) ?? []).length, 2);
  assert.doesNotMatch(out, /disabled="" title="A request is playing/);
  await h.ok(h.admin, 'request.playNow', { entryId: h.snap().requests[0]!.id });
  out = panel();
  assert.match(out, /title="A request is playing\. Move this one to the top to play it next\."/);
  assert.match(out, /disabled=""/);
});

test('Waiting for requests is shown instead of "Nothing playing" when Requests only is idle', async () => {
  const h = harness();
  const p = await h.startNight([URLS.mix]);
  await h.advance(MIN, p);
  await h.ok(h.admin, 'queue.mode', { mode: 'requests' });
  const snapshot = h.snap();
  const out = text(html(createElement(views.NowPlayingPanel, { snapshot, serverNow: snapshot.serverTime, actions, pendingVolume: null })));
  assert.match(out, /Waiting for requests/);
  assert.match(out, /“Hour Mix” resumes at/);
  assert.doesNotMatch(out, /Nothing playing/);
  assert.match(text(html(createElement(views.TurnPanel, { snapshot, serverNow: snapshot.serverTime }))), /Waiting for requests/);
});

test('turn line is mode-aware and uses the configured interval', async () => {
  const { h } = await scene();
  const turn = () => describeTurn(h.snap(), h.snap().serverTime);
  assert.equal(turn().kind, 'counting');
  await h.ok(h.admin, 'queue.interval', { periodMs: 5 * MIN });
  assert.equal(turn().periodRemainingMs, 1 * MIN, 'countdown uses the 5 min interval');
  await h.ok(h.admin, 'queue.mode', { mode: 'master' });
  assert.equal(turn().kind, 'master_only');
  assert.match(turn().detail, /Request turns are off; 2 waiting/);
  await h.ok(h.admin, 'queue.mode', { mode: 'requests' });
  assert.equal(turn().kind, 'requests_only');
  assert.match(turn().detail, /1 more waiting/);
});

test('error wording for the new failures', () => {
  assert.match(explainError({ code: 'NOT_READY', message: 'x', retryable: false }, 'request.playNow').message, /still loading/);
  assert.match(explainError({ code: 'GUARD_MISMATCH', message: 'x', retryable: false }, 'request.playNow').message, /already playing/);
  assert.match(explainError({ code: 'GUARD_MISMATCH', message: 'x', retryable: false }, 'playback.skip').message, /no longer playing/);
});

test('display and attendee views stop promising a countdown outside Auto', async () => {
  const { h } = await scene();
  const now = h.snap().serverTime;
  assert.match(displayModel(h.snap(), now).turn, /^in /);
  await h.ok(h.admin, 'queue.interval', { periodMs: 10 * MIN });
  assert.match(displayModel(h.snap(), now).turn, /^in 06:00$/, 'display countdown follows the configured interval');
  await h.ok(h.admin, 'queue.mode', { mode: 'master' });
  assert.equal(displayModel(h.snap(), now).turn, 'Master music');
  const waitingId = h.snap().requests[0]!.id;
  assert.equal(estimateTurn(h.snap(), waitingId, now).kind, 'master-only');
  assert.match(describeEstimate(estimateTurn(h.snap(), waitingId, now)), /paused request turns/);
  await h.ok(h.admin, 'queue.mode', { mode: 'requests' });
  const second = h.snap().requests[1]!.id;
  assert.deepEqual(estimateTurn(h.snap(), second, now), { kind: 'requests-only', ahead: 0 }, 'the first became the playing request');
});
