import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createReminderSender } from '../core/reminderSender.js';
import { formatDate, formatDateTime } from '../core/globalConfig.js';

const log = { info() {}, warn() {}, error() {} };

function makeConfig() {
  return {
    upiQrPath: './does-not-exist.jpg', // → sends plain text instead of image
    messages: { reminder: 'hi {name} {date}', referralReminder: 'ref {name}' },
    rateLimits: {
      memberToMemberGapMinMs: 0, memberToMemberGapMaxMs: 0, batchSize: 20,
      circuitBreakerThreshold: 10, circuitBreakerCooldownMs: 1000,
    },
  };
}

// Minimal in-memory store mirroring memberStore's surface used by the reminder sender.
function makeStore(initial) {
  let members = initial.map(m => ({ ...m }));
  return {
    async refresh() {},
    getActive() { return members.filter(m => m.status === 'ACTIVE'); },
    getAll() { return members.map(m => ({ ...m })); },
    async update(phone, updates) {
      members = members.map(m => m.phone === phone ? { ...m, ...updates } : m);
    },
  };
}

function makeSock() {
  const sent = [];
  return { sock: { user: { id: 'bot' }, async sendMessage(jid, msg) { sent.push({ jid, msg }); } }, sent };
}

test('renewed-today member is NOT sent a reminder in batch 2 (double-reminder bug fix)', async () => {
  const botDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rem-'));
  const today = formatDate(new Date());
  const store = makeStore([
    { name: 'Avtar', phone: '9000000001', status: 'ACTIVE', billingDate: today, renewals: 1, paidLast: 90, reference: '' },
  ]);
  const { sock, sent } = makeSock();
  const sender = createReminderSender(makeConfig(), log);

  // Batch 1: due-today member gets the first reminder.
  const r1 = await sender.sendReminders(store, () => sock, botDir);
  assert.equal(r1.sent, 1, 'batch 1 should send one reminder');
  assert.equal(sent.length, 1);

  // Operator renews them the same morning: lastRenewed=today. Even in the WORST case where
  // the billing date somehow still reads as today, the renewedOn guard must exclude them.
  await store.update('9000000001', { lastRenewed: formatDateTime(new Date()) });

  // Batch 2: must send nothing to the renewed member.
  const r2 = await sender.sendRemindersSecondBatch(store, () => sock, botDir);
  assert.equal(r2.sent, 0, 'renewed member must not get a second reminder');
  assert.equal(sent.length, 1, 'no extra message sent');

  fs.rmSync(botDir, { recursive: true, force: true });
});

test('non-renewed member held for batch 2 still gets their reminder', async () => {
  const botDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rem-'));
  const today = formatDate(new Date());
  const store = makeStore([
    { name: 'A', phone: '9000000001', status: 'ACTIVE', billingDate: today, renewals: 0, paidLast: 90, reference: '' },
    { name: 'B', phone: '9000000002', status: 'ACTIVE', billingDate: today, renewals: 0, paidLast: 90, reference: '' },
  ]);
  const { sock, sent } = makeSock();
  const config = makeConfig();
  config.rateLimits.batchSize = 1; // force B into batch 2
  const sender = createReminderSender(config, log);

  const r1 = await sender.sendReminders(store, () => sock, botDir);
  assert.equal(r1.sent, 1);
  assert.equal(r1.queued, 1);

  const r2 = await sender.sendRemindersSecondBatch(store, () => sock, botDir);
  assert.equal(r2.sent, 1, 'batch 2 sends the held member');
  assert.equal(sent.length, 2);

  fs.rmSync(botDir, { recursive: true, force: true });
});

test('catch-up after restart sends due-today reminders missed across both cron windows', async () => {
  const botDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rem-'));
  const today = formatDate(new Date());
  const store = makeStore([
    { name: 'A', phone: '9000000001', status: 'ACTIVE', billingDate: today, renewals: 0, paidLast: 90, reference: '' },
    { name: 'B', phone: '9000000002', status: 'ACTIVE', billingDate: today, renewals: 0, paidLast: 90, reference: '' },
  ]);
  const { sock, sent } = makeSock();
  const sender = createReminderSender(makeConfig(), log);

  // Bot was offline at 6:30 and 7:30 — neither cron ran, nothing in reminder-state.json yet.
  // On reconnect, catch-up must deliver every due-today member.
  const r1 = await sender.catchUp(store, () => sock, botDir);
  assert.equal(r1.sent, 2, 'catch-up should send both missed reminders');
  assert.equal(sent.length, 2);

  // Running catch-up again (e.g. a second reconnect) must NOT re-message anyone.
  const r2 = await sender.catchUp(store, () => sock, botDir);
  assert.equal(r2.sent, 0, 'catch-up must be idempotent — no double-send');
  assert.equal(sent.length, 2, 'no extra messages on second catch-up');

  fs.rmSync(botDir, { recursive: true, force: true });
});

test('catch-up only sends members not already reminded earlier today', async () => {
  const botDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rem-'));
  const today = formatDate(new Date());
  const store = makeStore([
    { name: 'A', phone: '9000000001', status: 'ACTIVE', billingDate: today, renewals: 0, paidLast: 90, reference: '' },
    { name: 'B', phone: '9000000002', status: 'ACTIVE', billingDate: today, renewals: 0, paidLast: 90, reference: '' },
  ]);
  const { sock, sent } = makeSock();
  const config = makeConfig();
  config.rateLimits.batchSize = 1; // batch 1 sends only A, B is held
  const sender = createReminderSender(config, log);

  const r1 = await sender.sendReminders(store, () => sock, botDir);
  assert.equal(r1.sent, 1, 'batch 1 sends A');
  assert.equal(r1.queued, 1, 'B held for batch 2');

  // Bot restarts before the 7:30 batch-2 cron fires. Catch-up must send B only — never re-send A.
  const r2 = await sender.catchUp(store, () => sock, botDir);
  assert.equal(r2.sent, 1, 'catch-up sends the held member B');
  assert.equal(sent.length, 2, 'A messaged once, B messaged once');

  fs.rmSync(botDir, { recursive: true, force: true });
});

test('referral rollover: >2 refs auto-renews and re-pins surplus into next window', async () => {
  const botDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rem-'));
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const billing = formatDate(today); // due today
  const windowDate = formatDate(new Date(today.getFullYear(), today.getMonth(), today.getDate() - 5));

  const referrer = '9000000010';
  const store = makeStore([
    { name: 'Ref', phone: referrer, status: 'ACTIVE', billingDate: billing, renewals: 2, paidLast: 0, reference: '' },
    // 4 referrals inside the current window
    { name: 'r1', phone: '9000000011', status: 'ACTIVE', billingDate: billing, reference: referrer, joinDate: windowDate, paidLast: 90 },
    { name: 'r2', phone: '9000000012', status: 'ACTIVE', billingDate: billing, reference: referrer, joinDate: windowDate, paidLast: 90 },
    { name: 'r3', phone: '9000000013', status: 'ACTIVE', billingDate: billing, reference: referrer, joinDate: windowDate, paidLast: 90 },
    { name: 'r4', phone: '9000000014', status: 'ACTIVE', billingDate: billing, reference: referrer, joinDate: windowDate, paidLast: 90 },
  ]);
  const { sock } = makeSock();
  const sender = createReminderSender(makeConfig(), log);

  const r = await sender.sendReminders(store, () => sock, botDir);
  const auto = r.autoRenewed.find(a => a.phone === referrer);
  assert.ok(auto, 'referrer should be auto-renewed');
  assert.equal(auto.rolled, 2, 'two surplus refs should roll over (4 refs - 2 used)');

  // The two surplus referrals now carry a refCreditDate (re-pinned forward)
  const repinned = store.getAll().filter(m => m.reference === referrer && m.refCreditDate);
  assert.equal(repinned.length, 2, 'exactly two surplus refs re-pinned');

  fs.rmSync(botDir, { recursive: true, force: true });
});
