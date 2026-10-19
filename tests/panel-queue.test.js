import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildQueue, focusOrder } from '../panel/lib/queue.js';
import { buildPeople } from '../panel/lib/people.js';
import { formatDate } from '../core/globalConfig.js';

const NOW = new Date();
NOW.setHours(15, 0, 0, 0);   // 3 PM local: leaves room for "4h ago" fixtures inside today
const day = (n) => formatDate(new Date(NOW.getTime() + n * 86400e3));
const hoursAgo = (h) => new Date(NOW.getTime() - h * 3600e3).toISOString();
const botCfg = {
  'bot-abhi': { renewal: { fullAmount: 100 }, removalDay: 7 },
  'bot-aayush2': { renewal: { fullAmount: 100 }, removalDay: 5 },
};
const mem = (phone, billingDate, extra = {}) => ({ name: `M${phone.slice(-2)}`, phone, status: 'ACTIVE', billingDate, ...extra });

function q({ sheets, interactions = [], followups = [], assignments = [], claims = [], filter = { view: 'today' }, app = [] }) {
  const people = buildPeople({ sheets, app });
  return buildQueue({ people, botCfg, interactions, followups, assignments, claims, filter, now: NOW });
}
const phones = (rows) => rows.map(r => r.phone);

test('today view orders follow-ups, then most overdue, then due today', () => {
  const rows = q({
    sheets: { 'bot-abhi': [
      mem('9000000001', day(0)), mem('9000000002', day(-6)), mem('9000000003', day(-2)),
      mem('9000000004', day(-1)), mem('9000000005', day(2)), mem('9000000006', day(-9)),
    ] },
    followups: [{ phone: '9000000004', kind: 'callback', due_at: hoursAgo(1), user_id: 1 }],
  });
  assert.deepEqual(phones(rows), ['9000000004', '9000000002', '9000000003', '9000000001']);
  assert.equal(rows[0].reason, 'followup');
  assert.equal(rows[1].days, -6);
  assert.equal(rows[1].amount, 100);
});

test('removal day is per bot: aayush2 drops at 6 days overdue', () => {
  const rows = q({ sheets: { 'bot-aayush2': [mem('9000000001', day(-6)), mem('9000000002', day(-5))] } });
  assert.deepEqual(phones(rows), ['9000000002']);
});

test('range view lists exactly the chosen days, including future ones as upcoming', () => {
  const sheets = { 'bot-abhi': [mem('9000000001', day(-4)), mem('9000000002', day(-3)), mem('9000000003', day(1)), mem('9000000004', day(-20))] };
  assert.deepEqual(phones(q({ sheets, filter: { view: 'range', from: day(-4), to: day(-4) } })), ['9000000001']);
  const rows = q({ sheets, filter: { view: 'range', from: day(-30), to: day(1) } });
  assert.deepEqual(phones(rows), ['9000000004', '9000000001', '9000000002', '9000000003']);
  assert.equal(rows.at(-1).reason, 'upcoming');
  assert.deepEqual(phones(q({ sheets, filter: { view: 'range', from: day(-30), to: day(1), status: 'upcoming' } })), ['9000000003']);
});

test('promise in the future is blocked; once due it leads the list', () => {
  const sheets = { 'bot-abhi': [mem('9000000001', day(-3)), mem('9000000002', day(-1))] };
  const future = [{ phone: '9000000001', kind: 'promise', due_at: new Date(NOW.getTime() + 86400e3).toISOString(), user_id: 1 }];
  const rows = q({ sheets, followups: future });
  assert.equal(rows.find(r => r.phone === '9000000001').blocked, 'promised');
  assert.equal(rows.at(-1).phone, '9000000001', 'blocked rows sink to the bottom');
  const due = [{ ...future[0], due_at: hoursAgo(2) }];
  assert.equal(q({ sheets, followups: due })[0].phone, '9000000001');
});

test('no-answer retry: blocked under 4h, open after, blocked at the 3rd try', () => {
  const sheets = { 'bot-abhi': [mem('9000000001', day(-2))] };
  const na = (h) => ({ phone: '9000000001', user_id: 1, outcome: 'no_answer', at: hoursAgo(h) });
  assert.equal(q({ sheets, interactions: [na(1)] })[0].blocked, 'retry_later');
  assert.equal(q({ sheets, interactions: [na(5)] })[0].blocked, null);
  assert.equal(q({ sheets, interactions: [na(9), na(7), na(5)] })[0].blocked, 'max_tries');
});

test('any other outcome today blocks the person for the day', () => {
  const sheets = { 'bot-abhi': [mem('9000000001', day(-2))] };
  const rows = q({ sheets, interactions: [{ phone: '9000000001', user_id: 1, outcome: 'not_interested', at: hoursAgo(6) }] });
  assert.equal(rows[0].blocked, 'called_today');
  assert.equal(rows[0].last.outcome, 'not_interested');
});

test('paid on app, delayed and non-active members never show', () => {
  const rows = q({
    sheets: { 'bot-abhi': [
      mem('9000000001', day(-2)), mem('9000000002', day(-2), { status: 'REMOVED' }),
      mem('9000000003', day(-2), { delayUntil: day(2) }), mem('9000000004', day(-1)),
    ] },
    app: [{ phone: '9000000001', status: 'active', expiresAt: new Date(NOW.getTime() + 86400e3 * 20).toISOString() }],
  });
  assert.deepEqual(phones(rows), ['9000000004']);
});

test('focus serves my assigned first, then unassigned; skips others\' work and claims', () => {
  const rows = q({
    sheets: { 'bot-abhi': [mem('9000000001', day(-6)), mem('9000000002', day(-5)), mem('9000000003', day(-4)), mem('9000000004', day(-3))] },
    assignments: [{ phone: '9000000003', user_id: 7 }, { phone: '9000000002', user_id: 8 }],
    claims: [{ phone: '9000000001', user_id: 8 }],
  });
  assert.equal(rows.find(r => r.phone === '9000000001').claimedBy, 8);
  assert.deepEqual(phones(focusOrder(rows, 7)), ['9000000003', '9000000004']);
});

test('a member active on two bots is one row, on the more urgent bot', () => {
  const rows = q({ sheets: { 'bot-abhi': [mem('9000000001', day(-1))], 'bot-aayush2': [mem('9000000001', day(-4))] } });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].bot, 'bot-aayush2');
  assert.deepEqual(rows[0].alsoOn, ['bot-abhi']);
});
