import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dripSettings, flexGapMs, flexFirstDelayMs, planTimes } from '../core/dripEngine.js';

const s = dripSettings({ drip: { mode: 'auto', flex: true } });
const at = (h, m = 0) => { const d = new Date(2026, 8, 26); d.setHours(h, m, 0, 0); return d; };
const MIN = 60000;
const plan = (n, from) => planTimes(Array.from({ length: n }, (_, i) => ({ i })), s, { from });

test('flex defaults: 4-23 window, 3/h, one per send', () => {
  assert.equal(s.startHour, 4);
  assert.equal(s.softStartHour, 5);
  assert.equal(s.endHour, 23);
  assert.equal(s.gapMinMs, 20 * MIN);
  assert.equal(s.batchSize, 1);
});

test('light day starts at 5 and runs at 3 an hour, finishing early', () => {
  assert.equal(flexFirstDelayMs(10, at(4, 5), s, () => 0), 55 * MIN);
  assert.equal(flexGapMs(10, at(5), s, () => 0), 20 * MIN);
  const rows = plan(10, at(5));
  assert.ok(rows.at(-1).at < at(9), 'ten members done well before noon');
});

test('busy day opens at 4 and squeezes the gap to fit everyone before 23:00', () => {
  // 80 members at 20 min = 26.7h — cannot fit from 5 at the normal rate
  assert.ok(flexFirstDelayMs(80, at(4), s, () => 0) < 1 * MIN);
  const rows = plan(80, at(4));
  assert.ok(rows.every(r => !r.late), 'nobody rolls over');
  const gaps = rows.slice(1).map((r, i) => r.at - rows[i].at);
  assert.ok(Math.min(...gaps) >= s.gapFloorMs);
  assert.ok(Math.max(...gaps) < 20 * MIN, 'faster than 3/h because it has to be');
});

test('squeezed gap never drops under the floor, even when hopeless', () => {
  assert.equal(flexGapMs(1000, at(20), s, () => 0), s.gapFloorMs);
});

test('a mid-day payment loosens the rest back to the normal rate', () => {
  assert.equal(flexGapMs(5, at(12), s, () => 0), 20 * MIN);
});
