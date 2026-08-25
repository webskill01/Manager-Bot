import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'os';
import { createRenewalHandlers } from '../core/handlers/renewalHandlers.js';
import { createReportHandlers, dailyBreakdown } from '../core/handlers/reportHandlers.js';
import { formatDate, formatDateTime, todayStr } from '../core/globalConfig.js';

const quietLog = { info() {}, warn() {}, error() {} };

function makeConfig(extra = {}) {
  return {
    joining: { fee: 90 },
    renewal: { fullAmount: 90, referralAmount: 45 },
    overdue: { autoReminderDays: 5, finalReminderDays: 6, consolidatedListDays: 7 },
    messages: { reminder: 'due {name} {date}', overdue: 'late {name}', finalReminder: 'final {name}' },
    ...extra,
  };
}

// Captures what was written rather than mocking Sheets: every assertion below is about the
// row the bot would send, which is the thing that was wrong.
function makeStore(members) {
  const writes = [];
  return {
    writes,
    async refresh() {},
    getAll() { return members.map(m => ({ ...m })); },
    getActive() { return members.filter(m => m.status === 'ACTIVE').map(m => ({ ...m })); },
    findByPhone(p) { return members.find(m => m.phone === p) || null; },
    async update(phone, patch) {
      writes.push({ phone, patch });
      Object.assign(members.find(m => m.phone === phone), patch);
    },
  };
}

// Billing dates are computed off the REAL today — daysFromToday has no injectable clock —
// so a hardcoded date would make these pass on one day of the year only.
function member(name, phone, overdueDays, extra = {}) {
  const d = new Date();
  d.setDate(d.getDate() - overdueDays);
  return {
    name, phone, status: 'ACTIVE', renewals: 0, paidLast: 0,
    billingDate: formatDate(d), joinDate: formatDate(d), lastRenewed: '', lastUpdated: '',
    ...extra,
  };
}
// ── advance ────────────────────────────────────────────────────────────────────

test('advance moves the billing date N months and keeps the anniversary day', async () => {
  const m = member('A', '9000000001', 0, { billingDate: '27-01-2026' });
  const store = makeStore([m]);
  const h = createRenewalHandlers(store, makeConfig(), quietLog);
  const out = await h.handleAdvance(['9000000001', '3']);

  assert.equal(store.writes[0].patch.billingDate, '27-04-2026');
  assert.match(out, /3 months paid in advance/);
});

// The reason this is one step and not N calls to the single-month path: 31 Jan + 1 + 1 clamps
// to 28 Feb and then to 28 Mar, quietly costing the member three days every short month.
test('a short month clamps once, not once per month', async () => {
  const m = member('A', '9000000001', 0, { billingDate: '31-01-2026' });
  const store = makeStore([m]);
  const h = createRenewalHandlers(store, makeConfig(), quietLog);
  await h.handleAdvance(['9000000001', '2']);
  assert.equal(store.writes[0].patch.billingDate, '31-03-2026');
});

test('advance banks the whole amount at once', async () => {
  const store = makeStore([member('A', '9000000001', 0, { billingDate: '10-02-2026' })]);
  const h = createRenewalHandlers(store, makeConfig(), quietLog);
  await h.handleAdvance(['9000000001', '6']);
  assert.equal(store.writes[0].patch.paidLast, 540);
  assert.equal(store.writes[0].patch.renewals, 6);
});

// The receipt is the only thing the operator sees, and the real store refreshes from the
// sheet inside update() — so both dates must be read off before the write, not after.
test('the receipt shows the old date and the new one, not the new one twice', async () => {
  const store = makeStore([member('A', '9000000001', 0, { billingDate: '20-08-2026', renewals: 4 })]);
  const h = createRenewalHandlers(store, makeConfig(), quietLog);
  const out = await h.handleAdvance(['9000000001', '3']);
  assert.match(out, /20-08-2026 → 20-11-2026/);
  assert.match(out, /Total renewals: 7/);
});

test('advance refuses a months value that is not 1-24', async () => {
  const store = makeStore([member('A', '9000000001', 0)]);
  const h = createRenewalHandlers(store, makeConfig(), quietLog);
  for (const bad of ['0', '-2', '25', 'three', '2.5']) {
    const out = await h.handleAdvance(['9000000001', bad]);
    assert.match(out, /Months must be/, `"${bad}" was accepted`);
  }
  assert.equal(store.writes.length, 0, 'a rejected months value still wrote to the sheet');
});

test('advance on an unreadable billing date says so instead of writing NaN', async () => {
  const store = makeStore([member('A', '9000000001', 0, { billingDate: '' })]);
  const h = createRenewalHandlers(store, makeConfig(), quietLog);
  const out = await h.handleAdvance(['9000000001', '2']);
  assert.match(out, /no readable billing date/);
  assert.equal(store.writes.length, 0);
});

// ── the ledger has to agree with the till ──────────────────────────────────────

// Was `full.length + referral.length * 0.5`: one person, one renewal, and the operator's
// sheet billed a ₹540 advance as ₹90.
test('a 6-month advance counts as six renewals for the ledger, not one', () => {
  const at = formatDateTime(new Date());
  const members = [
    { ...member('Adv', '9000000001', 0), paidLast: 540, renewals: 6, lastRenewed: at, lastUpdated: at },
  ];
  const b = dailyBreakdown(members, makeConfig(), todayStr());
  assert.equal(b.weightedRenewals, 6);
  assert.equal(b.renewalRevenue, 540);
});

test('the ordinary full and referral tiers still weigh 1 and 0.5', () => {
  const at = formatDateTime(new Date());
  const members = [
    { ...member('Full', '9000000001', 0), paidLast: 90, renewals: 1, lastRenewed: at, lastUpdated: at },
    { ...member('Ref', '9000000002', 0), paidLast: 45, renewals: 1, lastRenewed: at, lastUpdated: at },
  ];
  assert.equal(dailyBreakdown(members, makeConfig(), todayStr()).weightedRenewals, 1.5);
});

// ── the morning digest's chase list ────────────────────────────────────────────

// It used to say "AUTO-WARN TODAY (5+ days)" and then list the entire backlog — every
// 20- and 40-day member the bot will never message again.
test('the digest names only the members who actually get msg2 and msg3 today', async () => {
  const members = [
    member('NudgeMe', '9000000001', 5),
    member('FinalMe', '9000000002', 6),
    member('LongGone', '9000000003', 40),
    member('AlsoGone', '9000000004', 12),
  ];
  const report = createReportHandlers(makeStore(members), makeConfig({ botDir: os.tmpdir() }), Date.now(), quietLog);
  const out = await report.handleMorningDigest();

  const chased = out.split('GETTING CHASED TODAY')[1].split('PAST THE LADDER')[0];
  assert.match(chased, /NudgeMe/);
  assert.match(chased, /FinalMe/);
  assert.doesNotMatch(chased, /LongGone/, 'the deep backlog is in the chase list again');
  assert.doesNotMatch(chased, /AlsoGone/);
  assert.match(out, /GETTING CHASED TODAY: 2 members/);
  // Still counted, just under the heading that names the actual next action.
  assert.match(out, /PAST THE LADDER — no more messages \(2\)/);
});

test('a member on a payment delay is not listed as getting chased', async () => {
  const soon = new Date();
  soon.setDate(soon.getDate() + 3);
  const members = [member('Snoozed', '9000000001', 5, { delayUntil: formatDate(soon) })];
  const report = createReportHandlers(makeStore(members), makeConfig({ botDir: os.tmpdir() }), Date.now(), quietLog);
  const out = await report.handleMorningDigest();
  assert.doesNotMatch(out, /GETTING CHASED TODAY/);
});
