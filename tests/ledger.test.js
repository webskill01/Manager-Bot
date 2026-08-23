import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { ledgerRowsFor, diffRows } from '../core/ledger.js';
import { yesterdayStr, columnIndex, datesBetween, datesInMonth } from '../core/globalConfig.js';
import { dailyBreakdown } from '../core/handlers/reportHandlers.js';

const CFG = {
  botName: 'bot-test',
  joining: { fee: 90 },
  renewal: { fullAmount: 90, referralAmount: 45, billingCycleDays: 30 },
  overdue: { autoReminderDays: 5, finalReminderDays: 6 },
};

// A paid join on `joinDate`, billed a cycle forward — the shape a real `add` writes.
const join = (phone, joinDate, billingDate = '20-09-2026') => ({
  name: `M${phone}`, phone, joinDate, billingDate, status: 'ACTIVE',
  renewals: 0, paidLast: 90, lastRenewed: '', lastUpdated: joinDate,
});

const renewal = (phone, on, paidLast) => ({
  name: `R${phone}`, phone, joinDate: '01-01-2026', billingDate: '20-09-2026',
  status: 'ACTIVE', renewals: 3, paidLast, lastRenewed: on, lastUpdated: on,
});

// ── date maths ────────────────────────────────────────────────────────────────

test('datesBetween is inclusive at both ends', () => {
  assert.deepEqual(datesBetween('17-08-2026', '20-08-2026'),
    ['17-08-2026', '18-08-2026', '19-08-2026', '20-08-2026']);
  assert.deepEqual(datesBetween('17-08-2026', '17-08-2026'), ['17-08-2026']);
});

test('datesBetween crosses a month boundary', () => {
  assert.deepEqual(datesBetween('30-08-2026', '02-09-2026'),
    ['30-08-2026', '31-08-2026', '01-09-2026', '02-09-2026']);
});

test('a backwards or unparseable range writes nothing rather than looping forever', () => {
  assert.deepEqual(datesBetween('20-08-2026', '17-08-2026'), []);
  assert.deepEqual(datesBetween('not-a-date', '17-08-2026'), []);
  assert.deepEqual(datesBetween('17-08-2026', ''), []);
});

test('yesterdayStr steps back across a month boundary', () => {
  assert.equal(yesterdayStr(new Date(2026, 8, 1)), '31-08-2026');   // 1 Sep → 31 Aug
  assert.equal(yesterdayStr(new Date(2026, 0, 1)), '31-12-2025');   // new year
});

// ── the counts themselves ─────────────────────────────────────────────────────

test('a day of joins and renewals becomes one ledger row', () => {
  const members = [
    join('9000000001', '18-08-2026'),
    join('9000000002', '18-08-2026'),
    renewal('9000000003', '18-08-2026', 90),   // full  → 1
    renewal('9000000004', '18-08-2026', 45),   // half  → 0.5
    renewal('9000000005', '18-08-2026', 0),    // ref-free, earns nothing → not counted
    join('9000000006', '19-08-2026'),          // a different day
  ];
  const [row] = ledgerRowsFor(members, CFG, ['18-08-2026']);
  assert.deepEqual(row, { date: '18-08-2026', bot: 'bot-test', newJoined: 2, renewed: 1.5 });
});

test('a bot with no referral tier never produces a half', () => {
  // abhi/aayush2 price full == referral, so splitRenewals puts everything in `full`.
  const cfg = { ...CFG, renewal: { fullAmount: 100, referralAmount: 100 } };
  const members = [renewal('9000000001', '18-08-2026', 100), renewal('9000000002', '18-08-2026', 100)];
  const [row] = ledgerRowsFor(members, cfg, ['18-08-2026']);
  assert.equal(row.renewed, 2);
});

test('a member renewed today is a renewal, never also a new join', () => {
  const m = { ...join('9000000001', '18-08-2026'), lastRenewed: '18-08-2026', renewals: 1 };
  const [row] = ledgerRowsFor([m], CFG, ['18-08-2026']);
  assert.equal(row.newJoined, 0, 'double-counted as a join AND a renewal');
  assert.equal(row.renewed, 1);
});

test('addsilent rows (paidLast 0) are not join revenue', () => {
  const silent = { ...join('9000000001', '18-08-2026'), paidLast: 0 };
  const [row] = ledgerRowsFor([silent], CFG, ['18-08-2026']);
  assert.equal(row.newJoined, 0);
});

test('a quiet day still gets a row — a gap and a zero mean different things', () => {
  const [row] = ledgerRowsFor([], CFG, ['18-08-2026']);
  assert.deepEqual(row, { date: '18-08-2026', bot: 'bot-test', newJoined: 0, renewed: 0 });
});

test('the ledger and the summary command can never disagree', () => {
  // Both read dailyBreakdown. This pins that they still do.
  const members = [join('9000000001', '18-08-2026'), renewal('9000000002', '18-08-2026', 45)];
  const b = dailyBreakdown(members, CFG, '18-08-2026');
  const [row] = ledgerRowsFor(members, CFG, ['18-08-2026']);
  assert.equal(row.newJoined, b.newToday.length);
  assert.equal(row.renewed, b.weightedRenewals);
});

// ── the diff that keeps the write volume down ─────────────────────────────────

const existing = [
  { rowIndex: 2, date: '17-08-2026', bot: 'bot-test', newJoined: 3, renewed: 1 },
  { rowIndex: 3, date: '17-08-2026', bot: 'bot-other', newJoined: 9, renewed: 9 },
];

test('an unchanged row is not rewritten', () => {
  const { appends, updates } = diffRows(
    [{ date: '17-08-2026', bot: 'bot-test', newJoined: 3, renewed: 1 }], existing);
  assert.deepEqual(appends, []);
  assert.deepEqual(updates, []);
});

test('a changed row is corrected in place, not appended twice', () => {
  const { appends, updates } = diffRows(
    [{ date: '17-08-2026', bot: 'bot-test', newJoined: 4, renewed: 1.5 }], existing);
  assert.deepEqual(appends, []);
  assert.equal(updates.length, 1);
  assert.equal(updates[0].rowIndex, 2, 'correction must target the existing row');
  assert.equal(updates[0].newJoined, 4);
});

test('a missing date is appended', () => {
  const { appends, updates } = diffRows(
    [{ date: '18-08-2026', bot: 'bot-test', newJoined: 1, renewed: 0 }], existing);
  assert.equal(appends.length, 1);
  assert.deepEqual(updates, []);
});

test('a bot never touches another bot\'s row — that is the whole concurrency story', () => {
  // Same date, different bot. If the key were the date alone this would "correct" row 3.
  const { appends, updates } = diffRows(
    [{ date: '17-08-2026', bot: 'bot-test', newJoined: 3, renewed: 1 }], existing);
  assert.deepEqual(updates, []);
  assert.deepEqual(appends, []);
  const other = diffRows([{ date: '17-08-2026', bot: 'bot-third', newJoined: 1, renewed: 0 }], existing);
  assert.equal(other.appends.length, 1, 'a third bot gets its own row');
  assert.deepEqual(other.updates, []);
});

test('an empty tab means everything is an append', () => {
  const wanted = ledgerRowsFor([], CFG, datesBetween('17-08-2026', '19-08-2026'));
  const { appends, updates } = diffRows(wanted, []);
  assert.equal(appends.length, 3);
  assert.deepEqual(updates, []);
});

// ── the shipped configs ───────────────────────────────────────────────────────

const BOTS = ['bot-nitin', 'bot-abhi', 'bot-sachin2', 'bot-aayush2'];

test('every bot has ledger layout in config and its sheet id OUT of it', () => {
  const names = new Set();
  for (const bot of BOTS) {
    const cfg = JSON.parse(fs.readFileSync(`bots/${bot}/config.json`, 'utf8'));
    assert.ok(cfg.ledger, `${bot} has no ledger block`);
    // This repo is public and config.json is committed. The id belongs in the .env, which
    // is not — same rule SHEET_ID already follows.
    assert.equal(cfg.ledger.spreadsheetId, undefined,
      `${bot}: ledger.spreadsheetId must live in bots/${bot}/.env as LEDGER_SHEET_ID`);
    assert.match(cfg.ledger.startDate, /^\d{2}-\d{2}-\d{4}$/, `${bot} startDate must be DD-MM-YYYY`);
    assert.ok(datesBetween(cfg.ledger.startDate, '23-08-2026').length > 0, `${bot} startDate is in the future`);
    names.add(cfg.botName);
  }
  assert.equal(names.size, BOTS.length, 'two bots share a botName — their rows would collide');
});

test('a summary column letter maps to the right index, and nonsense reads nothing', () => {
  assert.equal(columnIndex('A'), 0);
  assert.equal(columnIndex('L'), 11);   // TOTAL PER PERSON
  assert.equal(columnIndex('AA'), 26);
  for (const bad of ['', null, '3', 'A1', 'ABC', ' ']) {
    assert.equal(columnIndex(bad), -1, `"${bad}" must not resolve to a real column`);
  }
});
