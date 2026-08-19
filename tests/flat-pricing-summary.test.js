// Bots where a referral renewal costs the same as a full one (abhi: 100/100, aayush2: 99/99)
// used to match BOTH renewal filters — every renewal was listed twice and its revenue doubled.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createReportHandlers } from '../core/handlers/reportHandlers.js';
import { formatDate, formatDateTime } from '../core/globalConfig.js';

const log = { info() {}, warn() {}, error() {} };
const today = formatDate(new Date());
const renewedAt = formatDateTime(new Date());

const store = (members) => ({
  async refresh() {},
  getAll() { return members.map(m => ({ ...m })); },
  getActive() { return members.filter(m => m.status === 'ACTIVE').map(m => ({ ...m })); },
});

// abhi's pricing: full === referral === 100
const flatConfig = {
  joining: { fee: 100 },
  renewal: { fullAmount: 100, referralAmount: 100 },
  overdue: { autoReminderDays: 5, consolidatedListDays: 7 },
  splitPercent: { Abhinav: 50, Nitin: 25, Tanishq: 25 },
};

const renewers = ['Vinod Kumar', 'sukhmeet singh', 'kulwinder kumar', 'vikram'].map((name, i) => ({
  name, phone: `900000000${i}`, status: 'ACTIVE', joinDate: '01-01-2026',
  billingDate: '17-09-2026', paidLast: 100, renewals: 2,
  lastRenewed: renewedAt, lastUpdated: renewedAt,
}));

test('flat pricing: each renewal is listed once and billed once', async () => {
  const report = createReportHandlers(store(renewers), flatConfig, Date.now(), log);
  const out = await report.handleSummary([]);

  assert.match(out, /♻️ Renewals: 4\n/, 'four renewals, not 2 (half-weighted) or 8');
  assert.match(out, /4 full @ ₹100 = ₹400/);
  assert.doesNotMatch(out, /referral @/, 'no referral tier exists when both prices are equal');
  assert.equal((out.match(/vikram/g) || []).length, 1, 'a renewer appears in exactly one bucket');
  assert.match(out, /Renewals ₹400\)/, 'revenue is ₹400, not the doubled ₹800');
});

test('flat pricing: monthly and revenue reports agree', async () => {
  const report = createReportHandlers(store(renewers), flatConfig, Date.now(), log);
  const monthly = await report.handleMonthly([]);
  assert.match(monthly, /4 full @ ₹100 = ₹400/);
  assert.doesNotMatch(monthly, /referral @/);
  assert.match(monthly, /Renewals ₹400/);

  const revenue = await report.handleRevenue([]);
  assert.match(revenue, /♻️ Renewals: 4 \(₹400\)/);
});

test('split pricing still separates the two tiers', async () => {
  const splitConfig = { ...flatConfig, renewal: { fullAmount: 90, referralAmount: 45 } };
  const mixed = [
    { ...renewers[0], paidLast: 90 },
    { ...renewers[1], paidLast: 45 },
  ];
  const report = createReportHandlers(store(mixed), splitConfig, Date.now(), log);
  const out = await report.handleSummary([]);

  assert.match(out, /♻️ Renewals: 1.5\n/, 'referral renewal still counts as half');
  assert.match(out, /1 full @ ₹90 = ₹90/);
  assert.match(out, /1 referral @ ₹45 = ₹45/);
  assert.match(out, /Renewals ₹135\)/);
});
