import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildDmList, freshRows } from '../core/dmList.js';
import { removalDue, isBacklog } from '../core/appFlow.js';
import { buildDripQueue } from '../core/dripEngine.js';
import { formatDate } from '../core/globalConfig.js';

const day = (n) => { const d = new Date(); d.setDate(d.getDate() + n); return formatDate(d); };
const cfg = {
  renewal: { fullAmount: 149, referrals: false },
  overdue: { autoReminderDays: 5, finalReminderDays: 6, consolidatedListDays: 7 },
  messages: { reminder: 'due {name} {fee}', overdue: 'late {name}', finalReminder: 'final {name}' },
  freshStart: { from: day(0), perDay: 2 },
};
const m = (phone, billingDate) => ({ name: 'N' + phone, phone, billingDate, status: 'ACTIVE' });

test('backlog = group-track members at/past removal day on freshStart.from', () => {
  assert.equal(isBacklog(m('1', day(-7)), cfg), true);
  assert.equal(isBacklog(m('1', day(-6)), cfg), false);
  assert.equal(isBacklog({ ...m('1', day(-9)), appPaidUntil: day(-9) }, cfg), false, 'app track is not backlog');
});

test('unstarted backlog: only the capped fresh cohort, least overdue first, never removal', () => {
  const members = [m('1000000030', day(-30)), m('1000000008', day(-8)), m('1000000012', day(-12)), m('1000000006', day(-6))];
  const rows = freshRows({ members, config: cfg });
  assert.deepEqual(rows.map(r => r.phone), ['1000000008', '1000000012']);
  assert.ok(rows.every(r => r.fresh && r.stage === 'msg1' && r.fee === 149));
  for (const cohort of ['due', 'nudge', 'final', 'missed']) {
    assert.ok(!buildDmList({ members, config: cfg, cohort }).rows.some(r => r.phone !== '1000000006'), cohort);
  }
  assert.equal(removalDue(members[0], cfg), false);
  // cap counts today's restarts from the contact log
  const log = { '1000000008': { cycle: day(-8), start: day(0) } };
  assert.deepEqual(freshRows({ members, config: cfg, contactLog: log }).map(r => r.phone), ['1000000012']);
});

test('restarted backlog runs the ladder from its start day', () => {
  const mem = m('1000000020', day(-20));
  const started = (n) => ({ '1000000020': { cycle: day(-20), start: day(-n), at: day(-n) } });
  const stage = (n, cohort) => buildDmList({ members: [mem], config: cfg, cohort, contactLog: started(n) }).rows.map(r => r.stage);
  assert.deepEqual(stage(5, 'nudge'), ['msg2']);
  assert.deepEqual(stage(6, 'final'), ['msg3']);
  assert.deepEqual(stage(3, 'missed'), [], 'already contacted this cycle');
  assert.equal(removalDue(mem, cfg, undefined, started(6)), false);
  assert.equal(removalDue(mem, cfg, undefined, started(7)), true);
});

test('fresh sits in the drip queue after the ladder', () => {
  const q = buildDripQueue({ members: [m('1000000009', day(-9)), m('1000000000', day(0))], config: cfg });
  assert.deepEqual(q.map(r => [r.phone, !!r.fresh]), [['1000000000', false], ['1000000009', true]]);
});
