import { test } from 'node:test';
import assert from 'node:assert/strict';
import { catchupRows, pausedOn, buildDripQueue } from '../core/dripEngine.js';
import { formatDate } from '../core/globalConfig.js';

// Dates off the real today (daysFromToday has no injectable clock). DD-MM-YYYY.
const day = (n) => { const d = new Date(); d.setDate(d.getDate() + n); return formatDate(d); };
const cfg = {
  joining: { fee: 90 },
  overdue: { autoReminderDays: 5, finalReminderDays: 6, consolidatedListDays: 7 },
  messages: { reminder: 'due {name}', overdue: 'late {name}', finalReminder: 'final {name}' },
};
const m = (phone, billingDate) => ({ name: 'N' + phone, phone, billingDate, status: 'ACTIVE' });

// Paused on day -2 and -1, resumed today.
const catchup = { from: day(-2), resumeOn: day(0), skip: { [day(-2)]: ['1000000005'] } };

test('pausedOn covers [from, resumeOn) only', () => {
  assert.equal(pausedOn(catchup, day(-2)), true);
  assert.equal(pausedOn(catchup, day(-1)), true);
  assert.equal(pausedOn(catchup, day(0)), false);
  assert.equal(pausedOn(null, day(0)), false);
});

test('catch-up replays every slot the pause swallowed, and nothing else', () => {
  const members = [
    m('1000000008', day(-8)),   // day-6 fell on day -2 → final, now 8d over
    m('1000000007', day(-7)),   // day-6 fell on day -1 → final
    m('1000000006', day(-6)),   // day-5 fell on day -1 (msg2); the queue gives them today's final instead
    m('1000000005', day(-7 + 0)), // placeholder replaced below
    m('1000000001', day(-1)),   // due on day -1 → msg1
    m('1000000003', day(-3)),   // due day -3, not paused → nothing
  ];
  members[3] = m('1000000005', day(-8)); // same slot as #1 but already sent before the pause
  const rows = catchupRows({ members, config: cfg, catchup, now: day(0) });
  const by = Object.fromEntries(rows.map(r => [r.phone, r.stage]));
  assert.deepEqual(by, { '1000000008': 'msg3', '1000000007': 'msg3', '1000000006': 'msg2', '1000000001': 'msg1' });
  assert.equal(rows.find(r => r.phone === '1000000008').overdueDays, 8, 'age is real, not virtual');
});

test('inert on any day other than resumeOn', () => {
  const members = [m('1000000008', day(-8))];
  assert.equal(catchupRows({ members, config: cfg, catchup, now: day(1) }).length, 0);
});

test('queue dedupes catch-up against real cohorts', () => {
  const members = [m('1000000006', day(-6)), m('1000000007', day(-7))];
  const q = buildDripQueue({ members, config: { ...cfg, dripCatchup: catchup } });
  assert.deepEqual(q.map(r => r.phone), ['1000000006', '1000000007']);
});
