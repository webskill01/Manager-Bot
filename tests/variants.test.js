import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pickVariant } from '../core/globalConfig.js';

test('a plain string passes through untouched', () => {
  assert.equal(pickVariant('hello', '9876543210', '2026-08-18'), 'hello');
});

test('undefined stays undefined so the || fallback chain still works', () => {
  assert.equal(pickVariant(undefined, '9876543210', '2026-08-18'), undefined);
});

test('the same phone and date always pick the same variant', () => {
  const v = ['a', 'b', 'c'];
  const first = pickVariant(v, '9876543210', '2026-08-18');
  for (let i = 0; i < 20; i++) {
    assert.equal(pickVariant(v, '9876543210', '2026-08-18'), first);
  }
});

test('different members get a spread of variants, not all the same', () => {
  const v = ['a', 'b', 'c'];
  const seen = new Set();
  for (let i = 0; i < 60; i++) {
    seen.add(pickVariant(v, `98765432${String(i).padStart(2, '0')}`, '2026-08-18'));
  }
  assert.equal(seen.size, 3);
});

test('the same member drifts across dates', () => {
  const v = ['a', 'b', 'c'];
  const seen = new Set();
  for (let d = 1; d <= 28; d++) {
    seen.add(pickVariant(v, '9876543210', `2026-08-${String(d).padStart(2, '0')}`));
  }
  assert.ok(seen.size > 1, 'a member pinned to one variant forever defeats the point');
});

test('a single-entry array behaves like a string', () => {
  assert.equal(pickVariant(['only'], '9876543210', '2026-08-18'), 'only');
});

test('an empty array yields empty string, never undefined-as-text', () => {
  assert.equal(pickVariant([], '9876543210', '2026-08-18'), '');
});

test('the spread is roughly even, not 90% one variant', () => {
  const v = ['a', 'b', 'c'];
  const counts = { a: 0, b: 0, c: 0 };
  for (let i = 0; i < 900; i++) {
    counts[pickVariant(v, `9${String(i).padStart(9, '0')}`, '2026-08-18')]++;
  }
  for (const k of Object.keys(counts)) {
    assert.ok(counts[k] > 200, `variant ${k} only got ${counts[k]}/900 — hash is skewed`);
  }
});
