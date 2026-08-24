import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createReportHandlers } from '../core/handlers/reportHandlers.js';
import { datesInMonth } from '../core/globalConfig.js';

const log = { info() {}, warn() {}, error() {} };
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'xbot-'));

const cfg = (over = {}) => ({
  botName: 'bot-test', botDir: tmp(),
  joining: { fee: 90 },
  renewal: { fullAmount: 90, referralAmount: 45, billingCycleDays: 30 },
  overdue: { autoReminderDays: 5, finalReminderDays: 6, consolidatedListDays: 7 },
  ...over,
});

const store = (members = []) => ({
  refresh: async () => {}, getAll: () => members, getActive: () => members,
});

// Stands in for the real ledger: records what it was asked for, answers with fixed figures.
function fakeLedger(sums = { "From friends' bots": 175, 'Total per person': 580 }) {
  const asked = [];
  return {
    asked,
    enabled: true,
    sumFor: async (dates) => { asked.push(dates); return sums; },
  };
}

const DAY = 24 * 60 * 60 * 1000;
const ddmmyyyy = (d) => {
  const p = (x) => String(x).padStart(2, '0');
  return `${p(d.getDate())}-${p(d.getMonth() + 1)}-${d.getFullYear()}`;
};

test('every revenue report on the sheet-owning bot carries the cross-bot block', async () => {
  const ledger = fakeLedger();
  const r = createReportHandlers(store(), cfg(), Date.now(), log, ledger);

  for (const [name, out] of [
    ['summary', await r.handleSummary([])],
    ['revenue', await r.handleRevenue()],
    ['weekly', await r.handleWeekly()],
    ['monthly', await r.handleMonthly([])],
    ['digest', await r.handleMorningDigest()],
  ]) {
    assert.match(out, /🌐 ALL BOTS/, `${name} lost the cross-bot block`);
    assert.match(out, /From friends' bots: +₹175/, `${name}: friends' figure missing`);
    assert.match(out, /Total per person: +₹580/, `${name}: our total missing`);
  }
});

test('a friend bot shows only its own money — no summaryTab, no cross-bot block', async () => {
  // The friend bots name no summaryTab, so createLedger's sumFor returns null and the block
  // never renders. Their operators must not see the group's numbers.
  const ledger = { enabled: true, sumFor: async () => null };
  const r = createReportHandlers(store(), cfg(), Date.now(), log, ledger);
  for (const out of [await r.handleSummary([]), await r.handleRevenue(), await r.handleWeekly()]) {
    assert.doesNotMatch(out, /ALL BOTS/);
    assert.doesNotMatch(out, /per person: +₹580/);
  }
});

test('no ledger at all is fine — the reports are unchanged', async () => {
  const r = createReportHandlers(store(), cfg(), Date.now(), log, null);
  for (const out of [await r.handleSummary([]), await r.handleRevenue(), await r.handleMonthly([])]) {
    assert.doesNotMatch(out, /ALL BOTS/);
    assert.ok(out.length > 0);
  }
});

test('a Sheets failure costs the block, never the whole report', async () => {
  const ledger = { enabled: true, sumFor: async () => { throw new Error('quota exceeded'); } };
  const r = createReportHandlers(store(), cfg(), Date.now(), log, ledger);
  const out = await r.handleSummary([]);
  assert.doesNotMatch(out, /ALL BOTS/);
  assert.match(out, /Daily Summary/, 'the report itself must still arrive');
});

test('each report asks for exactly its own window', async () => {
  const ledger = fakeLedger();
  const r = createReportHandlers(store(), cfg(), Date.now(), log, ledger);
  const now = new Date();

  await r.handleSummary([]);
  assert.deepEqual(ledger.asked.at(-1), [ddmmyyyy(now)], 'summary is one day');

  await r.handleSummary(['1']);
  assert.deepEqual(ledger.asked.at(-1), [ddmmyyyy(new Date(now - DAY))], 'summary 1 is yesterday');

  await r.handleMorningDigest();
  assert.deepEqual(ledger.asked.at(-1), [ddmmyyyy(new Date(now - DAY))], 'digest reports yesterday');

  await r.handleWeekly();
  const week = ledger.asked.at(-1);
  assert.equal(week.length, 7, 'weekly is 7 days');
  assert.equal(week.at(-1), ddmmyyyy(now), 'weekly ends today');

  await r.handleRevenue();
  assert.deepEqual(ledger.asked.at(-1), datesInMonth(now.getMonth() + 1, now.getFullYear()),
    'revenue is the whole current month');

  await r.handleMonthly(['january', '2026']);
  assert.deepEqual(ledger.asked.at(-1), datesInMonth(1, 2026), 'monthly follows its argument');
});

test('the labels and columns bot-nitin ships are the ones the sheet actually has', () => {
  const nitin = JSON.parse(fs.readFileSync('bots/bot-nitin/config.json', 'utf8'));
  assert.deepEqual(nitin.ledger.summaryColumns, {
    "From friends' bots": 'J',   // REVENUE BY THEM
    'Total per person': 'L',     // TOTAL PER PERSON
  });
  // Only the bot whose operator owns the revenue sheet reads it back.
  for (const bot of ['bot-abhi', 'bot-sachin2', 'bot-aayush2']) {
    const cf = JSON.parse(fs.readFileSync(`bots/${bot}/config.json`, 'utf8'));
    assert.equal(cf.ledger.summaryTab, undefined, `${bot} must not read the group's totals`);
    assert.equal(cf.ledger.summaryColumns, undefined, `${bot} must not read the group's totals`);
  }
});

test('an all-zero block says why, instead of looking broken', async () => {
  // Today's figures are legitimately ₹0 until the 10 PM write, while the bot's own revenue
  // above is already non-zero. Unexplained, that reads as a bug.
  const zero = { enabled: true, sumFor: async () => ({ "From friends' bots": 0, 'Total per person': 0 }) };
  const out = await createReportHandlers(store(), cfg(), Date.now(), log, zero).handleSummary([]);
  assert.match(out, /shared sheet fills at 10 PM and 5 AM/);

  const nonzero = fakeLedger();
  const out2 = await createReportHandlers(store(), cfg(), Date.now(), log, nonzero).handleSummary([]);
  assert.doesNotMatch(out2, /not written for this window yet/, 'the note is noise once there is data');
});

test('a part-zero window is real data, not a pending one', async () => {
  const partial = { enabled: true, sumFor: async () => ({ "From friends' bots": 0, 'Total per person': 405 }) };
  const out = await createReportHandlers(store(), cfg(), Date.now(), log, partial).handleSummary([]);
  assert.doesNotMatch(out, /not written for this window yet/);
  assert.match(out, /From friends' bots: +₹0/);
});
