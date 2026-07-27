import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { createReminderSender } from '../core/reminderSender.js';
import { todayStr } from '../core/globalConfig.js';

const log = { info() {}, warn() {}, error() {} };

function cfg() {
  return {
    botName: 'bot-x',
    joining: { fee: 90 },
    overdue: { autoReminderDays: 5, finalReminderDays: 6, consolidatedListDays: 7 },
    rateLimits: { circuitBreakerCooldownMs: 1000 },
    messages: { reminder: 'R {name}', overdue: 'O', finalReminder: 'F' },
  };
}

// The referral window is HALF-OPEN: [billingDate - 1 month, billingDate). A refCreditDate
// equal to the billing date is excluded, so credits must be dated strictly earlier.
function daysAgo(n) {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return `${String(d.getDate()).padStart(2, '0')}-${String(d.getMonth() + 1).padStart(2, '0')}-${d.getFullYear()}`;
}

function makeStore(rows) {
  return {
    async refresh() {},
    getAll: () => rows,
    getActive: () => rows.filter(m => m.status === 'ACTIVE'),
    findByPhone: p => rows.find(m => m.phone === p),
    async update(phone, updates) { Object.assign(rows.find(m => m.phone === phone), updates); },
  };
}

test('autoRenewDue renews members with 2+ referrals in the billing window and returns them', async () => {
  const botDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rs-'));
  const today = todayStr();
  const credited = daysAgo(5);
  const rows = [
    { name: 'Ref1', phone: '9000000001', status: 'ACTIVE', billingDate: today, reference: '9000000009', refCreditDate: credited },
    { name: 'Ref2', phone: '9000000002', status: 'ACTIVE', billingDate: today, reference: '9000000009', refCreditDate: credited },
    { name: 'Boss', phone: '9000000009', status: 'ACTIVE', billingDate: today, renewals: 0, paidLast: 90 },
  ];
  const store = makeStore(rows);

  const rs = createReminderSender(cfg(), log);
  const renewed = await rs.autoRenewDue(store, botDir);
  assert.equal(renewed.length, 1, 'only Boss qualifies');
  assert.equal(renewed[0].phone, '9000000009');
  const boss = store.findByPhone('9000000009');
  assert.notEqual(boss.billingDate, today, 'billing advanced');
  assert.equal(boss.paidLast, 0, 'free renewal is not counted as paid');
});

test('autoRenewDue touches nobody when no one has 2 referrals', async () => {
  const botDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rs-'));
  const today = todayStr();
  const rows = [
    { name: 'Ref1', phone: '9000000001', status: 'ACTIVE', billingDate: today, reference: '9000000009', refCreditDate: daysAgo(5) },
    { name: 'Boss', phone: '9000000009', status: 'ACTIVE', billingDate: today, renewals: 0, paidLast: 90 },
  ];
  const store = makeStore(rows);

  const rs = createReminderSender(cfg(), log);
  const renewed = await rs.autoRenewDue(store, botDir);
  assert.deepEqual(renewed, [], 'one referral is not enough');
  assert.equal(store.findByPhone('9000000009').billingDate, today, 'billing untouched');
});
