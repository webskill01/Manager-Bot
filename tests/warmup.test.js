import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { markLinkedAt, getLinkedAt, inWarmup } from '../core/warmup.js';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'warmup-'));

test('no marker (established link) → never warming up', () => {
  const dir = tmp();
  assert.equal(getLinkedAt(dir), null);
  assert.equal(inWarmup(dir, 24), false);
});

test('fresh link: marker starts the clock, expires after the window', () => {
  const dir = tmp();
  const t0 = Date.now();
  markLinkedAt(dir, t0);
  assert.equal(getLinkedAt(dir), t0);
  assert.equal(inWarmup(dir, 24, t0 + 1000), true, 'inside window');
  assert.equal(inWarmup(dir, 24, t0 + 23 * 3600e3), true, 'still inside at 23h');
  assert.equal(inWarmup(dir, 24, t0 + 25 * 3600e3), false, 'expired at 25h');
});

test('markLinkedAt is idempotent — re-marking never restarts the clock', () => {
  const dir = tmp();
  const t0 = Date.now();
  markLinkedAt(dir, t0);
  markLinkedAt(dir, t0 + 9999999); // e.g. repeated creds.update events
  assert.equal(getLinkedAt(dir), t0);
});

test('wiping the auth dir resets the clock (re-link = fresh warm-up)', () => {
  const dir = tmp();
  markLinkedAt(dir, 123);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir);
  assert.equal(getLinkedAt(dir), null);
  markLinkedAt(dir, 456);
  assert.equal(getLinkedAt(dir), 456);
});
