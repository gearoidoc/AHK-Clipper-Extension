import assert from 'node:assert/strict';
import { test } from 'node:test';
import { placeDialog } from '../src/position.ts';

const viewport = { width: 1200, height: 800 };
const dialog = { width: 360, height: 300 };
const rect = (top: number, left: number, bottom = top + 20, right = left + 100) => ({ top, left, bottom, right });

test('goes just below the selection, aligned with its left edge', () => {
  assert.deepEqual(placeDialog(rect(100, 200), viewport, dialog), { top: 128, left: 200 });
});

test('goes above the selection when there is no room below', () => {
  assert.deepEqual(placeDialog(rect(600, 200), viewport, dialog), { top: 292, left: 200 });
});

test('stays inside the viewport when there is room neither below nor above', () => {
  const tall = { width: 360, height: 700 };
  assert.deepEqual(placeDialog(rect(300, 200), viewport, tall), { top: 88, left: 200 });
});

test('moves left to keep the right edge on screen', () => {
  assert.deepEqual(placeDialog(rect(100, 1100), viewport, dialog).left, 1200 - 360 - 12);
});

test('keeps a margin from the left edge', () => {
  assert.deepEqual(placeDialog(rect(100, -50), viewport, dialog).left, 12);
});

test('without a selection it sits near the top centre', () => {
  assert.deepEqual(placeDialog(null, viewport, dialog), { top: 120, left: 420 });
});

test('a viewport narrower than the dialog pins it to the margin', () => {
  assert.deepEqual(placeDialog(rect(100, 100), { width: 300, height: 800 }, dialog).left, 12);
});
