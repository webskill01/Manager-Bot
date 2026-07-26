import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { overdueCohort, formatDate, daysFromToday } from '../core/globalConfig.js';
import { createCatchupEngine } from '../core/catchupEngine.js';
import { createMemberHandlers } from '../core/handlers/memberHandlers.js';

const log = { info() {}, warn() {}, error() {} };

// Date N days from today in the sheet's DD-MM-YYYY format.
function dayOffset(n) {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() + n);
  return formatDate(d);
}

function member(over, extra = {}) {
  return {
    name: `M${over}`,
    phone: `90000000${String(Math.abs(over)).padStart(2, '0')}`,
    billingDate: dayOffset(-over),
    status: 'ACTIVE',
    ...extra,
  };
}

// Minimal in-memory store standing in for memberStore + Google Sheets.
function fakeStore(members) {
  let rows = members.map(m => ({ ...m }));
  const writes = [];
  let refreshes = 0;
  return {
    writes,
    get refreshes() { return refreshes; },
    getAll: () => rows.map(m => ({ ...m })),
    getActive: () => rows.filter(m => m.status === 'ACTIVE').map(m => ({ ...m })),
    findByPhone: p => rows.find(m => m.phone === p) || null,
    async refresh() { refreshes++; },
    async update(phone, updates, opts = {}) {
      const row = rows.find(m => m.phone === phone);
      if (!row) throw new Error(`Member not found: ${phone}`);
      Object.assign(row, updates);
      writes.push({ phone, updates, skipRefresh: !!opts.skipRefresh });
      return opts.skipRefresh ? null : { ...row };
    },
  };
}

function tmpBotDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'catchup-'));
}

const baseConfig = botDir => ({
  botDir,
  paidGroups: ['g1@g.us'],
  reminder: { mode: 'group', groupId: 'g1@g.us' },
  messages: {
    groupReminder: 'REMIND {date}',
    groupOverdue: 'OVERDUE {date}',
    groupFinal: 'FINAL {date}',
  },
});

// ── overdueCohort ────────────────────────────────────────────────────────────

test('overdueCohort: window bounds who is pulled in, sorted most-overdue first', () => {
  const members = [
    member(3),                                   // inside an 8-day window
    member(8),                                   // exactly on the boundary
    member(9),                                   // outside — already had its messages
    member(-2),                                  // billing in the future, not due
    { ...member(5), status: 'REMOVED' },         // not ACTIVE
  ];

  const windowed = overdueCohort(members, 8);
  assert.deepEqual(windowed.map(m => m.name), ['M8', 'M3'], 'boundary included, 9d excluded, sorted');

  const all = overdueCohort(members, null);
  assert.deepEqual(all.map(m => m.name), ['M9', 'M8', 'M3'], 'null window = every overdue member');
});

test('overdueCohort: members due today are excluded — the daily digest still covers them', () => {
  const dueToday = { name: 'T', phone: '9000000099', billingDate: dayOffset(0), status: 'ACTIVE' };
  assert.equal(overdueCohort([dueToday], 8).length, 0);
});

test('overdueCohort: unparseable billing dates never crash or leak through', () => {
  const junk = { name: 'J', phone: '9000000098', billingDate: '', status: 'ACTIVE' };
  assert.equal(overdueCohort([junk, null], 8).length, 0);
});

// ── delayall ─────────────────────────────────────────────────────────────────

test('delayall: preview writes nothing and states the target date', async () => {
  const store = fakeStore([member(3), member(6)]);
  const h = createMemberHandlers(store, {}, { botDir: tmpBotDir() }, log);

  const out = await h.handleDelayAll(['7']);
  assert.match(out, /DELAYALL PREVIEW — 2 overdue/);
  assert.match(out, new RegExp(dayOffset(7)));
  assert.match(out, /delayall 7 confirm/);
  assert.equal(store.writes.length, 0, 'preview must not write');
});

test('delayall confirm: sets delayUntil on every overdue member and never touches BILLING_DATE', async () => {
  const rows = [member(3), member(6)];
  const originalBilling = rows.map(r => r.billingDate);
  const store = fakeStore(rows);
  const h = createMemberHandlers(store, {}, { botDir: tmpBotDir() }, log);

  const out = await h.handleDelayAll(['7', 'confirm']);

  assert.match(out, /Delayed 2 member\(s\)/);
  assert.equal(store.writes.length, 2);
  for (const w of store.writes) {
    assert.deepEqual(Object.keys(w.updates), ['delayUntil'], 'delayUntil is the ONLY field written');
    assert.equal(w.updates.delayUntil, dayOffset(7));
    assert.ok(w.skipRefresh, 'bulk writes must skip the per-row refresh');
  }
  assert.deepEqual(store.getAll().map(m => m.billingDate), originalBilling, 'billing dates unchanged');
});

test('delayall: members due today or in the future are left alone', async () => {
  const store = fakeStore([
    member(4),
    { name: 'Future', phone: '9000000097', billingDate: dayOffset(5), status: 'ACTIVE' },
    { name: 'Today', phone: '9000000096', billingDate: dayOffset(0), status: 'ACTIVE' },
  ]);
  const h = createMemberHandlers(store, {}, { botDir: tmpBotDir() }, log);

  await h.handleDelayAll(['7', 'confirm']);
  assert.deepEqual(store.writes.map(w => w.phone), ['9000000004']);
});

test('delayall: rejects bad input and reports an empty cohort', async () => {
  const h = createMemberHandlers(fakeStore([member(2)]), {}, { botDir: tmpBotDir() }, log);
  assert.match(await h.handleDelayAll([]), /Format: delayall/);
  assert.match(await h.handleDelayAll(['abc']), /must be a number/);

  const empty = createMemberHandlers(fakeStore([]), {}, { botDir: tmpBotDir() }, log);
  assert.match(await empty.handleDelayAll(['7']), /Nobody is overdue/);
});

// ── catchup ──────────────────────────────────────────────────────────────────

test('catchup refuses to run outside group reminder mode', async () => {
  const botDir = tmpBotDir();
  const cfg = { ...baseConfig(botDir), reminder: { mode: 'dm' } };
  const e = createCatchupEngine(cfg, log, () => ({ user: {} }), fakeStore([member(3)]));
  assert.match(await e.preview(8), /group reminder mode only/);
  assert.match(await e.start(8), /group reminder mode only/);
});

test('catchup preview writes nothing and no state file appears', async () => {
  const botDir = tmpBotDir();
  const store = fakeStore([member(3), member(6)]);
  const e = createCatchupEngine(baseConfig(botDir), log, () => ({ user: {} }), store);

  const out = await e.preview(8);
  assert.match(out, /CATCHUP PREVIEW — 2 member/);
  assert.match(out, /catchup 8 confirm/);
  assert.equal(store.writes.length, 0);
  assert.equal(fs.existsSync(path.join(botDir, 'catchup-state.json')), false);
});

test('catchup start: applies grace, freezes the cohort, and sends stage 1 with the QR', async () => {
  const botDir = tmpBotDir();
  fs.writeFileSync(path.join(botDir, 'qr.jpg'), 'FAKEQR');
  const rows = [member(3), member(6)];
  const store = fakeStore(rows);
  const sent = [];
  const sock = {
    user: {},
    groupMetadata: async () => ({ participants: [{ id: '919000000003@s.whatsapp.net' }] }),
    sendMessage: async (jid, msg) => { sent.push({ jid, msg }); },
  };
  const cfg = { ...baseConfig(botDir), upiQrPath: './qr.jpg' };
  const e = createCatchupEngine(cfg, log, () => sock, store);

  const reply = await e.start(8);
  assert.match(reply, /Catch-up armed for 2 member/);
  assert.match(reply, /Now {2}→ payment reminder/, 'no start hour = fires immediately');

  // Grace applied to both, billing untouched.
  assert.equal(store.writes.length, 2);
  for (const w of store.writes) {
    assert.deepEqual(Object.keys(w.updates), ['delayUntil']);
    assert.equal(w.updates.delayUntil, dayOffset(e.GRACE_DAYS));
  }

  // start() fires stage 0 in the background — let the microtask queue drain.
  await new Promise(r => setImmediate(r));

  assert.equal(sent.length, 1, 'exactly one group message');
  assert.equal(sent[0].jid, 'g1@g.us');
  assert.ok(sent[0].msg.image, 'stage 1 carries the QR image');
  assert.match(sent[0].msg.caption, /^REMIND /);
  assert.ok(sent[0].msg.caption.includes('@919000000003'), 'in-group member is tagged');

  const state = JSON.parse(fs.readFileSync(path.join(botDir, 'catchup-state.json'), 'utf8'));
  assert.equal(state.stage, 1, 'advanced to stage 2');
  assert.equal(state.cohort.length, 2, 'cohort frozen at start');
  assert.ok(state.nextRunAt, 'next slot persisted so a restart cannot fire it early');

  e.stop();
});

test('catchup: a member who pays drops out of the next stage', async () => {
  const botDir = tmpBotDir();
  const rows = [member(3), member(6)];
  const store = fakeStore(rows);
  const sent = [];
  const sock = {
    user: {},
    groupMetadata: async () => ({ participants: [] }),
    sendMessage: async (jid, msg) => { sent.push(msg); },
  };
  const e = createCatchupEngine(baseConfig(botDir), log, () => sock, store);

  await e.start(8);
  await new Promise(r => setImmediate(r));
  assert.equal(sent.length, 1);

  // M3 pays: `renewed` pushes their billing date into the future.
  const paid = store.findByPhone('9000000003');
  paid.billingDate = dayOffset(27);

  await e.runStage();
  assert.equal(sent.length, 2, 'stage 2 sent');
  assert.match(sent[1].text, /^OVERDUE /);
  assert.ok(!sent[1].text.includes('M3'), 'payer dropped out');
  assert.ok(sent[1].text.includes('M6'), 'still-unpaid member remains');

  e.stop();
});

test('catchup: three stages then self-cleanup, final stage uses groupFinal', async () => {
  const botDir = tmpBotDir();
  const store = fakeStore([member(4)]);
  const sent = [];
  const sock = {
    user: {},
    groupMetadata: async () => ({ participants: [] }),
    sendMessage: async (jid, msg) => { sent.push(msg); },
  };
  const e = createCatchupEngine(baseConfig(botDir), log, () => sock, store);

  await e.start(8);
  await new Promise(r => setImmediate(r));
  await e.runStage();
  await e.runStage();

  assert.equal(sent.length, 3);
  assert.match(sent[0].text || sent[0].caption, /^REMIND /);
  assert.match(sent[1].text, /^OVERDUE /);
  assert.match(sent[2].text, /^FINAL /);
  assert.equal(fs.existsSync(path.join(botDir, 'catchup-state.json')), false, 'state cleaned up on completion');

  // A fourth call is a no-op, not a fourth message.
  await e.runStage();
  assert.equal(sent.length, 3);
});

test('catchup: groupFinal falls back to groupOverdue when unconfigured', async () => {
  const botDir = tmpBotDir();
  const cfg = baseConfig(botDir);
  delete cfg.messages.groupFinal;
  const store = fakeStore([member(4)]);
  const sent = [];
  const sock = {
    user: {},
    groupMetadata: async () => ({ participants: [] }),
    sendMessage: async (jid, msg) => { sent.push(msg); },
  };
  const e = createCatchupEngine(cfg, log, () => sock, store);

  await e.start(8);
  await new Promise(r => setImmediate(r));
  await e.runStage();
  await e.runStage();

  assert.match(sent[2].text, /^OVERDUE /, 'last stage still sends rather than failing');
});

test('catchup: second start is refused while a cycle is running, stop clears it', async () => {
  const botDir = tmpBotDir();
  const store = fakeStore([member(3)]);
  const sock = {
    user: {},
    groupMetadata: async () => ({ participants: [] }),
    sendMessage: async () => {},
  };
  const e = createCatchupEngine(baseConfig(botDir), log, () => sock, store);

  await e.start(8);
  assert.match(await e.start(8), /already running/);
  assert.match(await e.preview(8), /already running/);
  assert.match(e.status(), /CATCH-UP IN PROGRESS/);

  assert.match(e.stop(), /cancelled/);
  assert.equal(fs.existsSync(path.join(botDir, 'catchup-state.json')), false);
  assert.match(e.status(), /No catch-up cycle running/);
});

test('catchup: empty cohort is reported, nothing is written or scheduled', async () => {
  const botDir = tmpBotDir();
  const store = fakeStore([{ name: 'OK', phone: '9000000095', billingDate: dayOffset(10), status: 'ACTIVE' }]);
  const e = createCatchupEngine(baseConfig(botDir), log, () => ({ user: {} }), store);

  assert.match(await e.start(8), /nothing to catch up on/);
  assert.equal(store.writes.length, 0);
  assert.equal(fs.existsSync(path.join(botDir, 'catchup-state.json')), false);
});

// A deferred start is the whole point of running this at midnight: the grace has to land
// NOW so the 6:30 digest skips the cohort, but the group message must wait for a civil hour.
test('catchup with a start hour applies grace immediately but sends nothing yet', async () => {
  const botDir = tmpBotDir();
  const store = fakeStore([member(3), member(6)]);
  const sent = [];
  const sock = {
    user: {},
    groupMetadata: async () => ({ participants: [] }),
    sendMessage: async (jid, msg) => { sent.push(msg); },
  };
  const e = createCatchupEngine(baseConfig(botDir), log, () => sock, store);

  const reply = await e.start(8, 9);
  await new Promise(r => setImmediate(r));

  assert.equal(sent.length, 0, 'nothing sent at arm time');
  assert.equal(store.writes.length, 2, 'grace applied to both immediately');
  for (const w of store.writes) {
    assert.deepEqual(Object.keys(w.updates), ['delayUntil']);
  }
  assert.match(reply, /ALREADY hidden from the daily overdue message/);
  assert.ok(!/ {2}Now {2}→/.test(reply), 'reply names the scheduled hour, not "Now"');

  const state = JSON.parse(fs.readFileSync(path.join(botDir, 'catchup-state.json'), 'utf8'));
  assert.equal(state.stage, 0, 'still on stage 1 — it has not run');
  assert.equal(state.startHour, 9);
  const slot = new Date(state.nextRunAt);
  assert.equal(slot.getHours(), 9, 'scheduled for 9 AM local');
  assert.ok(slot.getTime() > Date.now(), 'in the future');

  e.stop();
});

test('catchup start hour: grace is counted from the first message day, not the arm time', async () => {
  const botDir = tmpBotDir();
  const store = fakeStore([member(3)]);
  const sock = { user: {}, groupMetadata: async () => ({ participants: [] }), sendMessage: async () => {} };
  const e = createCatchupEngine(baseConfig(botDir), log, () => sock, store);

  await e.start(8, 9);
  const state = JSON.parse(fs.readFileSync(path.join(botDir, 'catchup-state.json'), 'utf8'));
  const firstSlot = new Date(state.nextRunAt);
  const expected = new Date(firstSlot);
  expected.setHours(0, 0, 0, 0);
  expected.setDate(expected.getDate() + e.GRACE_DAYS);
  assert.equal(state.delayUntil, formatDate(expected),
    'the last stage must still land inside the grace window');

  e.stop();
});

test('catchup: a stage with the socket down does not consume the stage', async () => {
  const botDir = tmpBotDir();
  const store = fakeStore([member(3)]);
  let sock = { user: {}, groupMetadata: async () => ({ participants: [] }), sendMessage: async () => {} };
  const e = createCatchupEngine(baseConfig(botDir), log, () => sock, store);

  await e.start(8);
  await new Promise(r => setImmediate(r));

  sock = null;                       // connection drops before stage 2
  await e.runStage();

  const state = JSON.parse(fs.readFileSync(path.join(botDir, 'catchup-state.json'), 'utf8'));
  assert.equal(state.stage, 1, 'still on stage 2 — will retry, not skip');

  e.stop();
});
