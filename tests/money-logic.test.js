// Every rupee the bot prints must be cash it can point at: what a member actually paid, or
// what the config actually prices them at. These are the places that were derived from
// something else instead — a joining fee standing in for a renewal price, a hardcoded ₹45, a
// count multiplied by a list price, and a joining fee silently dropped for the month.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import { buildDmList } from '../core/dmList.js';
import { createReportHandlers } from '../core/handlers/reportHandlers.js';
import { createRenewalHandlers } from '../core/handlers/renewalHandlers.js';
import { formatSplit, computeSplit, formatDate, formatDateTime } from '../core/globalConfig.js';

const log = { info() {}, warn() {}, error() {} };
const today = formatDate(new Date());
const now = formatDateTime(new Date());
const daysAgo = (n) => formatDate(new Date(Date.now() - n * 86400000));

const store = (members) => ({
  async refresh() {},
  getAll() { return members.map(m => ({ ...m })); },
  getActive() { return members.filter(m => m.status === 'ACTIVE').map(m => ({ ...m })); },
});

const tieredConfig = {
  joining: { fee: 90 },
  renewal: { fullAmount: 90, referralAmount: 45 },
  overdue: { autoReminderDays: 5, finalReminderDays: 6, consolidatedListDays: 7 },
  messages: { reminder: 'due {name}', referralReminder: 'ref {name}', overdue: 'od', finalReminder: 'fin' },
};
// The shape that broke: a joining fee that is NOT the renewal price, and no referral tier.
const flatConfig = { ...tieredConfig, joining: { fee: 199 }, renewal: { fullAmount: 99, referralAmount: 99 } };

// ─── the DM list prices a RENEWAL, so it must use the renewal config ─────────────
test('dm list quotes the renewal price, not the joining fee', () => {
  const members = [
    { name: 'Due', phone: '9000000001', status: 'ACTIVE', billingDate: today, joinDate: '01-01-2026', paidLast: 99, renewals: 1 },
  ];
  const { rows } = buildDmList({ members, config: flatConfig });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].fee, 99, 'was ₹199 — the joining fee — beside a message asking for ₹99');
});

test('dm list quotes the referral price for a 1-ref member, never half the joining fee', () => {
  const members = [
    { name: 'Referrer', phone: '9000000001', status: 'ACTIVE', billingDate: today, joinDate: '01-01-2026', paidLast: 99, renewals: 1 },
    { name: 'Friend', phone: '9000000002', status: 'ACTIVE', billingDate: today, joinDate: daysAgo(5), paidLast: 199, renewals: 0, reference: '9000000001' },
  ];
  const flat = buildDmList({ members, config: flatConfig }).rows.find(r => r.phone === '9000000001');
  assert.equal(flat.fee, 99, 'no referral tier on this bot — was ₹100, half of the joining fee');

  const tiered = buildDmList({ members, config: tieredConfig }).rows.find(r => r.phone === '9000000001');
  assert.equal(tiered.fee, 45, 'a tiered bot still shows the referral price');
});

// ─── `renewed [phone] [referral price]` ─────────────────────────────────────────
function renewalHarness(config) {
  const member = {
    name: 'Payer', phone: '9000000001', status: 'ACTIVE', joinDate: '01-01-2026',
    billingDate: daysAgo(1), paidLast: config.renewal.fullAmount, renewals: 1, lastRenewed: '',
  };
  const writes = [];
  return {
    writes,
    handlers: createRenewalHandlers({
      findByPhone: () => ({ ...member }),
      async update(phone, patch) { writes.push(patch); },
    }, config, log),
  };
}

test('the referral price is read from config, not hardcoded to 45', async () => {
  // A bot priced 100/50: `renewed X 50` is neither the literal '45' nor a day of the month, so
  // it used to fall through both branches and record the FULL 100 with no error to notice.
  const config = { ...tieredConfig, renewal: { fullAmount: 100, referralAmount: 50 } };
  const { handlers, writes } = renewalHarness(config);
  await handlers.handleRenewed(['9000000001', '50']);
  assert.equal(writes[0].paidLast, 50);
});

test('a referral price that collides with a day of the month is still read as the day', async () => {
  const config = { ...tieredConfig, renewal: { fullAmount: 50, referralAmount: 25 } };
  const { handlers, writes } = renewalHarness(config);
  await handlers.handleRenewed(['9000000001', '25']);
  assert.equal(writes[0].paidLast, 50, 'the two-arg form is for the billing day; the price stays full');
  assert.equal(writes[0].billingDate.slice(0, 2), '25');
});

test('the 90/45 tiering still works', async () => {
  const { handlers, writes } = renewalHarness(tieredConfig);
  await handlers.handleRenewed(['9000000001', '45']);
  assert.equal(writes[0].paidLast, 45);
});

// ─── an advance is cash, and every line about it must say the same number ───────
test('an advance payment reports the cash taken, not count times list price', async () => {
  const members = [
    { name: 'Ahead', phone: '9000000001', status: 'ACTIVE', joinDate: '01-01-2026',
      billingDate: '01-12-2026', paidLast: 270, renewals: 4, lastRenewed: now, lastUpdated: now },
  ];
  const report = createReportHandlers(store(members), tieredConfig, Date.now(), log);
  const out = await report.handleSummary([]);
  assert.match(out, /1 full @ ₹90 = ₹270/, 'was "= ₹90" sitting under a "Revenue: ₹270" total');
  assert.match(out, /Revenue: ₹270/);

  const monthly = await report.handleMonthly([]);
  assert.match(monthly, /1 full @ ₹90 = ₹270/);
  assert.match(monthly, /Renewals ₹270/);

  const revenue = await report.handleRevenue();
  assert.match(revenue, /1 full @ ₹90 = ₹270/);
  assert.match(revenue, /Total: ₹270/);
});

// ─── a join and a later renewal in one month are two payments ───────────────────
test('joining early in the month and renewing later in it counts both payments', async () => {
  const members = [
    { name: 'Both', phone: '9000000001', status: 'ACTIVE',
      joinDate: daysAgo(2), billingDate: '20-12-2026', paidLast: 90, renewals: 1,
      lastRenewed: now, lastUpdated: now },
  ];
  const report = createReportHandlers(store(members), tieredConfig, Date.now(), log);
  const revenue = await report.handleRevenue();
  assert.match(revenue, /Total: ₹180/, 'the ₹90 joining fee was silently dropped');
  assert.match(revenue, /New joins: 1 \(₹90\)/);

  const weekly = await report.handleWeekly();
  assert.match(weekly, /Joins ₹90 \+ Renewals ₹90/);
});

test('an add and a renewal on the SAME day is still one event', async () => {
  const members = [
    { name: 'SameDay', phone: '9000000001', status: 'ACTIVE',
      joinDate: today, billingDate: '20-12-2026', paidLast: 90, renewals: 1,
      lastRenewed: now, lastUpdated: now },
  ];
  const report = createReportHandlers(store(members), tieredConfig, Date.now(), log);
  const revenue = await report.handleRevenue();
  assert.match(revenue, /Total: ₹90/, 'counted once, as the renewal');
  assert.doesNotMatch(revenue, /New joins/);
});

// ─── free 2-ref renewals are not part of any rupee figure ───────────────────────
test('ref-free renewals are counted apart from the paid ones', async () => {
  const members = [
    { name: 'Paid', phone: '9000000001', status: 'ACTIVE', joinDate: '01-01-2026',
      billingDate: '20-12-2026', paidLast: 90, renewals: 2, lastRenewed: now, lastUpdated: now },
    { name: 'Free', phone: '9000000002', status: 'ACTIVE', joinDate: '01-01-2026',
      billingDate: '20-12-2026', paidLast: 0, renewals: 2, lastRenewed: now, lastUpdated: now },
  ];
  const report = createReportHandlers(store(members), tieredConfig, Date.now(), log);
  const revenue = await report.handleRevenue();
  assert.match(revenue, /Renewals: 1 \(₹90\)/, 'was "2 (₹90)", which reads as an ₹90 arithmetic error');
  assert.match(revenue, /1 ref-free @ ₹0/);
});

// ─── outstanding is what each member will owe, not the list price times headcount ───
test('outstanding prices in the referral discounts already earned', () => {
  const d = new Date();
  const due = `15-${String(d.getMonth() + 1).padStart(2, '0')}-${d.getFullYear()}`;
  const refJoin = formatDate(new Date(d.getFullYear(), d.getMonth(), 5));
  const members = [
    { name: 'NoRefs', phone: '9000000001', status: 'ACTIVE', joinDate: '01-01-2026', billingDate: due, paidLast: 90, renewals: 1 },
    { name: 'OneRef', phone: '9000000002', status: 'ACTIVE', joinDate: '01-01-2026', billingDate: due, paidLast: 90, renewals: 1 },
    { name: 'Friend', phone: '9000000003', status: 'ACTIVE', joinDate: refJoin, billingDate: '20-12-2026', paidLast: 90, renewals: 0, reference: '9000000002' },
  ];
  const report = createReportHandlers(store(members), tieredConfig, Date.now(), log);
  const out = report.handleCollection();
  assert.match(out, /Outstanding \(est\.\): ₹135/, '90 + 45, not 2 x 90');
});

// ─── the split always hands out exactly the total ───────────────────────────────
test('the split sums back to the total at every shape', () => {
  const fifty = { split: { shares: [{ label: 'Sachin', percent: 50 }, { label: 'Nitin', percent: 25 }, { label: 'Tanishq', percent: 25 }] } };
  for (const total of [0, 1, 99, 135, 1035, 4755, 12347]) {
    assert.equal(computeSplit(total, fifty).reduce((s, p) => s + p.amount, 0), total, `50-25-25 of ${total}`);
    assert.equal(computeSplit(total, {}).reduce((s, p) => s + p.amount, 0), total, `50-50 of ${total}`);
  }
  assert.equal(formatSplit(1035, {}, ''), 'Per person: ₹518 / ₹517', 'was "₹518" printed twice = ₹1036');
  assert.equal(formatSplit(1000, {}, ''), 'Per person: ₹500');
  assert.equal(formatSplit(400, fifty, ''), 'Sachin: ₹200\nNitin: ₹100\nTanishq: ₹100');
});

// ─── the shipped configs ────────────────────────────────────────────────────────
test('bot-aayush2 splits 50-25-25 and bot-nitin drips 5:00-19:00', () => {
  const dir = path.join(import.meta.dirname, '..', 'bots');
  const aayush = JSON.parse(fs.readFileSync(path.join(dir, 'bot-aayush2', 'config.json'), 'utf8'));
  assert.deepEqual(aayush.split.shares.map(s => [s.label, s.percent]),
    [['Sachin', 50], ['Nitin', 25], ['Tanishq', 25]]);

  const nitin = JSON.parse(fs.readFileSync(path.join(dir, 'bot-nitin', 'config.json'), 'utf8'));
  assert.equal(nitin.drip.startHour, 5);
  assert.equal(nitin.drip.endHour, 19);
  // Arming after the window opens throws that hour away; arming before it makes the engine hold.
  assert.equal(nitin.schedule.dripArm, `0 ${nitin.drip.startHour} * * *`);
});
