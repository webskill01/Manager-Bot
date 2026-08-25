import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { createDeliveryTracker, STATUS } from '../core/deliveryTracker.js';
import { createDripEngine } from '../core/dripEngine.js';
import { formatDate } from '../core/globalConfig.js';

const quietLog = { info() {}, warn() {}, error() {} };
const tmp = (p) => fs.mkdtempSync(path.join(os.tmpdir(), p));

// A minimal emitter with the shape Baileys' sock.ev exposes.
function fakeEv() {
  const handlers = {};
  return {
    on: (name, fn) => { (handlers[name] ??= []).push(fn); },
    emit: (name, payload) => { for (const fn of handlers[name] || []) fn(payload); },
  };
}

// ── the tracker ───────────────────────────────────────────────────────────────

test('an id nothing has come back about reads as PENDING, not undefined', () => {
  const t = createDeliveryTracker(quietLog);
  assert.equal(t.statusOf('never-heard-of'), STATUS.PENDING);
});

test('a delivery receipt is recorded and reads as delivered', () => {
  const t = createDeliveryTracker(quietLog);
  const ev = fakeEv();
  t.attach({ ev });
  ev.emit('messages.update', [{ key: { id: 'A' }, update: { status: STATUS.DELIVERY_ACK } }]);
  assert.equal(t.verdict('A').ok, true);
});

// Baileys emits `status: undefined` for receipt types outside its STATUS_MAP (verified in
// Utils/generics.js). Reading that as 0 would report every such message as rejected.
test('a non-numeric status is ignored, not read as ERROR', () => {
  const t = createDeliveryTracker(quietLog);
  const ev = fakeEv();
  t.attach({ ev });
  ev.emit('messages.update', [{ key: { id: 'A' }, update: { status: undefined } }]);
  ev.emit('messages.update', [{ key: { id: 'A' }, update: {} }]);
  assert.equal(t.statusOf('A'), STATUS.PENDING, 'an unknown receipt type corrupted the status');
});

// Receipts can arrive out of order; a late duplicate must not walk READ back to SERVER_ACK.
test('the highest status wins regardless of arrival order', () => {
  const t = createDeliveryTracker(quietLog);
  const ev = fakeEv();
  t.attach({ ev });
  ev.emit('messages.update', [{ key: { id: 'A' }, update: { status: STATUS.READ } }]);
  ev.emit('messages.update', [{ key: { id: 'A' }, update: { status: STATUS.SERVER_ACK } }]);
  assert.equal(t.statusOf('A'), STATUS.READ);
});

// The two tiers are the whole design: one is always the bot's problem, the other is usually
// just a phone that is switched off.
test('never leaving is a HARD failure; accepted-but-undelivered is soft', () => {
  const t = createDeliveryTracker(quietLog);
  const ev = fakeEv();
  t.attach({ ev });

  assert.equal(t.verdict('silent').hard, true, 'a message that never left was called soft');

  ev.emit('messages.update', [{ key: { id: 'B' }, update: { status: STATUS.SERVER_ACK } }]);
  const b = t.verdict('B');
  assert.equal(b.ok, false);
  assert.equal(b.hard, false, 'a phone being off would have buzzed the operator');
});

test('the map is trimmed rather than growing without bound', () => {
  const t = createDeliveryTracker(quietLog, { max: 10 });
  const ev = fakeEv();
  t.attach({ ev });
  for (let i = 0; i < 50; i++) {
    ev.emit('messages.update', [{ key: { id: `m${i}` }, update: { status: STATUS.DELIVERY_ACK } }]);
  }
  assert.ok(t.size() <= 10, `map grew to ${t.size()}`);
  assert.equal(t.statusOf('m49'), STATUS.DELIVERY_ACK, 'the newest entry was evicted');
});

// Listeners live on the socket, and Baileys hands out a new one on every reconnect — which
// on this bot is roughly hourly.
test('the tracker keeps working after a reconnect swaps the socket', () => {
  const t = createDeliveryTracker(quietLog);
  const first = fakeEv();
  t.attach({ ev: first });
  const second = fakeEv();
  t.attach({ ev: second });
  second.emit('messages.update', [{ key: { id: 'A' }, update: { status: STATUS.DELIVERY_ACK } }]);
  assert.equal(t.verdict('A').ok, true, 'the tracker went deaf on the new socket');
});

// ── the drip, using it ────────────────────────────────────────────────────────

function member(name, phone, overdueDays) {
  const d = new Date();
  d.setDate(d.getDate() - overdueDays);
  return { name, phone, status: 'ACTIVE', renewals: 0, paidLast: 0, billingDate: formatDate(d) };
}

const cfg = (dir) => ({
  joining: { fee: 90 }, renewal: { fullAmount: 90, referralAmount: 45 },
  overdue: { autoReminderDays: 5, finalReminderDays: 6, consolidatedListDays: 7 },
  messages: { reminder: 'due {name}', overdue: 'late {name}', finalReminder: 'final {name}' },
  botDir: dir, drip: { mode: 'auto', startHour: 0, endHour: 24, humanDelay: false },
});

function sockThatReturns(ids) {
  let n = 0;
  return {
    user: { id: 'bot' },
    async presenceSubscribe() {}, async sendPresenceUpdate() {},
    async onWhatsApp(pn) { return [{ exists: true, jid: `${pn}@s.whatsapp.net` }]; },
    async sendMessage() { return { key: { id: ids[n++] } }; },
  };
}

function engineWith(dir, members, sock, tracker, notices) {
  return createDripEngine(
    cfg(dir), quietLog, { refresh: async () => {}, getAll: () => members },
    { autoRenewDue: async () => [] }, async (t) => { notices.push(t); },
    { getSock: () => sock, warmingUp: () => false, tracker },
  );
}

test('a message that never left is reported on the next tick, not the same one', async () => {
  const dir = tmp('deliv-');
  const notices = [];
  const tracker = createDeliveryTracker(quietLog);   // told nothing → everything stays PENDING
  const members = [member('A', '9000000001', 0), member('B', '9000000002', 0)];
  const engine = engineWith(dir, members, sockThatReturns(['id-A', 'id-B']), tracker, notices);

  await engine.tick();
  assert.deepEqual(notices, [], 'it complained before any grace period had passed');
  await engine.tick();

  assert.ok(notices.some(n => n.includes('Not delivered') && n.includes('A')),
    'a message that never left was still reported as sent');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('a delivered message is never reported', async () => {
  const dir = tmp('deliv-');
  const notices = [];
  const tracker = createDeliveryTracker(quietLog);
  const ev = fakeEv();
  tracker.attach({ ev });
  const members = [member('A', '9000000001', 0), member('B', '9000000002', 0)];
  const engine = engineWith(dir, members, sockThatReturns(['id-A', 'id-B']), tracker, notices);

  await engine.tick();
  ev.emit('messages.update', [{ key: { id: 'id-A' }, update: { status: STATUS.DELIVERY_ACK } }]);
  await engine.tick();

  assert.deepEqual(notices.filter(n => n.includes('Not delivered')), []);
  fs.rmSync(dir, { recursive: true, force: true });
});

// A phone that is merely switched off looks exactly like this, so it must not buzz — but it
// must still be counted, because twelve of eighteen is a filtered number, not twelve holidays.
test('accepted-but-undelivered is counted for the evening, not buzzed about', async () => {
  const dir = tmp('deliv-');
  const notices = [];
  const tracker = createDeliveryTracker(quietLog);
  const ev = fakeEv();
  tracker.attach({ ev });
  const members = [member('A', '9000000001', 0), member('B', '9000000002', 0)];
  const engine = engineWith(dir, members, sockThatReturns(['id-A', 'id-B']), tracker, notices);

  await engine.tick();
  ev.emit('messages.update', [{ key: { id: 'id-A' }, update: { status: STATUS.SERVER_ACK } }]);
  await engine.tick();

  assert.deepEqual(notices.filter(n => n.includes('Not delivered')), [],
    'a switched-off phone buzzed the operator');
  const state = JSON.parse(fs.readFileSync(path.join(dir, 'drip-state.json'), 'utf8'));
  assert.equal(state.undelivered.length, 1, 'it was not recorded for the evening report');
  fs.rmSync(dir, { recursive: true, force: true });
});

// sendMessage is typed Promise<WAMessage | undefined> — it really can resolve with nothing.
test('a send that returns no message id does not crash the tick', async () => {
  const dir = tmp('deliv-');
  const sock = {
    user: { id: 'bot' },
    async presenceSubscribe() {}, async sendPresenceUpdate() {},
    async onWhatsApp(pn) { return [{ exists: true, jid: `${pn}@s.whatsapp.net` }]; },
    async sendMessage() { return undefined; },
  };
  const engine = engineWith(dir, [member('A', '9000000001', 0)], sock,
    createDeliveryTracker(quietLog), []);
  await engine.tick();
  await engine.tick();
  assert.ok(engine.status().includes('1 sent by the bot'));
  fs.rmSync(dir, { recursive: true, force: true });
});

// A bot with no tracker wired (core/telegram.js) must behave exactly as it did before.
test('with no tracker the engine assumes delivery, as it always did', async () => {
  const dir = tmp('deliv-');
  const notices = [];
  const members = [member('A', '9000000001', 0), member('B', '9000000002', 0)];
  const engine = createDripEngine(
    cfg(dir), quietLog, { refresh: async () => {}, getAll: () => members },
    { autoRenewDue: async () => [] }, async (t) => { notices.push(t); },
    { getSock: () => sockThatReturns(['id-A', 'id-B']), warmingUp: () => false },
  );
  await engine.tick();
  await engine.tick();
  assert.deepEqual(notices.filter(n => n.includes('Not delivered')), []);
  fs.rmSync(dir, { recursive: true, force: true });
});

// ── dmRowFor: reaching one member outside every cohort ────────────────────────

import { dmRowFor } from '../core/dmList.js';

const msgCfg = {
  joining: { fee: 90 }, renewal: { fullAmount: 90, referralAmount: 45 },
  overdue: { autoReminderDays: 5, finalReminderDays: 6, consolidatedListDays: 7 },
  messages: { reminder: 'Hi {name}, due {date}', overdue: 'late {name}', finalReminder: 'final {name}' },
};

// The case this exists for: a day-6 member missed yesterday is day 7 today, past the ladder
// and absent from every dmlist — with no way to reach them but retyping the message by hand.
test('a member past the ladder still gets a link', () => {
  const row = dmRowFor(member('Raju', '7015225875', 9), msgCfg);
  assert.equal(row.stage, 'msg3');
  assert.equal(row.overdueDays, 9);
  assert.ok(row.link.startsWith('https://wa.me/917015225875?text='));
  assert.ok(decodeURIComponent(row.link).includes('Raju'), 'the name never reached the text');
});

test('the stage can be forced', () => {
  assert.equal(dmRowFor(member('A', '9000000001', 9), msgCfg, { stage: 'msg1' }).stage, 'msg1');
});

test('a referral halves the fee, like the list does', () => {
  assert.equal(dmRowFor(member('A', '9000000001', 0), msgCfg, { referral: true }).fee, 45);
});

test('{name} and {date} are both substituted, never left raw', () => {
  const row = dmRowFor(member('Bob', '9000000001', 0), msgCfg);
  assert.doesNotMatch(row.text, /\{name\}|\{date\}/, 'a placeholder would be sent literally');
  assert.match(row.text, /Bob/);
});
