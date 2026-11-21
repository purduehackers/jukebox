// Geometry and auto-scroll unit tests for admin queue drag-and-drop sorting.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { computeAutoScrollVelocity, computeDropMarker, findDropBeforeId } from '../src/admin/reorder.ts';

test('findDropBeforeId resolves midpoints with clamping, clientTop, and scrollTop', () => {
  const items = [
    { id: 'a', offsetTop: 0, offsetHeight: 40 },   // midpoint 20
    { id: 'b', offsetTop: 40, offsetHeight: 60 },  // midpoint 70
    { id: 'c', offsetTop: 100, offsetHeight: 40 }, // midpoint 120
  ];
  assert.equal(findDropBeforeId(50, 100, 0, 0, 200, []), null);

  // containerTop = 100, clientTop = 2 -> origin = 102; scrollTop = 0, clientHeight = 200
  assert.equal(findDropBeforeId(20, 100, 2, 0, 200, items), 'a', 'clamps above container to first item');
  assert.equal(findDropBeforeId(121, 100, 2, 0, 200, items), 'a', 'contentY=19 < midpoint 20');
  assert.equal(findDropBeforeId(122, 100, 2, 0, 200, items), 'b', 'contentY=20 equals midpoint 20 -> next slot');
  assert.equal(findDropBeforeId(171, 100, 2, 0, 200, items), 'b', 'contentY=69 < midpoint 70');
  assert.equal(findDropBeforeId(172, 100, 2, 0, 200, items), 'c', 'contentY=70 equals midpoint 70 -> next slot');
  assert.equal(findDropBeforeId(222, 100, 2, 0, 200, items), null, 'contentY=120 equals last midpoint -> end');
  assert.equal(findDropBeforeId(450, 100, 2, 0, 200, items), null, 'clamps below container to end');

  // With scrollTop = 50: pointerY = 122 gives contentY = 20 + 50 = 70 -> 'c'
  assert.equal(findDropBeforeId(122, 100, 2, 50, 100, items), 'c');
  // Pointer clamped to container bottom (origin + clientHeight = 102 + 80 = 182): contentY = 80 + 30 = 110 < 120 -> 'c'
  assert.equal(findDropBeforeId(300, 100, 2, 30, 80, items), 'c');
});

test('computeAutoScrollVelocity scales across edge zones, prevents overlap, and caps speed beyond edge', () => {
  // Viewport 100..400 (span 300), itemHeight 60 -> zone = min(60, 100) = 60.
  assert.equal(computeAutoScrollVelocity(250, 100, 400, 60), 0, 'middle stays still');
  assert.equal(computeAutoScrollVelocity(160, 100, 400, 60), 0, 'top edge boundary is 0');
  assert.equal(computeAutoScrollVelocity(340, 100, 400, 60), 0, 'bottom edge boundary is 0');

  const topMid = computeAutoScrollVelocity(130, 100, 400, 60);
  const topEdge = computeAutoScrollVelocity(100, 100, 400, 60);
  const topFar = computeAutoScrollVelocity(-200, 100, 400, 60);
  assert.ok(topMid < 0 && topEdge < topMid, 'scrolling up speeds up toward top edge');
  assert.equal(topFar, -900, 'speed continues increasing past edge up to cap');

  const botMid = computeAutoScrollVelocity(370, 100, 400, 60);
  const botEdge = computeAutoScrollVelocity(400, 100, 400, 60);
  const botFar = computeAutoScrollVelocity(800, 100, 400, 60);
  assert.ok(botMid > 0 && botEdge > botMid, 'scrolling down speeds up toward bottom edge');
  assert.equal(botFar, 900, 'downward speed caps cleanly');

  // Short container (span 90) with tall item (itemHeight 80) caps zone at span / 3 = 30 -> middle [130, 160] stays 0.
  assert.equal(computeAutoScrollVelocity(145, 100, 190, 80), 0, 'zones never overlap');
  assert.equal(computeAutoScrollVelocity(100, 100, 100, 50), 0, 'empty span returns 0');
});

test('computeDropMarker centers line on top, gap, and bottom positions', () => {
  const listRect = { left: 24, width: 400 };
  assert.equal(computeDropMarker(listRect, null, null), null);
  assert.deepEqual(computeDropMarker(listRect, null, { top: 100 }, 2), { x: 24, y: 99, w: 400, h: 2 });
  assert.deepEqual(computeDropMarker(listRect, { bottom: 140 }, { top: 144 }, 2), { x: 24, y: 141, w: 400, h: 2 });
  assert.deepEqual(computeDropMarker(listRect, { bottom: 200 }, null, 2), { x: 24, y: 199, w: 400, h: 2 });
});
