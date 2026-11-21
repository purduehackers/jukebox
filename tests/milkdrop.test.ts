import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { displayFixture } from '../src/display/fixtures.ts';
import { DisplayView } from '../src/display/DisplayPage.tsx';
import * as rawViews from '../src/admin/views.tsx';
import type { Intent } from '../src/admin/intents.ts';
import {
  computeRenderSize,
  extractBasePresetKeys,
  extractButterchurn,
  extractPresetMap,
  nextPinnedPreset,
  pickNextPreset,
  scaleTimeDomainSamples,
  sortedPresetNames,
} from '../src/visual/milkdrop.ts';
import { harness } from './helpers.ts';
import { organizer, startApp } from './admin-helpers.ts';

const views = rawViews as unknown as Record<'VisualizerControls', (props: Record<string, unknown>) => unknown>;
const renderView = (view: (props: Record<string, unknown>) => unknown, props: Record<string, unknown>) =>
  renderToStaticMarkup(createElement(view as never, props));

test('butterchurn module unwrap helpers handle CJS/UMD/ESM wrappers and filter invalid presets', () => {
  const createVisualizer = () => ({ loadPreset() {}, setRendererSize() {}, render() {}, loseGLContext() {} });
  class FakeButterchurn {
    static createVisualizer = createVisualizer;
  }
  assert.equal(extractButterchurn({ createVisualizer }).createVisualizer, createVisualizer);
  assert.equal(extractButterchurn({ default: FakeButterchurn }).createVisualizer, createVisualizer);
  assert.equal(extractButterchurn({ default: { createVisualizer } }).createVisualizer, createVisualizer);
  assert.equal(extractButterchurn({ default: { default: { createVisualizer } } }).createVisualizer, createVisualizer);
  assert.throws(() => extractButterchurn({ default: {} }), /createVisualizer/);

  const validPreset = { baseVals: { decay: 0.98 } };
  const map = extractPresetMap({
    default: {
      getPresets: () => ({
        alpha: validPreset,
        __esModule: true,
        bad: { notAPreset: true },
      }),
    },
  });
  assert.deepEqual(Object.keys(map), ['alpha']);
  assert.equal(map.alpha, validPreset);

  const directMap = extractPresetMap({ default: { beta: validPreset, empty: null } });
  assert.deepEqual(Object.keys(directMap), ['beta']);

  const keys = extractBasePresetKeys({
    default: {
      getBasePresetKeys: () => ({ presets: ['Zebra', 'alpha', 42, 'Beta'], chunk: 'base' }),
    },
  });
  assert.deepEqual(keys, ['alpha', 'Beta', 'Zebra']);
  assert.deepEqual(sortedPresetNames({ zeta: 1, Alpha: 2, beta: 3 }), ['Alpha', 'beta', 'zeta']);
});

test('preset cycling helpers pick non-repeating auto presets and wrap pinned presets', () => {
  assert.equal(pickNextPreset([], null), null);
  assert.equal(pickNextPreset(['only'], 'only'), 'only');

  const names = ['a', 'b', 'c'];
  for (let i = 0; i < 30; i++) {
    const r = i / 30;
    const picked = pickNextPreset(names, 'b', () => r);
    assert.notEqual(picked, 'b');
    assert.ok(picked === 'a' || picked === 'c');
  }

  assert.equal(nextPinnedPreset(names, null), null);
  assert.equal(nextPinnedPreset([], 'a'), null);
  assert.equal(nextPinnedPreset(names, 'a'), 'b');
  assert.equal(nextPinnedPreset(names, 'c'), 'a');
  assert.equal(nextPinnedPreset(names, 'missing'), 'a');
});

test('computeRenderSize caps DPR at 1.5 and scales down cleanly past maxDim', () => {
  assert.deepEqual(computeRenderSize(1000, 500, 1), { width: 1000, height: 500 });
  assert.deepEqual(computeRenderSize(1000, 500, 3), { width: 1500, height: 750 });
  assert.deepEqual(computeRenderSize(2560, 1440, 2, 1920), { width: 1920, height: 1080 });
  assert.deepEqual(computeRenderSize(0, -10, NaN), { width: 1, height: 1 });
});

test('scaleTimeDomainSamples centers around 128 for silence, full gain, and partial fade', () => {
  const source = new Uint8Array([0, 128, 255, 178]);
  const dest = new Uint8Array(4);

  scaleTimeDomainSamples(source, dest, 0);
  assert.deepEqual(Array.from(dest), [128, 128, 128, 128]);

  scaleTimeDomainSamples(source, dest, 1);
  assert.deepEqual(Array.from(dest), [0, 128, 255, 178]);

  scaleTimeDomainSamples(source, dest, 0.5);
  assert.deepEqual(Array.from(dest), [64, 128, 192, 153]);
});

test('service visualizer commands are durable, idempotent, and never bump playback epoch', async (t) => {
  const h = harness();
  t.after(() => h.svc.close());
  await h.startNight();

  const initial = h.snap();
  assert.deepEqual(initial.visualizer, { mode: 'soundbar', preset: null, presetNonce: 0 });
  const initialEpoch = initial.playback.desiredEpoch;
  const initialRev = initial.revision;

  // Idempotent repeat does not bump revision.
  await h.ok(h.admin, 'visualizer.mode', { mode: 'soundbar' });
  assert.equal(h.snap().revision, initialRev);
  assert.equal(h.snap().playback.desiredEpoch, initialEpoch);

  // Switch to MilkDrop.
  await h.ok(h.admin, 'visualizer.mode', { mode: 'milkdrop' });
  const afterMode = h.snap();
  assert.equal(afterMode.visualizer.mode, 'milkdrop');
  assert.equal(afterMode.revision, initialRev + 1);
  assert.equal(afterMode.playback.desiredEpoch, initialEpoch, 'visualizer toggle never touches playback epoch');

  // Pin preset (idempotent when repeated without next).
  await h.ok(h.admin, 'visualizer.preset', { preset: 'Geiss - Cosmic Dust' });
  const pinned = h.snap();
  assert.deepEqual(pinned.visualizer, { mode: 'milkdrop', preset: 'Geiss - Cosmic Dust', presetNonce: 0 });
  assert.equal(pinned.playback.desiredEpoch, initialEpoch);
  const pinnedRev = pinned.revision;

  await h.ok(h.admin, 'visualizer.preset', { preset: 'Geiss - Cosmic Dust' });
  assert.equal(h.snap().revision, pinnedRev);

  // Explicit "next" bumps presetNonce even when preset stays null (auto-cycle).
  await h.ok(h.admin, 'visualizer.preset', { preset: null, next: true });
  const cycled = h.snap();
  assert.deepEqual(cycled.visualizer, { mode: 'milkdrop', preset: null, presetNonce: 1 });
  assert.equal(cycled.playback.desiredEpoch, initialEpoch);

  // Persists across service restart.
  h.restart();
  assert.deepEqual(h.snap({ kind: 'public' }).visualizer, {
    mode: 'milkdrop',
    preset: null,
    presetNonce: 1,
  });

  // Switch back to Soundbar.
  await h.ok(h.admin, 'visualizer.mode', { mode: 'soundbar' });
  assert.equal(h.snap().visualizer.mode, 'soundbar');
  assert.equal(h.snap().playback.desiredEpoch, initialEpoch);
});

test('HTTP authorization and validation enforce admin role and valid visualizer payloads', async () => {
  const app = await startApp();
  try {
    const admin = await organizer(app);
    const attendee = await app.client().login('alice');
    const anon = app.client();

    assert.equal((await anon.raw('visualizer.mode', { mode: 'milkdrop' })).status, 401);
    assert.equal((await anon.raw('visualizer.preset', { preset: null, next: true })).status, 401);

    const forbiddenMode = await attendee.raw('visualizer.mode', { mode: 'milkdrop' });
    assert.equal(forbiddenMode.status, 403);
    assert.equal(forbiddenMode.body.ok ? 'ok' : forbiddenMode.body.error.code, 'FORBIDDEN');

    const forbiddenPreset = await attendee.raw('visualizer.preset', { preset: 'Some Preset' });
    assert.equal(forbiddenPreset.status, 403);
    assert.equal(forbiddenPreset.body.ok ? 'ok' : forbiddenPreset.body.error.code, 'FORBIDDEN');

    const badMode = await admin.raw('visualizer.mode', { mode: 'invalid' as never });
    assert.equal(badMode.status, 400);
    assert.equal(badMode.body.ok ? 'ok' : badMode.body.error.code, 'BAD_REQUEST');

    const tooLongPreset = await admin.raw('visualizer.preset', { preset: 'x'.repeat(301) });
    assert.equal(tooLongPreset.status, 400);
    assert.equal(tooLongPreset.body.ok ? 'ok' : tooLongPreset.body.error.code, 'BAD_REQUEST');

    const emptyPreset = await admin.raw('visualizer.preset', { preset: '' });
    assert.equal(emptyPreset.status, 400);
    assert.equal(emptyPreset.body.ok ? 'ok' : emptyPreset.body.error.code, 'BAD_REQUEST');

    const okMode = await admin.raw('visualizer.mode', { mode: 'milkdrop' });
    assert.equal(okMode.status, 200);
    assert.equal((await anon.snapshot()).visualizer.mode, 'milkdrop');
  } finally {
    await app.stop();
  }
});

test('DisplayView switches between Soundbar and MilkDrop cleanly in SSR output', () => {
  const now = 1_000_000;
  const soundbarSnap = displayFixture('master', now);
  const soundbarHtml = renderToStaticMarkup(createElement(DisplayView, { snapshot: soundbarSnap, error: null, now }));
  assert.match(soundbarHtml, /data-visualizer="soundbar"/);
  assert.match(soundbarHtml, /class="soundbar"/);
  assert.doesNotMatch(soundbarHtml, /class="milkdrop"/);

  const milkdropSnap = {
    ...soundbarSnap,
    visualizer: { mode: 'milkdrop' as const, preset: null, presetNonce: 0 },
  };
  const milkdropHtml = renderToStaticMarkup(createElement(DisplayView, { snapshot: milkdropSnap, error: null, now }));
  assert.match(milkdropHtml, /data-visualizer="milkdrop"/);
  assert.match(milkdropHtml, /class="milkdrop"/);
  assert.match(milkdropHtml, /MilkDrop audio-reactive visualizer/);
  assert.doesNotMatch(milkdropHtml, /class="soundbar"/);
});

test('VisualizerControls renders Soundbar default, MilkDrop preset picker, and optimistic pending intent', () => {
  const baseSnap = displayFixture('master', 1_000_000);
  const soundbarHtml = renderView(views.VisualizerControls, {
    snapshot: baseSnap,
    intents: [],
    presetNames: ['Preset A', 'Preset B'],
  });
  assert.match(soundbarHtml, /data-adm-visualizer="soundbar"[^>]*aria-checked="true"|aria-checked="true"[^>]*data-adm-visualizer="soundbar"/);
  assert.match(soundbarHtml, /data-adm-visualizer="milkdrop"[^>]*aria-checked="false"|aria-checked="false"[^>]*data-adm-visualizer="milkdrop"/);
  assert.doesNotMatch(soundbarHtml, /adm-milkdrop-preset/);
  assert.doesNotMatch(soundbarHtml, /data-adm-visualizer-next/);

  const pendingIntent: Intent = {
    id: 'intent-1',
    label: 'Visualizer: MilkDrop',
    type: 'visualizer.mode',
    payload: { mode: 'milkdrop' },
    status: 'pending',
    error: null,
    replayed: false,
    startedAt: 1,
    finishedAt: null,
    attempts: 1,
  };
  const optimisticHtml = renderView(views.VisualizerControls, {
    snapshot: baseSnap,
    intents: [pendingIntent],
    presetNames: ['Preset A', 'Preset B'],
  });
  assert.match(optimisticHtml, /data-adm-visualizer="milkdrop"[^>]*aria-checked="true"|aria-checked="true"[^>]*data-adm-visualizer="milkdrop"/);
  assert.match(optimisticHtml, /id="adm-milkdrop-preset"/);
  assert.match(optimisticHtml, /Auto-cycle presets/);
  assert.match(optimisticHtml, /Preset A/);
  assert.match(optimisticHtml, /data-adm-visualizer-next="true"/);

  const milkdropSnap = {
    ...baseSnap,
    visualizer: { mode: 'milkdrop' as const, preset: 'Preset B', presetNonce: 2 },
  };
  const milkdropHtml = renderView(views.VisualizerControls, {
    snapshot: milkdropSnap,
    intents: [],
    presetNames: ['Preset A', 'Preset B'],
  });
  assert.match(milkdropHtml, /<option value="Preset B" selected=""/);
});
