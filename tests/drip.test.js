import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveDripIds } from '../core/globalConfig.js';

test('dripIds falls back to every allowed id when unset', () => {
  assert.deepEqual(resolveDripIds({ allowedTelegramIds: ['1', '2'] }), ['1', '2']);
});

test('dripIds narrows to the configured owner', () => {
  assert.deepEqual(
    resolveDripIds({ allowedTelegramIds: ['1', '2', '3'], dripIds: ['3'] }),
    ['3'],
  );
});

test('dripIds coerces numbers to strings', () => {
  assert.deepEqual(resolveDripIds({ allowedTelegramIds: [], dripIds: [42] }), ['42']);
});

test('an empty dripIds is treated as unset, not as "nobody"', () => {
  assert.deepEqual(resolveDripIds({ allowedTelegramIds: ['1'], dripIds: [] }), ['1']);
});

test('no telegram config at all yields an empty list, never undefined', () => {
  assert.deepEqual(resolveDripIds({}), []);
});
