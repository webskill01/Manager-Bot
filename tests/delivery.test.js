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

// Silence is not evidence. An id nothing has come back about used to be handed to the operator
// as "the bot could not reach them" — but a missed receipt looks exactly like a message that
// never left, and the operator paid for the guess by re-sending reminders that had landed.
// Only an explicit rejection is acted on now; see the 463 test below.
test('a send nothing came back about is never reported', async () => {
  const dir = tmp('deliv-');
  const notices = [];
  const tracker = createDeliveryTracker(quietLog);   // told nothing → everything stays PENDING
  const members = [member('A', '9000000001', 0), member('B', '9000000002', 0)];
  const engine = engineWith(dir, members, sockThatReturns(['id-A', 'id-B']), tracker, notices);

  await engine.tick();
  await engine.tick();

  assert.deepEqual(notices.filter(n => n.includes('Send it yourself')), [],
    'a message with no receipt was reported as one the bot could not send');
  const state = JSON.parse(fs.readFileSync(path.join(dir, 'drip-state.json'), 'utf8'));
  assert.equal(state.undelivered, undefined, 'a guess was written into the evening report');
  // The cycle record stands, so 'missed' does not queue a second copy either.
  assert.ok(JSON.parse(fs.readFileSync(path.join(dir, 'qr-sent.json'), 'utf8'))['9000000001']);
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

  assert.deepEqual(notices.filter(n => n.includes('Send it yourself')), []);
  fs.rmSync(dir, { recursive: true, force: true });
});

// A phone that is merely switched off looks exactly like this. WhatsApp has the message and
// will deliver it the moment that phone comes online, so there is nothing to say about it —
// not a buzz, and not a line in the evening report the operator would only worry at.
test('accepted-but-undelivered is not reported at all', async () => {
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
  await engine.tick();

  assert.deepEqual(notices.filter(n => n.includes('Send it yourself')), [],
    'a message WhatsApp is holding was reported as one the bot could not send');
  assert.deepEqual(notices.filter(n => n.includes('Handing today over')), [],
    'one switched-off phone flipped the whole day to link-only');
  const state = JSON.parse(fs.readFileSync(path.join(dir, 'drip-state.json'), 'utf8'));
  assert.equal(state.undelivered, undefined, 'it went into the evening report anyway');
  // The cycle record stays: the message went out, so 'missed' must not queue a second one.
  const qr = JSON.parse(fs.readFileSync(path.join(dir, 'qr-sent.json'), 'utf8'));
  assert.ok(qr['9000000001'], 'a sent message was forgotten and will be sent again');
  fs.rmSync(dir, { recursive: true, force: true });
});

// One soft look is a phone in a pocket; two is worth writing down. Reporting on the first look
// filled the evening list with members whose message landed twenty minutes later.
test('a soft failure that clears before the next look is never reported', async () => {
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
  ev.emit('messages.update', [{ key: { id: 'id-A' }, update: { status: STATUS.DELIVERY_ACK } }]);
  await engine.tick();

  const state = JSON.parse(fs.readFileSync(path.join(dir, 'drip-state.json'), 'utf8'));
  assert.deepEqual((state.undelivered || []).filter(u => u.includes('9000000001')), [],
    'a message that arrived late was still reported');
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

// ── rejection codes ──────────────────────────────────────────────────────────

import { REJECTION } from '../core/deliveryTracker.js';

// 463 is documented in baileys' own source as "the account is restricted: WhatsApp blocks
// starting new chats but preserves existing ones". Every future send hits the same wall, so
// the caller must be told to stop rather than to retry.
test('a 463 rejection is carried through as fatal, with the code', () => {
  const t = createDeliveryTracker(quietLog);
  const ev = fakeEv();
  t.attach({ ev });
  ev.emit('messages.update', [{
    key: { id: 'A' },
    update: { status: STATUS.ERROR, messageStubParameters: ['463', 'Your account has been restricted'] },
  }]);
  const v = t.verdict('A');
  assert.equal(v.ok, false);
  assert.equal(v.code, '463');
  assert.equal(v.fatal, true, 'a restricted account was reported as retryable');
  assert.match(v.why, /RESTRICTED/);
});

// 479 is a stale session and genuinely does clear on a reconnect — stopping the day for it
// would be an overreaction.
test('a 479 rejection is not fatal', () => {
  const t = createDeliveryTracker(quietLog);
  const ev = fakeEv();
  t.attach({ ev });
  ev.emit('messages.update', [{
    key: { id: 'A' }, update: { status: STATUS.ERROR, messageStubParameters: ['479'] },
  }]);
  assert.equal(t.verdict('A').fatal, false);
});

test('an unknown rejection code degrades to the plain status label', () => {
  const t = createDeliveryTracker(quietLog);
  const ev = fakeEv();
  t.attach({ ev });
  ev.emit('messages.update', [{
    key: { id: 'A' }, update: { status: STATUS.ERROR, messageStubParameters: ['999'] },
  }]);
  const v = t.verdict('A');
  assert.equal(v.fatal, false);
  assert.match(v.why, /rejected/);
});

test('every documented rejection code carries an explanation', () => {
  for (const [code, r] of Object.entries(REJECTION)) {
    assert.ok(r.what && r.detail, `${code} has no explanation`);
    assert.equal(typeof r.fatal, 'boolean');
  }
});

// The behaviour that matters most: one 463 must end the day, not be walked through the
// whole remaining queue.
test('a fatal rejection flips the day to link-only instead of burning the queue', async () => {
  const dir = tmp('fatal-');
  const notices = [];
  const tracker = createDeliveryTracker(quietLog);
  const ev = fakeEv();
  tracker.attach({ ev });
  const members = Array.from({ length: 5 }, (_, i) => member(`M${i}`, `900000000${i}`, 0));
  const engine = engineWith(dir, members,
    sockThatReturns(['id-0', 'id-1', 'id-2', 'id-3', 'id-4']), tracker, notices);

  await engine.tick();
  ev.emit('messages.update', [{
    key: { id: 'id-0' },
    update: { status: STATUS.ERROR, messageStubParameters: ['463'] },
  }]);
  await engine.tick();   // sees the 463 from the previous send

  assert.ok(notices.some(n => n.includes('Handing today over') && n.includes('RESTRICTED')),
    'the operator was not told the account is restricted');
  assert.ok(engine.status().includes('LINK-ONLY'), 'the day kept firing rejected reachouts');

  // The queue keeps moving — as links. Nobody is skipped just because the socket cannot send.
  const handoffs = notices.filter(n => n.includes('Send it yourself')).length;
  await engine.tick();
  assert.ok(notices.filter(n => n.includes('Send it yourself')).length > handoffs,
    'the queue stalled once the day went link-only');
  assert.equal(notices.filter(n => n.includes('Handing today over')).length, 1,
    'the flip was announced more than once');
  fs.rmSync(dir, { recursive: true, force: true });
});

// ── dm with a list ────────────────────────────────────────────────────────────

import { createCommandParser } from '../core/commandParser.js';

function parserFor(members) {
  const store = {
    async refresh() {}, getAll: () => members, getActive: () => members,
    findByPhone: (p) => members.find(m => m.phone === p) || null,
  };
  return createCommandParser(store, {}, {
    ...msgCfg, botName: 'test', botDir: os.tmpdir(), allowedNumbers: [], paidGroups: [],
  }, quietLog, null, Date.now(), null, null, null, new Set(), null, () => null, null, null, null);
}

// mergePhoneFromStart glues consecutive digit groups into one number — right for
// `dm +91 70152 25875`, catastrophic for a list of complete numbers.
test('dm with several whole numbers does not glue them into one', async () => {
  const members = [
    { name: 'Raju', phone: '7015225875', status: 'ACTIVE', renewals: 0, paidLast: 0, billingDate: formatDate(new Date()) },
    { name: 'Krishan', phone: '9056647708', status: 'ACTIVE', renewals: 0, paidLast: 0, billingDate: formatDate(new Date()) },
  ];
  const out = await parserFor(members).parse('dm 7015225875 9056647708');
  const text = Array.isArray(out) ? out.join('\n') : out;
  assert.match(text, /Raju/);
  assert.match(text, /Krishan/);
  assert.match(text, /wa.me\/917015225875/);
  assert.match(text, /wa.me\/919056647708/);
});

test('dm still merges a split single number', async () => {
  const members = [{ name: 'Raju', phone: '7015225875', status: 'ACTIVE', renewals: 0, paidLast: 0, billingDate: formatDate(new Date()) }];
  const out = await parserFor(members).parse('dm +91 70152 25875');
  const text = Array.isArray(out) ? out.join('\n') : out;
  assert.match(text, /wa.me\/917015225875/);
});

test('dm accepts a comma-pasted list', async () => {
  const members = [
    { name: 'Raju', phone: '7015225875', status: 'ACTIVE', renewals: 0, paidLast: 0, billingDate: formatDate(new Date()) },
    { name: 'Krishan', phone: '9056647708', status: 'ACTIVE', renewals: 0, paidLast: 0, billingDate: formatDate(new Date()) },
  ];
  const out = await parserFor(members).parse('dm 7015225875, 9056647708');
  const text = Array.isArray(out) ? out.join('\n') : out;
  assert.match(text, /Raju/);
  assert.match(text, /Krishan/);
});

test('dm names numbers that are not in the sheet rather than dropping them', async () => {
  const members = [{ name: 'Raju', phone: '7015225875', status: 'ACTIVE', renewals: 0, paidLast: 0, billingDate: formatDate(new Date()) }];
  const out = await parserFor(members).parse('dm 7015225875 9999999999');
  const text = Array.isArray(out) ? out.join('\n') : out;
  assert.match(text, /Not in the sheet: 9999999999/);
});
