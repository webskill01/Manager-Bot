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

// ── batch building ─────────────────────────────────────────────────────────────
import { buildDripBatch } from '../core/dripEngine.js';

const cfg = {
  joining: { fee: 90 },
  overdue: { autoReminderDays: 5, finalReminderDays: 6, consolidatedListDays: 7 },
  messages: { reminder: 'due {name} {date}', overdue: 'late {name}', finalReminder: 'final {name}' },
};

// Billing dates are computed off the REAL today: buildDmList calls daysFromToday(), which
// has no injectable clock, so a hardcoded date would make these tests pass only on one day.
// Format is DD-MM-YYYY — parseDate reads [day, month, year], NOT ISO. Getting this backwards
// silently yields ~39,000-day overdue values that land everyone in the final cohort.
function member(name, phone, overdueDays) {
  const d = new Date();
  d.setDate(d.getDate() - overdueDays);
  const billing = `${String(d.getDate()).padStart(2, '0')}-${String(d.getMonth() + 1).padStart(2, '0')}-${d.getFullYear()}`;
  return { name, phone, billingDate: billing, status: 'ACTIVE', renewals: 0 };
}

test('a batch takes at most one member from each of the three cohorts', () => {
  const members = [
    member('DueA', '9000000001', 0), member('DueB', '9000000002', 0),
    member('NudgeA', '9000000003', 5), member('NudgeB', '9000000004', 5),
    member('FinalA', '9000000005', 6),
  ];
  const batch = buildDripBatch({ members, config: cfg, pushed: [] });
  assert.equal(batch.length, 3);
  assert.deepEqual(batch.map(r => r.stage).sort(), ['msg1', 'msg2', 'msg3']);
});

test('already-pushed phones never come back', () => {
  const members = [member('DueA', '9000000001', 0), member('DueB', '9000000002', 0)];
  const batch = buildDripBatch({ members, config: cfg, pushed: ['9000000001'] });
  assert.equal(batch.length, 1);
  assert.equal(batch[0].phone, '9000000002');
});

test('an empty batch means the day is done', () => {
  const members = [member('DueA', '9000000001', 0)];
  assert.deepEqual(buildDripBatch({ members, config: cfg, pushed: ['9000000001'] }), []);
});

test('every row carries a wa.me link with the message pre-typed', () => {
  const [row] = buildDripBatch({ members: [member('DueA', '9000000001', 0)], config: cfg, pushed: [] });
  assert.ok(row.link.startsWith('https://wa.me/919000000001?text='));
  assert.ok(decodeURIComponent(row.link.split('?text=')[1]).includes('DueA'));
});

test('one member cannot appear twice in a batch via two cohorts', () => {
  // A 6-day-overdue member matches BOTH the nudge window edge and the final cohort on a
  // bot whose ladder is tight enough. Sending them two links in one push reads as a bug.
  const tight = { ...cfg, overdue: { autoReminderDays: 6, finalReminderDays: 6, consolidatedListDays: 7 } };
  const batch = buildDripBatch({ members: [member('X', '9000000009', 6)], config: tight, pushed: [] });
  assert.equal(batch.length, 1);
});
