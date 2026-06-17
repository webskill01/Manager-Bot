import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createReportHandlers } from '../core/handlers/reportHandlers.js';
import { formatDate, formatDateTime } from '../core/globalConfig.js';

const log = { info() {}, warn() {}, error() {} };

function makeStore(members) {
  return {
    getAll() { return members.map(m => ({ ...m })); },
    getActive() { return members.filter(m => m.status === 'ACTIVE').map(m => ({ ...m })); },
  };
}
function makeConfig() {
  return { joining: { fee: 90 }, renewal: { fullAmount: 90, referralAmount: 45 } };
}

// A date string in the current month (so inMonth() matches "now").
function thisMonth(day) {
  const d = new Date();
  d.setDate(day);
  return formatDate(d);
}
const renewedNow = formatDateTime(new Date());

test('collection counts members who renewed this month (billing moved forward)', () => {
  // Member A renewed this month → billing already pushed to next month (not in this month anymore).
  // Member B still due this month, unpaid. Correct collection rate = 1/2 = 50%.
  const next = new Date();
  next.setMonth(next.getMonth() + 1);
  const members = [
    { name: 'A', phone: '9000000001', status: 'ACTIVE', billingDate: formatDate(next),
      paidLast: 90, renewals: 2, lastRenewed: renewedNow },
    { name: 'B', phone: '9000000002', status: 'ACTIVE', billingDate: thisMonth(20),
      paidLast: 90, renewals: 1, lastRenewed: '' },
  ];
  const report = createReportHandlers(makeStore(members), makeConfig(), Date.now(), log);
  const out = report.handleCollection();

  assert.match(out, /Due this month:\s*2/, 'both members count toward this month');
  assert.match(out, /Renewed:\s*1\s*\(50%\)/, 'renewed member is counted → 50%');
  assert.match(out, /Collected: ₹90/, 'their ₹90 payment is collected, not lost');
});
