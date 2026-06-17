import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createReportHandlers } from '../core/handlers/reportHandlers.js';
import { formatDate, formatDateTime } from '../core/globalConfig.js';

const log = { info() {}, warn() {}, error() {} };

function makeStore(members) {
  return {
    async refresh() {},
    getAll() { return members.map(m => ({ ...m })); },
    getActive() { return members.filter(m => m.status === 'ACTIVE').map(m => ({ ...m })); },
  };
}

function makeConfig() {
  return {
    joining: { fee: 90 },
    renewal: { fullAmount: 90, referralAmount: 45 },
    overdue: { autoReminderDays: 5, consolidatedListDays: 7 },
  };
}

const today = formatDate(new Date());
const renewedAt = formatDateTime(new Date());

test('a member added AND renewed today counts as a renewal, not a new join', async () => {
  // Subhash-style row: joined today (re-added via `add`), then explicitly renewed today.
  const members = [
    { name: 'Subhash', phone: '9876726670', status: 'ACTIVE', joinDate: today,
      billingDate: '17-07-2099', paidLast: 90, renewals: 1, lastRenewed: renewedAt, lastUpdated: renewedAt },
    // A genuine brand-new join today (never renewed) must still appear under New Members.
    { name: 'Pintu', phone: '9034710530', status: 'ACTIVE', joinDate: today,
      billingDate: '17-07-2099', paidLast: 90, renewals: 0, lastRenewed: '', lastUpdated: today },
  ];
  const report = createReportHandlers(makeStore(members), makeConfig(), Date.now(), log);
  const out = await report.handleSummary([]);

  // New Members section: Pintu yes, Subhash no.
  const newSection = out.split('♻️')[0];
  assert.match(newSection, /New Members: 1/, 'only the genuine new join is counted');
  assert.match(newSection, /Pintu/);
  assert.doesNotMatch(newSection, /Subhash/, 'renewed member must not appear under New Members');

  // Renewals section: Subhash counted as a full renewal.
  assert.match(out, /Renewals: 1/);
  assert.match(out, /Subhash/);
});
