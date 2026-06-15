import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRenewalHandlers } from '../core/handlers/renewalHandlers.js';
import { formatDate, formatDateTime, parseDate, daysFromToday } from '../core/globalConfig.js';

const log = { info() {}, warn() {}, error() {} };

function makeStore(initial) {
  let members = initial.map(m => ({ ...m }));
  return {
    findByPhone(phone) { return members.find(m => m.phone === phone) || null; },
    async update(phone, updates) {
      members = members.map(m => m.phone === phone ? { ...m, ...updates } : m);
      return members.find(m => m.phone === phone);
    },
    getAll() { return members.map(m => ({ ...m })); },
  };
}

function makeConfig() {
  return {
    renewal: { fullAmount: 90, referralAmount: 45 },
    botDir: fs.mkdtempSync(path.join(os.tmpdir(), 'ren-')),
  };
}

test('same-day normal renewal pushes billing ~1 month forward', async () => {
  const config = makeConfig();
  const today = formatDate(new Date());
  const store = makeStore([{ name: 'A', phone: '9000000001', status: 'ACTIVE', billingDate: today, renewals: 1, paidLast: 90, lastRenewed: '' }]);
  const { handleRenewed } = createRenewalHandlers(store, config, log);

  const reply = await handleRenewed(['9000000001']);
  assert.match(reply, /renewed/i);
  const after = store.findByPhone('9000000001');
  assert.ok(daysFromToday(after.billingDate) >= 27, 'billing should move ~a month ahead');
  fs.rmSync(config.botDir, { recursive: true, force: true });
});

test('renewed force = advance: stacks +1 month on current future billing, preserves day', async () => {
  const config = makeConfig();
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const future = new Date(today); future.setDate(future.getDate() + 20); // billing already in the future
  const billing = formatDate(future);
  // Already renewed earlier this month → guard would block a normal renew; force overrides.
  const lastRenewed = formatDateTime(new Date(today.getFullYear(), today.getMonth(), 1, 9, 0));
  const store = makeStore([{ name: 'A', phone: '9000000001', status: 'ACTIVE', billingDate: billing, renewals: 1, paidLast: 90, lastRenewed }]);
  const { handleRenewed } = createRenewalHandlers(store, config, log);

  const reply = await handleRenewed(['9000000001', 'force']);
  assert.match(reply, /advance/i, 'reply should label it an advance payment');

  const after = parseDate(store.findByPhone('9000000001').billingDate);
  const expected = new Date(future.getFullYear(), future.getMonth() + 1, future.getDate());
  assert.equal(after.getFullYear(), expected.getFullYear());
  assert.equal(after.getMonth(), expected.getMonth(), 'billing advanced exactly one month');
  assert.equal(after.getDate(), future.getDate(), 'billing day-of-month preserved');
  fs.rmSync(config.botDir, { recursive: true, force: true });
});

test('same-month renewal is blocked without force', async () => {
  const config = makeConfig();
  const today = formatDate(new Date());
  const store = makeStore([{ name: 'A', phone: '9000000001', status: 'ACTIVE', billingDate: today, renewals: 1, paidLast: 90, lastRenewed: formatDateTime(new Date()) }]);
  const { handleRenewed } = createRenewalHandlers(store, config, log);

  const reply = await handleRenewed(['9000000001']);
  assert.match(reply, /already renewed this month/i);
  fs.rmSync(config.botDir, { recursive: true, force: true });
});
