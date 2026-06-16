import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createOverdueEngine } from '../core/overdueEngine.js';
import { formatDate } from '../core/globalConfig.js';

const log = { info() {}, warn() {}, error() {} };

function makeConfig(botDir) {
  return {
    botDir,
    overdue: { autoReminderDays: 5, consolidatedListDays: 7 },
    rateLimits: { memberToMemberGapMinMs: 0, memberToMemberGapMaxMs: 0 },
    messages: {
      overdue: 'overdue {name} {days}',
      finalReminder: 'final {name}',
      overdueConsolidated: 'LIST {count}\n{list}',
    },
  };
}

function makeStore(initial) {
  const members = initial.map(m => ({ ...m }));
  return {
    async refresh() {},
    getActive() { return members.filter(m => m.status === 'ACTIVE'); },
    getAll() { return members.map(m => ({ ...m })); },
  };
}

function makeSock() {
  const sent = [];
  return { sock: { user: { id: 'bot' }, async sendMessage(jid, msg) { sent.push({ jid, msg }); } }, sent };
}

// billing date N days in the past → N days overdue
function daysAgo(n) {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return formatDate(d);
}

test('overdue check is idempotent — re-running never double-messages members or the owner', async () => {
  const botDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ovr-'));
  const store = makeStore([
    // Exactly 7 days overdue → gets a day-7 FINAL reminder AND appears in the consolidated list.
    { name: 'A', phone: '9000000001', status: 'ACTIVE', billingDate: daysAgo(7), renewals: 0 },
    // 5 days overdue → gets a day-6 (autoReminderDays) reminder.
    { name: 'B', phone: '9000000002', status: 'ACTIVE', billingDate: daysAgo(5), renewals: 0 },
  ]);
  const { sock, sent } = makeSock();
  const broadcastJids = ['owner@s.whatsapp.net'];
  const engine = createOverdueEngine(makeConfig(botDir), log);

  // First run: A final reminder + B day-6 reminder + 1 consolidated list to the owner = 3 sends.
  await engine.runOverdueCheck(store, () => sock, broadcastJids);
  assert.equal(sent.length, 3, 'first run sends both member reminders and one owner list');

  // Second run (e.g. a reconnect catch-up later the same day) must send nothing new.
  await engine.runOverdueCheck(store, () => sock, broadcastJids);
  assert.equal(sent.length, 3, 'second run is a no-op — state.json dedupes everything');

  // State file should record the day handled.
  const state = JSON.parse(fs.readFileSync(path.join(botDir, 'overdue-state.json'), 'utf8'));
  assert.equal(state.done, true);
  assert.equal(state.listSent, true);
  assert.equal(state.sentPhones.length, 2);

  fs.rmSync(botDir, { recursive: true, force: true });
});

test('overdue check resumes a run interrupted mid-way without re-sending the first member', async () => {
  const botDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ovr-'));
  const store = makeStore([
    { name: 'A', phone: '9000000001', status: 'ACTIVE', billingDate: daysAgo(7), renewals: 0 },
    { name: 'B', phone: '9000000002', status: 'ACTIVE', billingDate: daysAgo(7), renewals: 0 },
  ]);
  const broadcastJids = ['owner@s.whatsapp.net'];
  const engine = createOverdueEngine(makeConfig(botDir), log);

  // Simulate the socket dying after the first member is messaged: throw on the 2nd send.
  let calls = 0;
  const sent = [];
  const flakySock = {
    user: { id: 'bot' },
    async sendMessage(jid, msg) {
      calls++;
      if (calls === 2) throw new Error('socket dropped');
      sent.push({ jid, msg });
    },
  };
  await engine.runOverdueCheck(store, () => flakySock, broadcastJids);
  // A delivered; B failed; consolidated list also failed (still calls===... ) — partial run.
  const partial = JSON.parse(fs.readFileSync(path.join(botDir, 'overdue-state.json'), 'utf8'));
  assert.ok(partial.sentPhones.includes('9000000001'), 'A recorded as sent');
  assert.ok(!partial.sentPhones.includes('9000000002'), 'B not recorded — its send threw');

  // Reconnect: a healthy socket re-runs. A must be skipped, B delivered.
  const { sock: goodSock, sent: sent2 } = makeSock();
  await engine.runOverdueCheck(store, () => goodSock, broadcastJids);
  const phonesMessaged = sent2.filter(s => s.jid.startsWith('91')).map(s => s.jid);
  assert.ok(phonesMessaged.some(j => j.includes('9000000002')), 'B is delivered on resume');
  assert.ok(!phonesMessaged.some(j => j.includes('9000000001')), 'A is NOT re-messaged');

  fs.rmSync(botDir, { recursive: true, force: true });
});
