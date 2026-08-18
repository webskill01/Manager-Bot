// Regression guard for the 2026-07-27 ban fix: NO cron job may DM anyone, and group
// reminder mode must actually mean zero member DMs. A freshly linked number was banned
// the morning after warm-up expired because its first-ever action was the 6 AM digest
// DMing three admins, and because the day-6 "final" reminder still went out as a DM even
// in group mode. If these tests fail, that ban path has been reopened.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createScheduler } from '../core/scheduler.js';
import { createOverdueEngine } from '../core/overdueEngine.js';
import { createReportHandlers } from '../core/handlers/reportHandlers.js';
import { formatDate } from '../core/globalConfig.js';

function capturingLog() {
  const lines = [];
  return { lines, info(m) { lines.push(m); }, warn(m) { lines.push(m); }, error(m) { lines.push(m); } };
}

function daysAgo(n) {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return formatDate(d);
}

function makeStore(initial) {
  const members = initial.map(m => ({ ...m }));
  let refreshes = 0;
  return {
    get refreshes() { return refreshes; },
    async refresh() { refreshes++; },
    getActive() { return members.filter(m => m.status === 'ACTIVE'); },
    getAll() { return members.map(m => ({ ...m })); },
  };
}

const overdueConfig = (botDir, extra = {}) => ({
  botDir,
  overdue: { autoReminderDays: 5, consolidatedListDays: 7 },
  rateLimits: { memberToMemberGapMinMs: 0, memberToMemberGapMaxMs: 0 },
  messages: {
    overdue: 'overdue {name} {days}',
    finalReminder: 'final {name}',
    groupOverdue: 'GROUP OVERDUE',
    groupFinal: 'GROUP FINAL',
    overdueConsolidated: 'LIST {count}\n{list}',
  },
  ...extra,
});

// ── scheduler ────────────────────────────────────────────────────────────────

// SUPERSEDES the July 2026 rule that the digests could never be scheduled at all.
//
// Back then this test passed digest TASKS and asserted no digest JOB was created, because
// the only delivery available was broadcast(), which writes to the WhatsApp socket. The
// digests are now allowed — but only over Telegram, and index.js expresses that by passing
// the tasks solely when config.usesTelegram is true.
//
// So the property worth pinning moved: it is no longer "digests never register", it is
// "no task in, no job out". A bot with no Telegram listener passes no digest task and
// therefore still schedules nothing that could reach WhatsApp. That is the case below.
test('a bot with no Telegram listener schedules no digest and no drip', () => {
  const log = capturingLog();
  const scheduler = createScheduler({
    schedule: {
      morningDigest: '0 6 * * *',
      reminderSend: '30 6 * * *',
      reminderSend2: '30 7 * * *',
      overdueCheck: '0 10 * * *',
      eveningSummary: '0 22 * * *',
      timezone: 'Asia/Kolkata',
    },
  }, log);

  const called = [];
  // Exactly what index.js passes when config.usesTelegram is false: the three renewal
  // jobs and nothing else. The digest cron keys are still present in config and must
  // stay inert on their own.
  scheduler.start({
    reminderSend: () => called.push('reminderSend'),
    reminderSend2: () => called.push('reminderSend2'),
    overdueCheck: () => called.push('overdueCheck'),
  });

  const scheduled = log.lines.filter(l => l.startsWith('⏰ Scheduled'));
  assert.equal(scheduled.length, 3, 'exactly three cron jobs');
  assert.ok(log.lines.some(l => l.includes('3 jobs active')));
  assert.ok(!scheduled.some(l => l.includes('morning-digest')), 'morning digest must NOT be scheduled');
  assert.ok(!scheduled.some(l => l.includes('evening-summary')), 'evening summary must NOT be scheduled');
  assert.ok(!scheduled.some(l => l.includes('drip-arm')), 'drip must NOT be scheduled');
  assert.deepEqual(
    scheduled.map(l => l.match(/Scheduled (\S+)/)[1]).sort(),
    ['overdue-check', 'reminder-send', 'reminder-send-2'],
  );

  // Present-but-inert config keys must not resurrect the jobs.
  assert.equal(called.length, 0, 'nothing fires at registration time');
  scheduler.stop();
});

test('scheduler survives a config with the digest keys absent entirely', () => {
  const log = capturingLog();
  const scheduler = createScheduler({
    schedule: { reminderSend: '30 6 * * *', overdueCheck: '0 10 * * *' },
  }, log);
  scheduler.start({ reminderSend: () => {}, overdueCheck: () => {} });
  assert.ok(log.lines.some(l => l.includes('2 jobs active')));
  scheduler.stop();
});

// ── day-6 final reminder ─────────────────────────────────────────────────────

test('group mode: the day-6 FINAL reminder goes to the GROUP — zero member DMs', async () => {
  const botDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nodm-'));
  const store = makeStore([
    { name: 'A', phone: '9000000001', status: 'ACTIVE', billingDate: daysAgo(6), renewals: 0 },
    { name: 'B', phone: '9000000002', status: 'ACTIVE', billingDate: daysAgo(6), renewals: 0 },
  ]);
  const sent = [];
  const sock = {
    user: { id: 'bot' },
    async groupMetadata() { return { participants: [{ id: '919000000001@s.whatsapp.net' }] }; },
    async sendMessage(jid, msg) { sent.push({ jid, msg }); },
  };
  const config = overdueConfig(botDir, { reminder: { mode: 'group', groupId: 'g1@g.us' } });
  const engine = createOverdueEngine(config, log0());

  await engine.runOverdueCheck(store, () => sock, ['owner@s.whatsapp.net']);

  const memberDms = sent.filter(s => /^91900000000[12]@s\.whatsapp\.net$/.test(s.jid));
  assert.equal(memberDms.length, 0, 'no member may receive a DM in group mode');

  const groupMsgs = sent.filter(s => s.jid === 'g1@g.us');
  assert.equal(groupMsgs.length, 1, 'one tagged group message for both members');
  assert.match(groupMsgs[0].msg.text, /^GROUP FINAL/);
  assert.ok(groupMsgs[0].msg.text.includes('@919000000001'), 'in-group member tagged');
  assert.ok(groupMsgs[0].msg.text.includes('B (9000000002)'), 'member not in group falls back to a plain line');

  // Re-running the same day must not repeat the group message.
  await engine.runOverdueCheck(store, () => sock, ['owner@s.whatsapp.net']);
  assert.equal(sent.filter(s => s.jid === 'g1@g.us').length, 1, 'idempotent');

  fs.rmSync(botDir, { recursive: true, force: true });
});

test('group mode: groupFinal falls back to groupOverdue when unconfigured', async () => {
  const botDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nodm-'));
  const store = makeStore([
    { name: 'A', phone: '9000000001', status: 'ACTIVE', billingDate: daysAgo(6), renewals: 0 },
  ]);
  const sent = [];
  const sock = {
    user: { id: 'bot' },
    async groupMetadata() { return { participants: [] }; },
    async sendMessage(jid, msg) { sent.push({ jid, msg }); },
  };
  const config = overdueConfig(botDir, { reminder: { mode: 'group', groupId: 'g1@g.us' } });
  delete config.messages.groupFinal;
  const engine = createOverdueEngine(config, log0());

  await engine.runOverdueCheck(store, () => sock, ['owner@s.whatsapp.net']);
  const groupMsgs = sent.filter(s => s.jid === 'g1@g.us');
  assert.equal(groupMsgs.length, 1, 'still sends rather than failing the last-chance message');
  assert.match(groupMsgs[0].msg.text, /^GROUP OVERDUE/);

  fs.rmSync(botDir, { recursive: true, force: true });
});

test('dm mode is unchanged — the final reminder is still a personal DM', async () => {
  const botDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nodm-'));
  const store = makeStore([
    { name: 'A', phone: '9000000001', status: 'ACTIVE', billingDate: daysAgo(6), renewals: 0 },
  ]);
  const sent = [];
  const sock = { user: { id: 'bot' }, async sendMessage(jid, msg) { sent.push({ jid, msg }); } };
  const engine = createOverdueEngine(overdueConfig(botDir, { reminder: { mode: 'dm' } }), log0());

  await engine.runOverdueCheck(store, () => sock, ['owner@s.whatsapp.net']);
  assert.ok(sent.some(s => s.jid === '919000000001@s.whatsapp.net' && s.msg.text === 'final A'));

  fs.rmSync(botDir, { recursive: true, force: true });
});

// ── digest as a command ──────────────────────────────────────────────────────

test('digest command refreshes the sheet and reports auto-renewals from state', async () => {
  const botDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nodm-'));
  fs.writeFileSync(
    path.join(botDir, 'reminder-state.json'),
    JSON.stringify({ autoRenewedToday: [{ name: 'Free1', phone: '9000000009' }] }),
  );
  const store = makeStore([
    { name: 'A', phone: '9000000001', status: 'ACTIVE', billingDate: daysAgo(6), renewals: 0, paidLast: 90 },
  ]);
  const config = {
    botDir,
    overdue: { autoReminderDays: 5, consolidatedListDays: 7 },
    renewal: { fullAmount: 90, referralAmount: 45 },
    joining: { fee: 90 },
  };
  const reportH = createReportHandlers(store, config, Date.now(), log0());

  const out = await reportH.handleMorningDigest();
  assert.equal(store.refreshes, 1, 'a pulled digest must read the live sheet, not a stale cache');
  assert.match(out, /Morning Digest/);
  assert.match(out, /AUTO-RENEWED TODAY \(2 refs → free\): 1/);
  assert.match(out, /Free1/);

  fs.rmSync(botDir, { recursive: true, force: true });
});

test('digest command survives a missing reminder-state.json', async () => {
  const botDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nodm-'));
  const store = makeStore([]);
  const reportH = createReportHandlers(
    store,
    { botDir, overdue: { autoReminderDays: 5 }, renewal: { fullAmount: 90, referralAmount: 45 }, joining: { fee: 90 } },
    Date.now(),
    log0(),
  );
  const out = await reportH.handleMorningDigest();
  assert.match(out, /Morning Digest/);
  assert.ok(!out.includes('AUTO-RENEWED'));
  fs.rmSync(botDir, { recursive: true, force: true });
});

function log0() {
  return { info() {}, warn() {}, error() {} };
}
