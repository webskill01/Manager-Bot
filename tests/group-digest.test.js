import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildGroupDigest, createReminderSender } from '../core/reminderSender.js';
import { createRemovalEngine } from '../core/removalEngine.js';
import { computeJitterMs } from '../core/scheduler.js';
import { formatDate } from '../core/globalConfig.js';

const log = { info() {}, warn() {}, error() {} };

test('buildGroupDigest tags group members (PN and LID) and mentions match the tag JIDs', () => {
  const participants = [
    { id: '919000000001@s.whatsapp.net' },                                      // classic PN participant
    { id: '123456789012345@lid', phoneNumber: '919000000002@s.whatsapp.net' }, // LID-era participant
  ];
  const members = [
    { name: 'A', phone: '9000000001', note: '' },
    { name: 'B', phone: '9000000002', note: '— 5 din overdue' },
    { name: 'C', phone: '9000000003' },                                         // not in the group
  ];
  const { text, mentions } = buildGroupDigest({ header: 'HEAD', members, participants });

  assert.ok(text.startsWith('HEAD\n\n'));
  assert.ok(text.includes('@919000000001'), 'PN member tagged');
  assert.ok(text.includes('@123456789012345 — 5 din overdue'), 'LID member tagged via phoneNumber, note appended');
  assert.ok(text.includes('C (9000000003)'), 'non-member falls back to plain name line');
  assert.deepEqual(mentions, ['919000000001@s.whatsapp.net', '123456789012345@lid']);
});

test('computeJitterMs stays within bounds and 0 disables it', () => {
  assert.equal(computeJitterMs(0), 0);
  assert.equal(computeJitterMs(undefined), 0);
  for (let i = 0; i < 200; i++) {
    const ms = computeJitterMs(20);
    assert.ok(ms >= 0 && ms <= 20 * 60000, `jitter ${ms} within 0..20min`);
  }
});

test('remindall refuses outside group mode (dm mode and missing groupId)', async () => {
  const dm = createReminderSender({ reminder: { mode: 'dm' }, messages: {}, rateLimits: {} }, log);
  assert.match(await dm.remindAll(null, null, null, {}), /group reminder mode only/);

  const noGroup = createReminderSender({ reminder: { mode: 'group', groupId: '' }, messages: {}, rateLimits: {} }, log);
  assert.match(await noGroup.remindAll(null, null, null, {}), /group reminder mode only/);
});

test('group mode sends ONE tagged digest message and dedupes for the rest of the day', async () => {
  const botDir = fs.mkdtempSync(path.join(os.tmpdir(), 'digest-'));
  const config = {
    reminder: { mode: 'group', groupId: '111@g.us' },
    messages: { groupReminder: 'DUE {date}', groupOverdue: 'LATE {date}' },
    rateLimits: {},
    overdue: { autoReminderDays: 5 },
  };
  const dueToday = formatDate(new Date());
  const members = [
    { name: 'A', phone: '9000000001', status: 'ACTIVE', billingDate: dueToday, renewals: 0 },
  ];
  const store = {
    async refresh() {},
    getActive() { return members; },
    getAll() { return members.map(m => ({ ...m })); },
  };
  const sent = [];
  const sock = {
    user: { id: 'bot' },
    async sendMessage(jid, msg) { sent.push({ jid, msg }); },
    async groupMetadata() { return { participants: [{ id: '919000000001@s.whatsapp.net' }] }; },
  };

  const rs = createReminderSender(config, log);
  const r1 = await rs.sendReminders(store, () => sock, botDir);
  assert.equal(sent.length, 1, 'exactly one group message (no overdue → msg 2 skipped, no sleep)');
  assert.equal(sent[0].jid, '111@g.us');
  assert.ok(sent[0].msg.text.includes('@919000000001'), 'due member tagged');
  assert.deepEqual(sent[0].msg.mentions, ['919000000001@s.whatsapp.net']);
  assert.equal(r1.sent, 1);

  // Batch 2 / catch-up path: everything already sent — must be a no-op.
  await rs.sendRemindersSecondBatch(store, () => sock, botDir);
  assert.equal(sent.length, 1, 'digest not re-sent same day');

  const state = JSON.parse(fs.readFileSync(path.join(botDir, 'reminder-state.json'), 'utf8'));
  assert.equal(state.digestSent, true);
  assert.equal(state.overdueDigestSent, true);
  assert.equal(state.renewFreeDigestSent, true, 'no auto-renews → msg 3 flagged done');
  assert.ok(state.sentPhones.includes('9000000001'));

  fs.rmSync(botDir, { recursive: true, force: true });
});

test('group mode: 2-ref member is auto-renewed silently and celebrated in msg 3, never tagged as due', async () => {
  const botDir = fs.mkdtempSync(path.join(os.tmpdir(), 'digest-'));
  const config = {
    reminder: { mode: 'group', groupId: '111@g.us', msgGapMinMs: 0, msgGapMaxMs: 0 },
    messages: { groupReminder: 'DUE {date}', groupOverdue: 'LATE {date}', groupAutoRenewed: 'FREE MONTH:' },
    rateLimits: {},
    overdue: { autoReminderDays: 5 },
  };
  const dueToday = formatDate(new Date());
  const recentJoin = formatDate(new Date(Date.now() - 10 * 86400000)); // inside the billing window
  const members = [
    // Referrer due today with two referred members joined this billing period → free month.
    { name: 'Star', phone: '9000000001', status: 'ACTIVE', billingDate: dueToday, renewals: 0 },
    { name: 'R1', phone: '9000000011', status: 'ACTIVE', billingDate: dueToday, reference: '9000000001', joinDate: recentJoin, renewals: 0 },
    { name: 'R2', phone: '9000000012', status: 'ACTIVE', billingDate: dueToday, reference: '9000000001', joinDate: recentJoin, renewals: 0 },
  ];
  // R1/R2 are also due today with 0 refs — they'll be tagged in msg 1; Star must not be.
  const store = {
    async refresh() {},
    getActive() { return members.filter(m => m.status === 'ACTIVE'); },
    getAll() { return members.map(m => ({ ...m })); },
    async update(phone, fields) {
      const m = members.find(x => x.phone === phone);
      Object.assign(m, fields);
    },
  };
  const sent = [];
  const sock = {
    user: { id: 'bot' },
    async sendMessage(jid, msg) { sent.push({ jid, msg }); },
    async groupMetadata() {
      return { participants: members.map(m => ({ id: `91${m.phone}@s.whatsapp.net` })) };
    },
  };

  const rs = createReminderSender(config, log);
  const r = await rs.sendReminders(store, () => sock, botDir);

  assert.equal(r.autoRenewed.length, 1, 'Star auto-renewed');
  assert.equal(sent.length, 2, 'msg 1 (due) + msg 3 (celebration); no overdue → msg 2 skipped');

  const msg1 = sent[0].msg;
  assert.ok(!msg1.text.includes('919000000001'), 'auto-renewed Star NOT tagged as due');
  assert.ok(msg1.text.includes('@919000000011') && msg1.text.includes('@919000000012'), 'referred members tagged as due');
  assert.ok(!msg1.text.includes('referral'), 'no referral annotation in group mode');

  const msg3 = sent[1].msg;
  assert.ok(msg3.text.startsWith('FREE MONTH:'), 'celebration header used');
  assert.ok(msg3.text.includes('@919000000001'), 'Star tagged in celebration');
  assert.deepEqual(msg3.mentions, ['919000000001@s.whatsapp.net']);

  const state = JSON.parse(fs.readFileSync(path.join(botDir, 'reminder-state.json'), 'utf8'));
  assert.equal(state.renewFreeDigestSent, true);
  assert.deepEqual(state.autoRenewedToday.map(a => a.phone), ['9000000001']);

  fs.rmSync(botDir, { recursive: true, force: true });
});

test('warnall replies instantly and delivers spaced warnings in the background + admin summary', async () => {
  const botDir = fs.mkdtempSync(path.join(os.tmpdir(), 'warn-'));
  const overdueDate = formatDate(new Date(Date.now() - 8 * 86400000)); // 8 days overdue
  const members = [
    { name: 'A', phone: '9000000001', status: 'ACTIVE', billingDate: overdueDate, renewals: 0 },
    { name: 'B', phone: '9000000002', status: 'ACTIVE', billingDate: overdueDate, renewals: 0 },
  ];
  const store = { getAll() { return members.map(m => ({ ...m })); } };
  const sent = [];
  const sock = { user: { id: 'bot' }, async sendMessage(jid, msg) { sent.push({ jid, msg }); } };
  const config = {
    botDir,
    overdue: { consolidatedListDays: 7 },
    messages: { overdue: 'warn {name} {days}' },
    rateLimits: { dmReminderGapMinMs: 0, dmReminderGapMaxMs: 0, memberToMemberGapMinMs: 0, memberToMemberGapMaxMs: 0 },
  };
  const engine = createRemovalEngine(config, log, () => sock, store, () => ['admin@s.whatsapp.net']);

  const reply = engine.warnall();
  assert.match(reply, /Sending final warnings to 2 members/, 'instant reply, batch runs in background');

  // Background batch with 0ms gaps finishes almost immediately — poll briefly.
  for (let i = 0; i < 50 && sent.length < 3; i++) await new Promise(r => setTimeout(r, 20));
  const memberSends = sent.filter(s => s.jid.endsWith('@s.whatsapp.net') && s.jid.startsWith('91'));
  assert.equal(memberSends.length, 2, 'both overdue members warned');
  const summary = sent.find(s => s.jid === 'admin@s.whatsapp.net');
  assert.ok(summary && /warnall done: 2\/2/.test(summary.msg.text), 'completion summary broadcast to admins');

  fs.rmSync(botDir, { recursive: true, force: true });
});

test('group mode with missing groupId falls back to the DM path (no crash)', async () => {
  const botDir = fs.mkdtempSync(path.join(os.tmpdir(), 'digest-'));
  const config = {
    reminder: { mode: 'group', groupId: '' },
    messages: { reminder: 'pay {name}' },
    rateLimits: { memberToMemberGapMinMs: 0, memberToMemberGapMaxMs: 0, batchSize: 20 },
  };
  const store = { async refresh() {}, getActive() { return []; }, getAll() { return []; } };
  const rs = createReminderSender(config, log);
  const r = await rs.sendReminders(store, () => ({ user: { id: 'bot' } }), botDir);
  assert.equal(r.sent, 0, 'DM path ran (no members due) without touching group logic');
  fs.rmSync(botDir, { recursive: true, force: true });
});
