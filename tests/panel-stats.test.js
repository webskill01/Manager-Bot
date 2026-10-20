import { test } from 'node:test';
import assert from 'node:assert/strict';
import { attribute, team, ageing, funnel, recoveredByDay, summary } from '../panel/lib/stats.js';

const T = Date.parse('2026-10-19T12:00:00Z');
const at = (days) => new Date(T + days * 86400e3).toISOString();
const pay = (phone, days, amount = 100, billingFrom = '15-10-2026') => ({ phone, at: at(days), amount, bot: 'bot-abhi', billingFrom });
const call = (phone, user_id, days, outcome = 'promise') => ({ phone, user_id, at: at(days), outcome });

test('a payment belongs to the latest caller within 7 days, else organic', () => {
  const out = attribute(
    [pay('1', 0), pay('2', 0), pay('3', 0)],
    [call('1', 7, -6), call('1', 8, -2), call('2', 7, -8), call('3', 7, 1)],
  );
  assert.deepEqual(out.map(p => p.userId), [8, null, null]);
});

test('team stats: calls, connects, promises kept, recovered rupees', () => {
  const interactions = [
    call('1', 7, -3), call('2', 7, -3, 'no_answer'), call('3', 7, -2, 'wrong_number'), call('4', 7, -1),
  ];
  const followups = [
    { phone: '1', user_id: 7, kind: 'promise', created_at: at(-3), due_at: at(-1) },
    { phone: '4', user_id: 7, kind: 'promise', created_at: at(-1), due_at: at(1) },
  ];
  const payments = attribute([pay('1', -1, 90)], interactions);
  const [r] = team({ users: [{ id: 7, name: 'Ravi' }], interactions, followups, payments });
  assert.deepEqual(r, { userId: 7, name: 'Ravi', calls: 4, connected: 2, promises: 2, promisesKept: 1, recovered: 90, paidCount: 1 });
});

test('ageing buckets by days overdue', () => {
  assert.deepEqual(ageing([{ days: -1 }, { days: -2 }, { days: -4 }, { days: -7 }, { days: 0 }]),
    { '1-2': 2, '3-5': 1, '6+': 1 });
});

test('funnel counts paid people back into "due" by their old billing date', () => {
  const rows = [{ phone: '1' }, { phone: '2' }];
  const f = funnel({
    rows,
    interactions: [call('1', 7, -1), call('9', 7, -1, 'promise')],
    payments: [pay('9', 0, 100, '16-10-2026'), pay('8', 0, 100, '01-10-2026')],
    from: '15-10-2026', to: '19-10-2026',
  });
  assert.deepEqual(f, { due: 3, contacted: 2, promised: 2, paid: 1 });
});

test('recovered by day sums rupees per IST day', () => {
  assert.deepEqual(recoveredByDay([pay('1', 0, 90), pay('2', 0, 100), pay('3', -1, 100)]),
    [{ date: '18-10-2026', amount: 100, count: 1 }, { date: '19-10-2026', amount: 190, count: 2 }]);
});

test('summary: per-day outcomes, distinct people, moves on their day and caller', () => {
  const day = (iso) => iso.slice(0, 10);
  const calls = [
    { phone: '1', user_id: 1, outcome: 'no_answer', at: '2026-10-19T05:00:00Z' },
    { phone: '1', user_id: 1, outcome: 'promise', at: '2026-10-20T05:00:00Z' },
    { phone: '2', user_id: 2, outcome: 'not_interested', at: '2026-10-20T06:00:00Z' },
  ];
  const s = summary({ calls, moves: [{ phone: '1', userId: 1, amount: 149, at: '2026-10-20T07:00:00Z' }], days: ['2026-10-19', '2026-10-20'], day });
  assert.deepEqual(s.days.map(d => [d.day, d.calls, d.people, d.connected, d.moved]), [['2026-10-20', 2, 2, 2, 1], ['2026-10-19', 1, 1, 0, 0]]);
  assert.equal(s.total.people, 2);
  assert.equal(s.total.not_interested, 1);
  assert.deepEqual(s.callers.find(c => c.userId === 1), { userId: 1, ...s.callers.find(c => c.userId === 1), calls: 2, moved: 1, amount: 149 });
});
