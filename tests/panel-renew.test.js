import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRenewer } from '../panel/lib/renew.js';
import { detectPayments } from '../panel/lib/sync.js';
import { buildPeople } from '../panel/lib/people.js';
import { openDb } from '../panel/lib/db.js';
import { formatDate } from '../core/globalConfig.js';

const day = (n) => formatDate(new Date(Date.now() + n * 86400e3));
const botCfg = { 'bot-abhi': { botName: 'bot-abhi', renewal: { fullAmount: 100, referralAmount: 100 }, removalDay: 7 } };

function fakeSheet(rows) {
  const writes = [];
  return {
    writes,
    rows,
    getAll: async () => rows.map(r => ({ ...r })),
    updateRow: async (rowIndex, m) => { writes.push(m); rows[rowIndex - 2] = { ...m, rowIndex }; },
  };
}

function setup(billingDate) {
  const sheet = fakeSheet([{ rowIndex: 2, name: 'Gurpreet', phone: '9876543210', status: 'ACTIVE', billingDate, renewals: 3, paidLast: 100, lastRenewed: '' }]);
  const db = openDb(':memory:');
  const rechecked = [];
  const sync = { client: () => sheet, recheck: async (p) => rechecked.push(p) };
  const renewer = createRenewer({ sync, botCfg, db });
  return { sheet, db, renewer, rechecked };
}

test('renew refuses when the row changed since the screen loaded', async () => {
  const { sheet, renewer } = setup(day(-3));
  const r = await renewer.markRenewed({ phone: '9876543210', bot: 'bot-abhi', seenBillingDate: day(-4), user: { id: 1, role: 'admin' } });
  assert.equal(r.status, 409);
  assert.equal(sheet.writes.length, 0);
});

test('renew writes the next billing date, logs paid, audits, rechecks', async () => {
  const { sheet, db, renewer, rechecked } = setup(day(-3));
  const r = await renewer.markRenewed({ phone: '9876543210', bot: 'bot-abhi', seenBillingDate: day(-3), user: { id: 5, role: 'caller' } });
  assert.equal(r.status, 200, r.error);
  assert.equal(sheet.writes.length, 1);
  assert.equal(sheet.writes[0].renewals, 4);
  assert.notEqual(sheet.writes[0].billingDate, day(-3));
  const [a] = db.auditPage();
  assert.equal(a.action, 'renewed');
  assert.equal(JSON.parse(a.detail).verified, false, 'a caller renewal needs admin review');
  assert.equal(db.timeline('9876543210')[0].outcome, 'paid');
  assert.deepEqual(rechecked, ['9876543210']);
});

test('the bot\'s same-month guard is passed through as a 400', async () => {
  const { sheet, renewer } = setup(day(-3));
  sheet.rows[0].lastRenewed = formatDate(new Date()) + ' 10:00';
  const r = await renewer.markRenewed({ phone: '9876543210', bot: 'bot-abhi', seenBillingDate: day(-3), user: { id: 1, role: 'admin' } });
  assert.equal(r.status, 400);
  assert.match(r.error, /already renewed this month/);
});

test('detectPayments: billing moved forward or app expiry moved = one payment', () => {
  const mk = (billingDate, expiresAt) => buildPeople({
    sheets: { 'bot-abhi': [{ name: 'A', phone: '9000000001', status: 'ACTIVE', billingDate, paidLast: 100 }] },
    app: expiresAt ? [{ phone: '9000000001', status: 'active', expiresAt }] : [],
  });
  const before = mk(day(-2));
  assert.deepEqual(detectPayments(before, mk(day(-2)), botCfg), []);
  const [p] = detectPayments(before, mk(day(28)), botCfg);
  assert.deepEqual({ ...p, at: undefined }, { phone: '9000000001', bot: 'bot-abhi', amount: 100, billingFrom: day(-2), source: 'sheet', at: undefined });
  const exp = new Date(Date.now() + 30 * 86400e3).toISOString();
  const both = detectPayments(before, mk(day(28), exp), botCfg);
  assert.equal(both.length, 1, 'sheet and app moving together is still one payment');
  assert.equal(detectPayments(new Map(), mk(day(28)), botCfg).length, 0, 'first sync records nothing');
});
